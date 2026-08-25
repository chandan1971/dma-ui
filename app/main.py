"""FastAPI application: serves the trading UI, proxies signed DMA calls, and
streams a live positions/orders/PnL feed over a WebSocket.

Security model:
  * API key/secret live only in the backend (env vars) and are used to sign
    every upstream request. The browser never sees them.
  * Two login roles: 'admin' may trade; 'viewer' is read-only.
  * Every write endpoint requires BOTH the admin role AND a valid per-request
    trade token (the X-Trade-Token header), checked against TRADE_TOKEN.
    Writes are fail-closed: no token configured -> no writes possible.
"""
import asyncio
import json
import logging
import math
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from decimal import Decimal, InvalidOperation, ROUND_FLOOR
from urllib.parse import urlparse

from fastapi import (
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from bson.errors import BSONError
from pathlib import Path
from pymongo.errors import PyMongoError
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response as StarletteResponse

from . import (
    ai_context,
    ai_providers,
    ai_service,
    auth,
    db,
    dma_client,
    history_sync,
    journal,
    market_data,
    notifier,
    scanner,
    signer,
)
from .config import settings

def _configure_logging() -> None:
    """Route normal logs to stdout and only warnings/errors to stderr.

    Railway tags ANYTHING on stderr as level=error and colors it red. By
    default uvicorn and httpx log INFO to stderr, so successful 200s and
    startup messages show up as scary red "errors". This sends INFO->stdout
    (normal) and WARNING+->stderr (genuinely red so real problems stand out),
    and silences httpx's per-request chatter (3 lines every poll).
    """
    fmt = logging.Formatter("%(levelname)s %(name)s: %(message)s")

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(fmt)
    stdout_handler.addFilter(lambda record: record.levelno < logging.WARNING)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(fmt)
    stderr_handler.setLevel(logging.WARNING)

    root = logging.getLogger()
    root.handlers = [stdout_handler, stderr_handler]
    root.setLevel(logging.INFO)

    # uvicorn installs its own stderr handlers; clear them and let records flow
    # to our root handlers so they're split by level (stdout vs stderr) too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True

    # httpx logs every upstream request at INFO — pure noise. Keep warnings+.
    logging.getLogger("httpx").setLevel(logging.WARNING)


_configure_logging()
logger = logging.getLogger("dma-ui")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # MongoDB (history store): verify connectivity and indexes as a BACKGROUND
    # task so a down/slow Mongo can never delay serving the trading routes.
    # History endpoints return 503 until it recovers; missing CONFIG still
    # fails fast at import, and the sync scheduler re-runs ensure_indexes
    # before each run so a failed boot-time attempt self-heals.
    async def _init_db() -> None:
        try:
            await db.ping()
            await db.ensure_indexes()
            logger.info("mongo connected db=%s", settings.MONGO_DB_NAME)
        except Exception:
            logger.exception(
                "mongo unavailable at startup — history reads/sync degraded until it recovers"
            )

    db_init = asyncio.create_task(_init_db())
    # Background execution-alert watcher (Telegram). Runs for the app's lifetime,
    # independent of any browser; a no-op if alerts aren't configured.
    watcher = asyncio.create_task(notifier.run_watcher())
    # Background history sync: the ONLY place the exchange's trade/closed-PnL
    # history is fetched from; the dashboard reads MongoDB.
    syncer = asyncio.create_task(history_sync.run_scheduler())
    # Background market-scanner sampler: ONE shared ticker poll per interval
    # feeds /api/scanner for every viewer (read-only; no-op when disabled).
    scanner_task = asyncio.create_task(scanner.run_sampler())
    try:
        yield
    finally:
        # The WS broadcaster is started lazily on the first client (so tests and
        # idle deploys never spin it); include it here if it is running.
        tasks = [db_init, watcher, syncer, scanner_task]
        if _ws_broadcast_task is not None:
            tasks.append(_ws_broadcast_task)
        for task in tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Cleanly close the shared upstream HTTP clients and the DB client.
        await dma_client.aclose()
        await market_data.aclose()
        await notifier.aclose()
        await ai_providers.aclose()
        await db.aclose()


app = FastAPI(title="DMA Trading UI", lifespan=lifespan)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Fail fast: refuse to start if any required secret is missing. Critically,
# an empty SESSION_SECRET would let itsdangerous sign cookies with a known
# empty key, allowing anyone to forge an admin session. Better to crash the
# deploy loudly than to serve a forgeable, real-money app.
_missing_env = settings.missing_required()
if _missing_env:
    raise RuntimeError(
        "Refusing to start — missing required environment variables: "
        + ", ".join(_missing_env)
    )

# Refuse to boot on placeholder/weak secrets (e.g. a verbatim .env.example): a
# known SESSION_SECRET lets anyone forge an admin cookie, and a guessable
# password/trade token is a direct path to the money controls.
_insecure_env = settings.insecure_required()
if _insecure_env:
    raise RuntimeError("Refusing to start — insecure configuration: " + "; ".join(_insecure_env))

# A malformed signing key must fail the deploy, not the first live trade.
if not signer.secret_is_valid_ed25519_hex(settings.DMA_API_SECRET):
    raise RuntimeError("Refusing to start — DMA_API_SECRET is not a valid Ed25519 hex key")

# Misconfigured Mongo TLS would fail every connection at runtime with a much
# murkier error — fail the deploy instead. Exactly one of PATH (a PEM-encoded
# file on disk, .pem/.crt alike; never committed — see .gitignore) or CONTENT
# (pasted PEM text, for hosts like Railway with no file on disk) may be set.
if settings.MONGO_TLS_CA_FILE and settings.MONGO_TLS_CA_PEM:
    raise RuntimeError(
        "Refusing to start — set only ONE of MONGO_TLS_CA_FILE / MONGO_TLS_CA_PEM"
    )
if settings.MONGO_TLS_CA_FILE and not Path(settings.MONGO_TLS_CA_FILE).is_file():
    raise RuntimeError(
        "Refusing to start — MONGO_TLS_CA_FILE points to a missing file: "
        + settings.MONGO_TLS_CA_FILE
    )
if settings.MONGO_TLS_CA_PEM and "-----BEGIN" not in settings.MONGO_TLS_CA_PEM:
    raise RuntimeError(
        "Refusing to start — MONGO_TLS_CA_PEM is set but does not look like PEM "
        "certificate content (expected '-----BEGIN CERTIFICATE-----'); did you "
        "paste a file PATH instead? Use MONGO_TLS_CA_FILE for paths."
    )

for _w in settings.warn_weak():
    logger.warning("config: %s", _w)

# Four subsystems assume EXACTLY ONE replica: in-memory sessions (per-role
# eviction), the in-process rate limiter, the history sync's single-flight
# lock, and the notifier's seen-fill dedup. A second replica silently degrades
# all four (split sessions, halved lockout, doubled sync load, duplicate
# Telegram alerts) — say so at every boot where an operator reads logs.
logger.info(
    "single-replica design: sessions, rate limiting, history sync and alert "
    "dedup are in-process — run exactly ONE replica of this service"
)


# --------------------------------------------------------------------------
# Request body size cap — every legitimate payload here (login, order, TP/SL,
# transfer) is under 1 KB, and FastAPI buffers bodies fully in memory, so an
# UNAUTHENTICATED multi-GB POST to /api/login is otherwise a memory-DoS on the
# single process that also runs the sync and alerts. Content-Length covers the
# practical attack; a chunked body without the header is not intercepted here
# (streaming caps need receive-wrapping complexity) — the platform edge is the
# backstop for that residual. Registered BEFORE security_headers so the 413
# still carries the security headers (later-registered middleware wraps this).
# --------------------------------------------------------------------------
_MAX_BODY_BYTES = 64 * 1024

# Compress large JSON responses (the scanner snapshot is a few hundred KB of
# highly repetitive JSON that gzips ~8×; history reads benefit too). Safe here:
# response bodies never mix secrets with attacker-reflected input (the classic
# BREACH precondition), and WebSocket frames are untouched by this middleware.
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def body_size_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > _MAX_BODY_BYTES:
                return JSONResponse(status_code=413, content={"error": "request body too large"})
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "invalid Content-Length"})
    return await call_next(request)


# --------------------------------------------------------------------------
# Security headers (defense-in-depth) — stamped on EVERY response.
#   * CSP + frame-ancestors 'none' / X-Frame-Options: DENY -> no clickjacking of
#     the authenticated real-money SPA (the X-Trade-Token CSRF defense does not
#     stop UI-redress framing).
#   * script-src 'self' -> a future escaping regression can't execute injected JS.
#     (All scripts are external files; style-src keeps 'unsafe-inline' for the
#     HTML's style="" attributes.)
# --------------------------------------------------------------------------
_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; object-src 'none'; form-action 'self'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = _CSP
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    return resp


# --------------------------------------------------------------------------
# Lightweight in-process rate limiting for the auth endpoints (single replica,
# so a module dict suffices). Counts only FAILED attempts and clears on success,
# so a legitimate operator typing the right secret is never locked out. Best-
# effort (resets on restart); an edge/CDN limiter is still recommended.
# --------------------------------------------------------------------------
_FAIL_WINDOW = 300.0  # seconds
_FAIL_MAX = 10        # failures per key per window before a 429

_auth_failures: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    """Best-effort real client IP for rate-limit bucketing.

    X-Forwarded-For is ``<client-supplied…>, <hop appended by proxy 1>, …`` — each
    trusted proxy APPENDS the address it saw, on the RIGHT. The leftmost value is
    fully client-controlled, so keying rate limits on it lets an attacker rotate a
    fake XFF per request and dodge the login / trade-token lockout. We instead take
    the hop `TRUSTED_PROXY_HOPS` from the right — the value our own proxy chain
    added, which the client cannot forge. Default 1 (Railway's single proxy); set
    TRUSTED_PROXY_HOPS=2 when an edge proxy (e.g. Cloudflare) sits in front, so all
    clients don't collapse into one shared bucket (a lockout-DoS). Falls back to the
    socket peer when no XFF is present.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        if hops:
            idx = len(hops) - settings.TRUSTED_PROXY_HOPS
            return hops[idx] if idx >= 0 else hops[0]
    return request.client.host if request.client else "unknown"


def _rate_limited(bucket_key: str) -> bool:
    now = time.monotonic()
    times = [t for t in _auth_failures.get(bucket_key, []) if now - t < _FAIL_WINDOW]
    if times:
        _auth_failures[bucket_key] = times
    else:
        # Drop fully-expired buckets: keeping an empty list per client IP would
        # let the dict grow one entry per unique visitor for the process lifetime.
        _auth_failures.pop(bucket_key, None)
    return len(times) >= _FAIL_MAX


def _record_failure(bucket_key: str) -> None:
    _auth_failures.setdefault(bucket_key, []).append(time.monotonic())


def _clear_failures(bucket_key: str) -> None:
    _auth_failures.pop(bucket_key, None)


# --------------------------------------------------------------------------
# Auth dependencies
# --------------------------------------------------------------------------
def current_user(request: Request) -> dict:
    token = request.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    # Enforce the single active session PER ROLE: a valid-but-superseded cookie
    # (an older tab/device after a newer same-role login) is rejected.
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("r") != auth.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


TRADE_TOKEN_HEADER = "X-Trade-Token"


def require_trade_token(request: Request, user: dict = Depends(require_admin)) -> dict:
    """Gate for ALL write operations.

    Requires (a) a valid admin session AND (b) a correct trade token supplied
    in the X-Trade-Token header on this specific request. Fail-closed: if the
    server has no TRADE_TOKEN configured, every write is rejected.

    The custom header also doubles as CSRF protection: a cross-site page cannot
    set custom headers without a CORS preflight that this server never grants.
    """
    if not settings.TRADE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Trade token is not configured on the server; writes are disabled",
        )
    provided = request.headers.get(TRADE_TOKEN_HEADER, "")
    if not auth.verify_trade_token(provided):
        raise HTTPException(
            status_code=403, detail="Invalid or missing trade token"
        )
    return user


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _safe_float(value) -> float:
    # Reject inf/nan: float("inf")/float("nan") parse fine, but json.dumps emits
    # Infinity/NaN (invalid JSON) which makes the browser's JSON.parse throw and
    # drops the entire WebSocket frame. Coerce non-finite values to 0.0.
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _strip_non_finite(value):
    """Replace non-finite floats ANYWHERE in a payload with their string form.

    Python's json.loads accepts literal NaN/Infinity (non-standard), so a
    degraded exchange response can smuggle float('nan') into the raw records
    that _safe_float never touches. Serialized as-is, that frame is invalid
    JSON — the browser drops it silently and the dashboard freezes at "stale"
    (WS path), or the REST path 500s (Starlette uses allow_nan=False). The
    STRING form ("nan"/"inf") is deliberate: the frontend's fmt* helpers render
    it as "—", whereas null would coerce to a fake 0.00 on a money cell."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: _strip_non_finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_strip_non_finite(v) for v in value]
    return value


# Single source, shared with the alert watcher (app/notifier.py). Aliased rather
# than wrapped so there is no needless indirection.
_extract_list = dma_client.extract_list


# Bybit-v5 linear symbols are upper-case alphanumeric (e.g. BTCUSDT, 1000PEPEUSDT).
_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,20}$")
# Coins/settle assets are shorter upper-case alphanumerics (USDT, USDC, BTC, …).
_COIN_RE = re.compile(r"^[A-Z0-9]{1,15}$")


def _valid_symbol(sym) -> bool:
    return isinstance(sym, str) and bool(_SYMBOL_RE.match(sym))


def _require_symbol(symbol) -> str:
    """Uppercase + validate a REQUIRED symbol; raise 400 on a bad format so a
    garbage value never reaches the signed upstream."""
    sym = str(symbol).upper()
    if not _valid_symbol(sym):
        raise HTTPException(status_code=400, detail="symbol has an invalid format")
    return sym


def _norm_symbol_opt(symbol):
    """Uppercase + validate an OPTIONAL symbol param. None/blank passes through as
    None (these endpoints legitimately query the full list when no symbol is
    given); a provided-but-malformed symbol is rejected with 400."""
    if symbol is None or (isinstance(symbol, str) and not symbol.strip()):
        return None
    return _require_symbol(symbol)


def _norm_coin_opt(coin):
    """Uppercase + validate an OPTIONAL coin param (None/blank -> None)."""
    if coin is None or (isinstance(coin, str) and not coin.strip()):
        return None
    c = str(coin).upper()
    if not _COIN_RE.match(c):
        raise HTTPException(status_code=400, detail="coin has an invalid format")
    return c


def _positive_finite(value) -> bool:
    """True iff `value` parses to a FINITE number > 0.

    Money-path guard: a bare `float(x) <= 0` check lets 'inf'/'1e400' through
    (inf <= 0 is False), which would serialise as invalid JSON to the exchange.
    Requiring math.isfinite closes that. Underscored spellings ("70_000") are
    also rejected: Python's float() accepts them but the validated STRING is
    forwarded verbatim to the exchange, which does not.
    """
    if isinstance(value, str) and "_" in value:
        return False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number > 0


# Monotonic dashboard-snapshot counter. Both the WS push and the /api/dashboard
# GET call build_dashboard in this one process, so a per-build increment lets the
# client order snapshots by data-assembly time regardless of transport (the client
# renders the highest `gen` seen and drops older ones). Incremented with no await
# between read and write, so it is race-free under the event loop's single thread.
_dashboard_gen = 0


async def build_dashboard() -> dict:
    """Fetch positions, open orders and balance; compute a PnL summary."""
    positions_raw, orders_raw, balance_raw = await asyncio.gather(
        dma_client.get_positions(),
        dma_client.get_open_orders(),
        dma_client.get_wallet_balance(),
        return_exceptions=True,
    )

    errors = {}

    positions = []
    if isinstance(positions_raw, Exception):
        errors["positions"] = str(positions_raw)
    else:
        positions = _extract_list(positions_raw)

    orders = []
    if isinstance(orders_raw, Exception):
        errors["orders"] = str(orders_raw)
    else:
        orders = _extract_list(orders_raw)

    balance = None
    if isinstance(balance_raw, Exception):
        errors["balance"] = str(balance_raw)
    else:
        balance = balance_raw

    total_unrealised = sum(_safe_float(p.get("unrealisedPnl")) for p in positions)
    total_position_value = sum(_safe_float(p.get("positionValue")) for p in positions)

    # Stamp at assembly time (no await between here and return, so it reflects the
    # order in which concurrent builds finished reading the exchange).
    global _dashboard_gen
    _dashboard_gen += 1

    return _strip_non_finite({
        "type": "dashboard",
        "gen": _dashboard_gen,
        "positions": positions,
        "orders": orders,
        "balance": balance,
        "summary": {
            "totalUnrealisedPnl": total_unrealised,
            "totalPositionValue": total_position_value,
            "openPositions": len([p for p in positions if _safe_float(p.get("size"))]),
            "openOrders": len(orders),
            "settleCoin": settings.SETTLE_COIN,
        },
        "errors": errors,
    })


# Force browsers to revalidate the HTML shell on every load so a deploy's new
# markup is never paired with a stale cached app.js/styles.css.
_NO_CACHE = {"Cache-Control": "no-cache"}


# --------------------------------------------------------------------------
# Page routes
# --------------------------------------------------------------------------
@app.get("/login")
def login_page():
    return FileResponse(STATIC_DIR / "login.html", headers=_NO_CACHE)


@app.get("/")
def index(request: Request):
    token = request.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    # Mirror current_user: don't serve the app shell to a superseded session
    # (the data APIs/WS would reject it anyway; this keeps the redirect consistent).
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        return RedirectResponse(url="/login", status_code=302)
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_CACHE)


@app.get("/healthz")
def healthz():
    # NOTE: the "unconfigured"/503 branch is vestigial defense-in-depth — the
    # module-level startup checks refuse to boot on missing config, so a
    # RUNNING process always reports ok here. Kept in case those checks are
    # ever relaxed; the useful live signal is historySyncAgeSeconds below.
    missing = settings.missing_required()
    code = 200 if not missing else 503
    now_ms = int(time.time() * 1000)

    def _sync_age_s(kind: str) -> int | None:
        # Seconds since this history mirror last completed a run that reached
        # "now"; null until the first run after boot. A healthy sync sits under
        # ~2× SYNC_INTERVAL_SECONDS — a climbing value means it is wedged (the
        # UI shows "⚠ stale" too, but this is watchable by a monitor). Ages are
        # not sensitive, so the unauthenticated health endpoint may carry them.
        ts = history_sync.last_synced_ms(kind)
        return round((now_ms - ts) / 1000) if ts else None

    return JSONResponse(
        status_code=code,
        content={
            "status": "ok" if not missing else "unconfigured",
            "missing": missing,
            "historySyncAgeSeconds": {
                "trades": _sync_age_s(db.TRADES),
                "closedPnl": _sync_age_s(db.CLOSED_PNL),
                "transactions": _sync_age_s(db.TRANSACTIONS),
            },
            # Verdict of the transaction-log capability probe (the endpoint is
            # not in the DMA Postman collection): true after the first
            # successful sync, false once the gateway 404'd it, null while
            # still unknown (before the first attempt after boot).
            "transactionLogSupported": (
                True if history_sync.last_synced_ms(db.TRANSACTIONS)
                else (False if history_sync.is_unsupported(db.TRANSACTIONS) else None)
            ),
            # Seconds since the market scanner last sampled the ticker list
            # (null until its first sample, or forever when disabled). Like the
            # sync ages: not sensitive, watchable by a monitor.
            "scannerAgeSeconds": (
                round((now_ms - scanner.last_sample_ms()) / 1000)
                if scanner.last_sample_ms() else None
            ),
        },
    )


# --------------------------------------------------------------------------
# Auth API
# --------------------------------------------------------------------------
@app.post("/api/login")
def api_login(request: Request, payload: dict = Body(...)):
    ip = _client_ip(request)
    if _rate_limited(f"login:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts; wait a few minutes and try again",
        )
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = auth.authenticate(username, password)
    if not role:
        _record_failure(f"login:{ip}")
        # Audit failed logins (below the 429 threshold they were invisible).
        # Deliberately WITHOUT the attempted username: failed usernames are
        # frequently mistyped passwords, which must never reach a log.
        _audit_log.warning("%s", json.dumps({"audit": "auth.login", "ip": ip, "outcome": "invalid"}))
        raise HTTPException(status_code=401, detail="Invalid username or password")
    _clear_failures(f"login:{ip}")
    _audit_log.info("%s", json.dumps(
        {"audit": "auth.login", "user": username, "role": role, "ip": ip, "outcome": "ok"}
    ))

    # Mint a new session id and make it THE active session FOR THIS ROLE — this
    # evicts any other same-role session, but never the other role's.
    sid = auth.new_session_id()
    auth.set_active_session(role, sid)
    token = auth.create_session_token(username, role, sid)
    resp = JSONResponse({"username": username, "role": role})
    resp.set_cookie(
        key=auth.COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_MAX_AGE,
        path="/",       # explicit: required for the __Host- prefix contract
        httponly=True,
        samesite="lax",
        secure=True,    # Railway serves over HTTPS; also required by __Host-
    )
    return resp


@app.post("/api/logout")
def api_logout(request: Request):
    # Only clear the active session if this cookie IS the active one (so a stale
    # tab's logout can't evict a newer session).
    data = auth.verify_session_token(request.cookies.get(auth.COOKIE_NAME))
    if data:
        auth.clear_active_session(data.get("r"), data.get("sid"))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME)
    return resp


@app.get("/api/me")
def api_me(user: dict = Depends(current_user)):
    # inrRate feeds the frontend's display-only INR lens (see config.INR_RATE);
    # served here so a rate change is an env edit + restart, not a code deploy.
    return {"username": user.get("u"), "role": user.get("r"), "inrRate": settings.INR_RATE}


@app.post("/api/verify-trade-token")
def api_verify_trade_token(
    request: Request, payload: dict = Body(...), user: dict = Depends(require_admin)
):
    """Check whether a trade token is correct so the UI can give immediate
    feedback when it's entered (instead of only failing on the first write).
    Admin-only and constant-time; additionally rate-limited so it can't be used
    as an online guessing oracle even after an admin session is obtained.
    """
    ip = _client_ip(request)
    if _rate_limited(f"tradetoken:{ip}"):
        raise HTTPException(status_code=429, detail="Too many attempts; wait a few minutes")
    valid = auth.verify_trade_token(payload.get("token") or "")
    if valid:
        _clear_failures(f"tradetoken:{ip}")
    else:
        _record_failure(f"tradetoken:{ip}")
    return {"valid": valid}


# --------------------------------------------------------------------------
# Read API (any logged-in user)
# --------------------------------------------------------------------------
@app.get("/api/dashboard")
async def api_dashboard(user: dict = Depends(current_user)):
    return await build_dashboard()


@app.get("/api/positions")
async def api_positions(user: dict = Depends(current_user)):
    return await dma_client.get_positions()


@app.get("/api/position/leverage")
async def api_position_leverage(symbol: str, user: dict = Depends(require_admin)):
    """The account's CURRENT leverage for a symbol — present even with no open
    position. Admin-only (only the order ticket uses it) and read-only; returns
    just the leverage value, not the full position record.

    Returns ONLY the one-way (positionIdx 0) leg's leverage. On a hedge-mode
    account (no idx-0 leg; separate buy/sell leverage) it returns null rather than
    guess a leg — the order ticket then falls back to its safe 'unavailable' path
    instead of sizing against the wrong side's leverage."""
    sym = _require_symbol(symbol)
    entries = _extract_list(await dma_client.get_position_by_symbol(sym))
    one_way = next(
        (e for e in entries if str(e.get("positionIdx")) == "0" and e.get("leverage")),
        None,
    )
    return {"symbol": sym, "leverage": (one_way or {}).get("leverage")}


@app.get("/api/orders")
async def api_orders(user: dict = Depends(current_user)):
    return await dma_client.get_open_orders()


@app.get("/api/balance")
async def api_balance(user: dict = Depends(current_user)):
    return await dma_client.get_wallet_balance()


@app.get("/api/instruments")
async def api_instruments(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_instruments(_norm_symbol_opt(symbol))


# --- History reads (MongoDB-backed) ---
# /api/closed-pnl and /api/executions serve the dashboard from the MongoDB
# mirror maintained by app/history_sync.py; the exchange is no longer called on
# the read path (only the sync — and the Telegram notifier's live fill poll —
# talk to it). Responses keep the exact upstream v5 envelope
# {"retCode":0,"result":{"list":[...],"truncated":...,"category":...}} so the
# frontend renders unchanged.

_HISTORY_READ_MAX = 10_000  # superset of the old ~6k effective ceiling
# The gateway's default span when no range is given = its 7-day window rule.
_EXPLORER_LOOKBACK_MS = dma_client._HISTORY_WINDOW_MS


def _clamp_days(days: int | None) -> int:
    # Parity with the exchange-side clamp (None/0 -> default, bounded 1..max),
    # sourced from the same constants so the two can never drift apart.
    return max(1, min(int(days or dma_client._HISTORY_DEFAULT_DAYS), dma_client._HISTORY_MAX_DAYS))


def _parse_ms(value: str | None, name: str) -> int | None:
    if value is None or value.strip() == "":
        return None
    if not re.fullmatch(r"\d{1,17}", value.strip()):
        raise HTTPException(status_code=400, detail=f"{name} must be an epoch-milliseconds integer")
    return int(value.strip())


def _validate_range(start_ms: int, end_ms: int) -> None:
    # No span cap on purpose: the read walks the tsMs index newest-first and
    # stops at the row cap, so a wide range (incl. the History tab's "Overall"
    # = epoch 0 → now) costs the same as a narrow one.
    if start_ms > end_ms:
        raise HTTPException(status_code=400, detail="startTime must not exceed endTime")


def _parse_range(startTime: str | None, endTime: str | None) -> tuple[int, int] | None:
    """Explicit [startTime, endTime] pair, or None when neither is given.
    One-sided input is a caller error here (the explorer branch of
    /api/executions keeps its own one-sided defaults for parity)."""
    start_ms = _parse_ms(startTime, "startTime")
    end_ms = _parse_ms(endTime, "endTime")
    if start_ms is None and end_ms is None:
        return None
    if start_ms is None or end_ms is None:
        raise HTTPException(status_code=400, detail="startTime and endTime must be provided together")
    _validate_range(start_ms, end_ms)
    return (start_ms, end_ms)


def _history_envelope(rows: list, truncated: bool, kind: str) -> dict:
    return {
        "retCode": 0,
        "retMsg": "OK",
        "result": {
            "category": settings.CATEGORY,
            "list": rows,
            "truncated": truncated,
            # Epoch-ms of the last completed sync for this collection (None
            # until the first run after boot) — the dashboard shows it so the
            # user knows how fresh the history is. nowMs is the SERVER clock
            # at response time: the browser measures staleness against it so
            # a skewed client clock can neither cry wolf nor hide staleness.
            "lastSyncedMs": history_sync.last_synced_ms(kind),
            "nowMs": int(time.time() * 1000),
        },
    }


async def _query_history_or_503(kind: str, *, symbol, start_ms: int, end_ms: int, limit: int) -> list:
    """History reads fail soft: a Mongo outage yields 503 for these endpoints
    while every trading function keeps working off the live exchange."""
    try:
        return await db.query_history(
            kind, symbol=symbol, start_ms=start_ms, end_ms=end_ms, limit=limit
        )
    except (PyMongoError, BSONError, OSError):
        # OSError covers the lazy client construction path too (TLS CA temp
        # file I/O, ssl.SSLError) — those must degrade to the same sanitized
        # 503, never a raw 500 with internal detail.
        logger.exception("history read failed (%s): mongo unavailable", kind)
        raise HTTPException(status_code=503, detail="history database unavailable")


@app.get("/api/closed-pnl")
async def api_closed_pnl(
    symbol: str | None = None,
    days: int | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    user: dict = Depends(current_user),
):
    # Preset mode keeps the old lookback semantics (default 30d, clamp 1..31);
    # the History tab's custom picker sends an explicit startTime/endTime pair
    # instead. `days`, when given, wins (mirrors /api/executions).
    rng = _parse_range(startTime, endTime) if days is None else None
    if rng:
        start_ms, end_ms = rng
    else:
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - _clamp_days(days) * 86_400_000
    rows = await _query_history_or_503(
        db.CLOSED_PNL, symbol=_norm_symbol_opt(symbol),
        start_ms=start_ms, end_ms=end_ms, limit=_HISTORY_READ_MAX,
    )
    return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.CLOSED_PNL)


@app.get("/api/transactions")
async def api_transactions(
    symbol: str | None = None,
    days: int | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    user: dict = Depends(current_user),
):
    # Account transaction log (trades, fees, funding, transfers, settlements)
    # from the MongoDB mirror — same range semantics as /api/closed-pnl. 501
    # once the sync's capability probe found the gateway doesn't proxy the
    # endpoint (before that verdict the list is simply empty and lastSyncedMs
    # null, which the caller can distinguish via /healthz).
    if history_sync.is_unsupported(db.TRANSACTIONS):
        raise HTTPException(
            status_code=501,
            detail="the DMA gateway does not support the transaction log",
        )
    rng = _parse_range(startTime, endTime) if days is None else None
    if rng:
        start_ms, end_ms = rng
    else:
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - _clamp_days(days) * 86_400_000
    rows = await _query_history_or_503(
        db.TRANSACTIONS, symbol=_norm_symbol_opt(symbol),
        start_ms=start_ms, end_ms=end_ms, limit=_HISTORY_READ_MAX,
    )
    return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.TRANSACTIONS)


@app.get("/api/withdrawable")
async def api_withdrawable(coin: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_withdrawable(_norm_coin_opt(coin))


@app.get("/api/executions")
async def api_executions(
    symbol: str | None = None,
    limit: str | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    days: int | None = None,
    user: dict = Depends(current_user),
):
    # Three modes, all reading MongoDB: `days` (History presets — covers the
    # same period as closed PnL; other params ignored, the old behaviour);
    # BOTH startTime+endTime (History custom range — full-window read); else
    # the API Explorer's single-page semantics (limit 1..100 default 50,
    # one-sided/no bounds defaulting to a 7-day span). The Telegram notifier
    # still calls dma_client.get_executions directly for its live fill alerts.
    sym = _norm_symbol_opt(symbol)
    now_ms = int(time.time() * 1000)
    if days is not None:
        start_ms = now_ms - _clamp_days(days) * 86_400_000
        rows = await _query_history_or_503(
            db.TRADES, symbol=sym, start_ms=start_ms, end_ms=now_ms,
            limit=_HISTORY_READ_MAX,
        )
        return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.TRADES)

    start_ms = _parse_ms(startTime, "startTime")
    end_ms = _parse_ms(endTime, "endTime")
    if start_ms is not None and end_ms is not None:
        # Both bounds = the History tab's custom range: a full-window read,
        # not the single-page explorer call.
        _validate_range(start_ms, end_ms)
        rows = await _query_history_or_503(
            db.TRADES, symbol=sym, start_ms=start_ms, end_ms=end_ms,
            limit=_HISTORY_READ_MAX,
        )
        return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.TRADES)

    try:
        cap = int(limit) if limit not in (None, "") else 50
    except ValueError:
        raise HTTPException(status_code=400, detail="limit must be an integer")
    cap = max(1, min(cap, 100))
    if start_ms is None and end_ms is None:
        start_ms, end_ms = now_ms - _EXPLORER_LOOKBACK_MS, now_ms
    elif start_ms is None:
        start_ms = max(0, end_ms - _EXPLORER_LOOKBACK_MS)
    else:
        end_ms = start_ms + _EXPLORER_LOOKBACK_MS
    rows = await _query_history_or_503(
        db.TRADES, symbol=sym, start_ms=start_ms, end_ms=end_ms, limit=cap
    )
    return _history_envelope(rows, len(rows) >= cap, db.TRADES)


@app.get("/api/account-info")
async def api_account_info(user: dict = Depends(current_user)):
    return await dma_client.get_account_info()


@app.get("/api/server-time")
async def api_server_time(user: dict = Depends(current_user)):
    return await dma_client.get_server_time()


@app.get("/api/tickers")
async def api_tickers(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_tickers(_norm_symbol_opt(symbol))


@app.get("/api/scanner")
async def api_scanner(user: dict = Depends(current_user)):
    """Market Scanner snapshot. Served ENTIRELY from the in-memory snapshot the
    background sampler maintains (app/scanner.py) — this handler performs no
    upstream call, so any number of scanner tabs cost the exchange nothing
    beyond the sampler's one poll per interval. Read-only market data."""
    return scanner.snapshot_response()


@app.get("/api/orderbook")
async def api_orderbook(symbol: str, limit: str | None = None, user: dict = Depends(current_user)):
    """Depth snapshot for the trading ladder. `limit` (1..200, default =
    upstream default) is validated here so a garbage value never reaches the
    signed upstream; deeper books cost the same one read."""
    depth = None
    if limit not in (None, ""):
        try:
            depth = int(limit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="limit must be an integer")
        if not 1 <= depth <= 200:
            raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    return await dma_client.get_orderbook(_require_symbol(symbol), depth)


@app.get("/api/klines")
async def api_klines(
    symbol: str,
    interval: str,
    limit: str | None = None,
    user: dict = Depends(current_user),
):
    """Public OHLC candles for the dashboard charts. Read-only and isolated from
    the signed trading path: served by `market_data` (no API key, no signing),
    with the symbol/interval validated against a server-side whitelist. Requires
    a logged-in session like every other read endpoint."""
    return await market_data.get_kline(symbol, interval, limit)


# --------------------------------------------------------------------------
# Trading Journal API — native MongoDB-backed endpoints (no exchange proxying).
#
# Entries annotate completed trades (keyed by the Closed-PnL record's natural
# id, `orderId:updatedTime`) with notes / strategy / tags / mistakes / scores /
# review status; catalogs (Journal-Meta) hold the user's tag/strategy/mistake
# definitions. Reads are open to any logged-in user like every other read.
# Writes require the ADMIN role but deliberately NOT the trade token: journal
# writes move no money and touch no exchange state, and demanding the trade
# ceremony on every autosaved keystroke would push users into disabling it.
# CSRF is still covered without the custom-header check — the session cookie
# is SameSite=Lax, so a cross-site POST/PUT never carries it. Like the history
# reads, a Mongo outage degrades these to 503 while trading keeps working.
# --------------------------------------------------------------------------
_JOURNAL_READ_MAX = 10_000  # matches the history read ceiling


async def _journal_or_503(coro):
    try:
        return await coro
    except (PyMongoError, BSONError, OSError):
        logger.exception("journal operation failed: mongo unavailable")
        raise HTTPException(status_code=503, detail="journal database unavailable")


def _require_entry_id(entry_id: str) -> str:
    if not journal.valid_entry_id(entry_id):
        raise HTTPException(status_code=400, detail="invalid journal entry id")
    return entry_id


@app.get("/api/journal/entries")
async def api_journal_entries(
    symbol: str | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    user: dict = Depends(current_user),
):
    """Journal entries whose trade closed in [startTime, endTime] (both epoch
    ms; omitted = all time, mirroring the History tab's 'Overall'). List reads
    carry note EXCERPTS + word counts, never full text — a thousands-of-trades
    window stays a small payload and full notes load only on card expand."""
    rng = _parse_range(startTime, endTime)
    start_ms, end_ms = rng if rng else (0, int(time.time() * 1000))
    rows = await _journal_or_503(db.journal_query(
        symbol=_norm_symbol_opt(symbol), start_ms=start_ms, end_ms=end_ms,
        limit=_JOURNAL_READ_MAX,
    ))
    return {
        "entries": [journal.shape_entry(d, full=False) for d in rows],
        "truncated": len(rows) >= _JOURNAL_READ_MAX,
        "nowMs": int(time.time() * 1000),
    }


@app.get("/api/journal/entry/{entry_id}")
async def api_journal_entry(entry_id: str, user: dict = Depends(current_user)):
    doc = await _journal_or_503(db.journal_get(_require_entry_id(entry_id)))
    return {"entry": journal.shape_entry(doc, full=True) if doc else None}


@app.put("/api/journal/entry/{entry_id}")
async def api_journal_entry_put(
    entry_id: str, payload: dict = Body(...), user: dict = Depends(require_admin)
):
    """Partial upsert (the autosave path): only allowlisted, validated fields
    are ever $set. The payload must also carry the trade's symbol + close-time
    tsMs — stamped ONCE via $setOnInsert as the entry's denormalized join/index
    keys, then immutable, so an entry can never drift from its trade."""
    _require_entry_id(entry_id)
    try:
        fields = journal.clean_entry_fields(payload)
    except journal.JournalValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not fields:
        raise HTTPException(status_code=400, detail="no journal fields in payload")
    sym = _require_symbol(payload.get("symbol"))
    try:
        ts_ms = int(payload.get("tsMs"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="tsMs must be the trade's close time in epoch ms")
    now_ms = int(time.time() * 1000)
    if not 0 < ts_ms <= now_ms + 86_400_000:
        raise HTTPException(status_code=400, detail="tsMs is out of range")
    fields["updatedAtMs"] = now_ms
    doc = await _journal_or_503(db.journal_upsert(
        entry_id, fields, insert_fields=journal.insert_fields(sym, ts_ms),
    ))
    return {"entry": journal.shape_entry(doc, full=True)}


@app.delete("/api/journal/entry/{entry_id}")
async def api_journal_entry_delete(entry_id: str, user: dict = Depends(require_admin)):
    deleted = await _journal_or_503(db.journal_delete(_require_entry_id(entry_id)))
    return {"deleted": deleted}


@app.get("/api/journal/meta")
async def api_journal_meta(user: dict = Depends(current_user)):
    doc = await _journal_or_503(db.journal_meta_get())
    if doc is None:
        # Starter catalogs so the pickers are useful before the first save;
        # isDefault tells the client these are suggestions, not stored state.
        return {"meta": journal.default_meta(), "isDefault": True}
    return {"meta": doc, "isDefault": False}


@app.put("/api/journal/meta")
async def api_journal_meta_put(payload: dict = Body(...), user: dict = Depends(require_admin)):
    try:
        doc = journal.clean_meta(payload)
    except journal.JournalValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await _journal_or_503(db.journal_meta_set(dict(doc)))
    return {"meta": doc, "isDefault": False}


@app.post("/api/journal/meta/rename")
async def api_journal_relabel(payload: dict = Body(...), user: dict = Depends(require_admin)):
    """Rename (or remove, with to=null/"") one tag / strategy / mistake label
    across every entry. The catalog itself is the client's to update via PUT
    /api/journal/meta — this endpoint only rewrites the entries."""
    try:
        field, old, new = journal.clean_relabel(payload)
    except journal.JournalValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    modified = await _journal_or_503(db.journal_relabel(field, old, new))
    return {"modified": modified}


# --------------------------------------------------------------------------
# AI intelligence layer — READ-ONLY analysis of the trader's own history.
#
# Nothing under /api/ai can reach an exchange write: generations read the
# MongoDB mirrors (plus, best-effort, the same read-only position/balance
# endpoints the dashboard uses) and write only to the AI-Conversations
# collection and the journal's server-owned `aiReview` field. Deterministic
# insights (/api/ai/insights) involve no LLM at all and are open to any
# logged-in user; LLM-invoking endpoints are admin-only (they spend provider
# tokens) and budget-capped per minute. Provider identity is never exposed —
# responses carry capabilities (live/streaming), not a vendor name.
# --------------------------------------------------------------------------
_AI_CONV_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _require_conv_id(conv_id: str) -> str:
    if not _AI_CONV_ID_RE.match(str(conv_id or "")):
        raise HTTPException(status_code=400, detail="invalid conversation id")
    return conv_id


async def _run_ai(coro):
    """Uniform error mapping for AI operations: budget -> 429, provider ->
    sanitized 502, Mongo -> the same soft 503 as every other history read."""
    try:
        return await coro
    except ai_service.AIBusyError as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    except ai_providers.AIProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except (PyMongoError, BSONError, OSError):
        logger.exception("ai operation failed: mongo unavailable")
        raise HTTPException(status_code=503, detail="history database unavailable")


@app.get("/api/ai/status")
async def api_ai_status(user: dict = Depends(current_user)):
    return ai_service.status()


@app.get("/api/ai/templates")
async def api_ai_templates(user: dict = Depends(current_user)):
    return {"templates": list(ai_service.TEMPLATES)}


@app.get("/api/ai/insights")
async def api_ai_insights(
    startTime: str | None = None,
    endTime: str | None = None,
    tzOffsetMin: int | None = None,
    user: dict = Depends(current_user),
):
    """Deterministic performance insights + pattern detection. No LLM in the
    loop — every number is computed server-side from the history mirror, so
    this endpoint is instant, free, and available to both roles. tzOffsetMin
    (browser minutes east of UTC) makes day/session buckets follow the
    TRADER's clock, not the deploy's."""
    rng = _parse_range(startTime, endTime)
    now_ms = int(time.time() * 1000)
    start_ms, end_ms = rng if rng else (now_ms - 30 * ai_service.DAY_MS, now_ms)
    tz = ai_service._clamp_tz(tzOffsetMin)
    trades = await _run_ai(ai_service.load_trades(start_ms, end_ms))
    return {
        "stats": ai_context.overall_stats(trades),
        "findings": ai_context.findings(trades, tz),
        "byWeekday": ai_context.by_weekday(trades, tz),
        "byHour": ai_context.by_hour_bucket(trades, tz),
        "bySymbol": ai_context.by_symbol(trades),
        "byStrategy": ai_context.by_strategy(trades),
        "byTag": ai_context.by_tag(trades),
        "byMistake": ai_context.by_mistake(trades),
        "calibration": ai_context.confidence_calibration(trades),
        "streaks": ai_context.streaks(trades),
        "drawdown": ai_context.drawdown(trades),
        "behaviorChange": ai_context.behavior_change(trades),
        "overtrading": ai_context.overtrading_bursts(trades),
        "revenge": ai_context.revenge_trades(trades),
        "nowMs": now_ms,
    }


@app.post("/api/ai/briefing")
async def api_ai_briefing(payload: dict = Body(default={}), user: dict = Depends(require_admin)):
    try:
        range_days = int((payload or {}).get("rangeDays", 7))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="rangeDays must be an integer")
    return await _run_ai(ai_service.briefing(range_days, (payload or {}).get("tzOffsetMin")))


@app.post("/api/ai/trade-review")
async def api_ai_trade_review(payload: dict = Body(...), user: dict = Depends(require_admin)):
    trade_id = payload.get("tradeId")
    if not journal.valid_entry_id(trade_id):
        raise HTTPException(status_code=400, detail="invalid trade id")
    try:
        return await _run_ai(ai_service.trade_review(trade_id))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ai/session-review")
async def api_ai_session_review(payload: dict = Body(...), user: dict = Depends(require_admin)):
    period = payload.get("period")
    at_ms = payload.get("atMs")
    if at_ms is not None:
        try:
            at_ms = int(at_ms)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="atMs must be epoch milliseconds")
    try:
        return await _run_ai(ai_service.session_review(
            str(period or ""), at_ms, payload.get("tzOffsetMin")))
    except (ValueError, OverflowError, OSError) as exc:
        # OverflowError/OSError: datetime.fromtimestamp on an absurd atMs —
        # a caller error, never a 500.
        raise HTTPException(status_code=400, detail=str(exc) or "invalid atMs")


@app.post("/api/ai/query")
async def api_ai_query(payload: dict = Body(...), user: dict = Depends(require_admin)):
    """Natural-language question over the trader's own history, streamed as
    SSE. The answer is grounded in a server-built evidence pack; the exchange
    is persisted to the conversation only after the stream completes."""
    conv_id = payload.get("conversationId")
    if conv_id is not None:
        _require_conv_id(conv_id)
    try:
        prep = await _run_ai(ai_service.prepare_query(
            payload.get("question"), conv_id, payload.get("tzOffsetMin")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    provider = ai_providers.get_provider()

    def _event(obj: dict) -> str:
        return "data: " + json.dumps(obj, allow_nan=False) + "\n\n"

    async def event_stream():
        yield _event({
            "type": "start",
            "conversationId": prep["conversationId"],
            "evidence": prep["evidence"],
        })
        parts: list[str] = []
        try:
            async for delta in provider.stream(prep["system"], prep["messages"]):
                parts.append(delta)
                yield _event({"type": "delta", "text": delta})
        except ai_providers.AIProviderError as exc:
            yield _event({"type": "error", "error": str(exc)})
            return
        except Exception:
            logger.exception("ai query stream failed")
            yield _event({"type": "error", "error": "AI request failed"})
            return
        answer = "".join(parts)
        try:
            await ai_service.record_exchange(prep, answer)
        except Exception:
            # The answer already streamed; a persistence blip must not
            # retroactively fail it. The conversation just misses this turn.
            logger.exception("ai conversation persist failed")
        yield _event({
            "type": "done",
            "conversationId": prep["conversationId"],
            "generatedAtMs": int(time.time() * 1000),
            "live": provider.live,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # `identity` opts out of GZipMiddleware (it skips responses that
            # already declare an encoding) so deltas are never buffered.
            "Cache-Control": "no-cache, no-transform",
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )


def _conv_meta(doc: dict) -> dict:
    return {
        "id": doc.get("_id"),
        "title": doc.get("title") or "Untitled",
        "pinned": bool(doc.get("pinned")),
        "createdAtMs": doc.get("createdAtMs"),
        "updatedAtMs": doc.get("updatedAtMs"),
    }


@app.get("/api/ai/conversations")
async def api_ai_conversations(user: dict = Depends(current_user)):
    docs = await _run_ai(db.ai_conv_list())
    return {"conversations": [_conv_meta(d) for d in docs]}


@app.get("/api/ai/conversations/{conv_id}")
async def api_ai_conversation(conv_id: str, user: dict = Depends(current_user)):
    doc = await _run_ai(db.ai_conv_get(_require_conv_id(conv_id)))
    if doc is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {**_conv_meta(doc), "messages": doc.get("messages") or []}


@app.patch("/api/ai/conversations/{conv_id}")
async def api_ai_conversation_update(
    conv_id: str, payload: dict = Body(...), user: dict = Depends(require_admin)
):
    fields: dict = {}
    if "title" in payload:
        title = str(payload.get("title") or "").strip()
        if not title or len(title) > 80:
            raise HTTPException(status_code=400, detail="title must be 1-80 characters")
        fields["title"] = title
    if "pinned" in payload:
        fields["pinned"] = bool(payload.get("pinned"))
    if not fields:
        raise HTTPException(status_code=400, detail="nothing to update (title/pinned)")
    fields["updatedAtMs"] = int(time.time() * 1000)
    ok = await _run_ai(db.ai_conv_update(_require_conv_id(conv_id), fields))
    if not ok:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"ok": True}


@app.delete("/api/ai/conversations/{conv_id}")
async def api_ai_conversation_delete(conv_id: str, user: dict = Depends(require_admin)):
    deleted = await _run_ai(db.ai_conv_delete(_require_conv_id(conv_id)))
    return {"deleted": deleted}


# --------------------------------------------------------------------------
# Audit trail — one append-only line per money operation, success AND failure.
#
# The exchange's records show WHAT happened; only this log shows WHO asked for
# it (session, role, client IP) and with WHICH exact outbound body — the
# forensic difference between "operator did it" and "trade token compromised".
# Lines are single JSON objects on the "dma-ui.audit" logger (INFO->stdout, so
# Railway retains them with the app logs). The logged body is the sanitized
# ALLOWLISTED body we send upstream — never the raw client payload and never
# any secret (the trade token lives in a header nobody logs).
# --------------------------------------------------------------------------
_audit_log = logging.getLogger("dma-ui.audit")


async def _audited(request: Request, user: dict, action: str, body: dict, call):
    """Run one exchange write, emitting an audit line for whichever outcome.
    Exceptions propagate unchanged after being recorded — auditing must never
    alter control flow on the money path."""
    entry = {
        "audit": action,
        "user": user.get("u"),
        "role": user.get("r"),
        "ip": _client_ip(request),
        "body": body,
    }
    try:
        result = await call()
    except dma_client.DMAError as exc:
        entry["outcome"] = "rejected"
        entry["status"] = exc.status
        entry["error"] = _upstream_error_message(exc.detail)
        _audit_log.warning("%s", json.dumps(entry, default=str))
        raise
    except Exception as exc:
        # Unexpected local failure: record the TYPE only (a repr could embed
        # request internals); the root logger still gets the full traceback
        # from FastAPI's own error handling.
        entry["outcome"] = "exception"
        entry["error"] = type(exc).__name__
        _audit_log.warning("%s", json.dumps(entry, default=str))
        raise
    entry["outcome"] = "ok"
    if isinstance(result, dict):
        inner = result.get("result")
        if isinstance(inner, dict) and inner.get("orderId"):
            entry["orderId"] = inner.get("orderId")
        data = result.get("data")
        if isinstance(data, dict) and data.get("txn_id"):
            entry["txnId"] = data.get("txn_id")
    _audit_log.info("%s", json.dumps(entry, default=str))
    return result


# --------------------------------------------------------------------------
# Write API (admin only)
# --------------------------------------------------------------------------
@app.post("/api/order/create")
async def api_create_order(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    side = payload.get("side")
    order_type = payload.get("orderType")
    qty = payload.get("qty")
    if not symbol or not side or not order_type or qty is None:
        raise HTTPException(
            status_code=400, detail="symbol, side, orderType and qty are required"
        )
    symbol = str(symbol).upper()
    if not _valid_symbol(symbol):
        raise HTTPException(status_code=400, detail="symbol has an invalid format")
    if str(side).lower() not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="side must be Buy or Sell")
    if str(order_type).lower() not in ("market", "limit"):
        raise HTTPException(status_code=400, detail="orderType must be Market or Limit")
    if not _positive_finite(qty):
        raise HTTPException(status_code=400, detail="qty must be a finite number greater than 0")

    # Build the OUTBOUND body from an explicit ALLOWLIST — never forward the raw
    # client payload. Mass-assignment defense: a stray/forged field (closeOnTrigger,
    # orderLinkId, a client-chosen positionIdx, a truthy-string reduceOnly) must not
    # silently reach the exchange. Only these validated fields are sent.
    order: dict = {
        "symbol": symbol,
        "side": "Buy" if str(side).lower() == "buy" else "Sell",
        "orderType": "Limit" if str(order_type).lower() == "limit" else "Market",
        "qty": str(qty).strip(),
    }

    # positionIdx: 0 = one-way, 1/2 = hedge legs. Anything else is a REJECT,
    # not a silent clamp: coercing a garbled idx to 0 on a hedge-mode account
    # would target the wrong leg's semantics and surface only as a confusing
    # exchange error after the confirm ceremony.
    try:
        pos_idx = int(payload.get("positionIdx", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="positionIdx must be 0, 1 or 2")
    if pos_idx not in (0, 1, 2):
        raise HTTPException(status_code=400, detail="positionIdx must be 0, 1 or 2")
    order["positionIdx"] = pos_idx

    if order["orderType"] == "Limit":
        price = payload.get("price")
        if not _positive_finite(price):
            raise HTTPException(
                status_code=400,
                detail="price must be a finite number greater than 0 for a Limit order",
            )
        order["price"] = str(price).strip()

    # Optional time-in-force (allowlisted like every write field). GTC is the
    # exchange default — omitted from the body so a default order stays
    # byte-identical to before this field existed. PostOnly is maker-or-cancel
    # and only meaningful on a Limit order; catch the Market combination early.
    tif = payload.get("timeInForce")
    if tif not in (None, ""):
        tif = str(tif)
        if tif not in ("GTC", "IOC", "FOK", "PostOnly"):
            raise HTTPException(
                status_code=400, detail="timeInForce must be GTC, IOC, FOK or PostOnly"
            )
        if tif == "PostOnly" and order["orderType"] != "Limit":
            raise HTTPException(
                status_code=400, detail="PostOnly applies to Limit orders only"
            )
        if tif != "GTC":
            order["timeInForce"] = tif

    # reduceOnly must be a real bool (not a truthy string) before it can gate risk.
    reduce_only = bool(payload.get("reduceOnly"))

    # Optional TP/SL attached at order creation.
    take_profit = payload.get("takeProfit")
    stop_loss = payload.get("stopLoss")
    has_tpsl = take_profit not in (None, "") or stop_loss not in (None, "")
    if has_tpsl and reduce_only:
        # Bybit rejects TP/SL combined with reduceOnly; catch it early.
        raise HTTPException(
            status_code=400,
            detail="takeProfit/stopLoss cannot be set on a reduce-only order",
        )
    for name, value in (("takeProfit", take_profit), ("stopLoss", stop_loss)):
        if value in (None, ""):
            continue
        if not _positive_finite(value):
            raise HTTPException(
                status_code=400, detail=f"{name} must be a finite number greater than 0"
            )
        order[name] = str(value).strip()

    if reduce_only:
        order["reduceOnly"] = True

    # Optional venue-side order tag (idempotency/forensics). SERVER-generated —
    # a client-supplied orderLinkId stays allowlisted OUT — and env-gated OFF by
    # default: it is a standard Bybit-v5 field, but this gateway has deviated
    # from stock v5 before (the cursor-signing incident), so it must be verified
    # against the live venue once before being switched on. When enabled, an
    # ambiguous timeout below reports the tag so the maybe-placed order can be
    # found in Open Orders. 36-char cap per v5: "dma-" + 32-hex = 36.
    if settings.SEND_ORDER_LINK_ID:
        order["orderLinkId"] = f"dma-{uuid.uuid4().hex}"

    try:
        return await _audited(request, user, "order.create", order,
                              lambda: dma_client.create_order(order))
    except dma_client.DMAError as exc:
        # 5xx = the venue never ANSWERED (timeout / gateway error) — unlike a
        # 4xx business rejection, the order MAY have been accepted before the
        # failure. Never let the operator read this as "not placed": an instant
        # manual resubmit is the classic double-execution path.
        if exc.status >= 500:
            ref = order.get("orderLinkId")
            raise dma_client.DMAError(
                exc.status,
                "The exchange did not confirm this order — it MAY still have been "
                "placed. Check Open Orders / Positions before submitting again."
                + (f" (order tag: {ref})" if ref else ""),
            ) from exc
        raise


@app.post("/api/order/cancel")
async def api_cancel_order(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    order_id = payload.get("orderId")
    if not symbol or not order_id:
        raise HTTPException(status_code=400, detail="symbol and orderId are required")
    sym = _require_symbol(symbol)
    return await _audited(request, user, "order.cancel",
                          {"symbol": sym, "orderId": order_id},
                          lambda: dma_client.cancel_order(sym, order_id))


@app.post("/api/order/cancel-all")
async def api_cancel_all(request: Request, payload: dict = Body(default={}), user: dict = Depends(require_trade_token)):
    symbol = _norm_symbol_opt((payload or {}).get("symbol"))
    return await _audited(request, user, "order.cancel-all", {"symbol": symbol},
                          lambda: dma_client.cancel_all(symbol))


@app.post("/api/position/set-leverage")
async def api_set_leverage(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    buy = payload.get("buyLeverage")
    sell = payload.get("sellLeverage", buy)
    if not symbol or buy is None:
        raise HTTPException(status_code=400, detail="symbol and buyLeverage are required")
    symbol = _require_symbol(symbol)
    for name, value in (("buyLeverage", buy), ("sellLeverage", sell)):
        if not _positive_finite(value):
            raise HTTPException(
                status_code=400, detail=f"{name} must be a finite number greater than 0"
            )
    return await _audited(request, user, "position.set-leverage",
                          {"symbol": symbol, "buyLeverage": buy, "sellLeverage": sell},
                          lambda: dma_client.set_leverage(symbol, buy, sell))


async def _resolve_open_position(symbol, req_idx=None) -> dict:
    """Return the single LIVE open position for a symbol (optionally a specific
    positionIdx). Raises HTTPException(400) if none or ambiguous.

    Callers use the returned authoritative positionIdx/side/size — never the
    client's — so a stale or forged request can't target the wrong leg.
    """
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    positions = _extract_list(await dma_client.get_positions())
    matches = [
        p
        for p in positions
        if str(p.get("symbol", "")).upper() == str(symbol).upper()
        and _safe_float(p.get("size")) > 0
    ]
    if req_idx is not None:
        matches = [p for p in matches if str(p.get("positionIdx")) == str(req_idx)]
    if not matches:
        raise HTTPException(status_code=400, detail=f"No open position found for {symbol}")
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Multiple open positions for {symbol}; specify positionIdx",
        )
    return matches[0]


async def _partial_close_qty(pos: dict, percent: float) -> str:
    """Base-coin qty closing `percent`% of a LIVE position, floored to the
    instrument's lot step. Money path: all arithmetic is Decimal on the
    exchange's own strings — float rounding must never mint an off-step qty.
    Raises 502 when the lot step can't be determined (the operator can always
    fall back to a full close, which needs no step) and 400 when the requested
    slice floors to zero lots."""
    symbol = str(pos.get("symbol", ""))
    inst = next(iter(_extract_list(await dma_client.get_instruments(symbol))), None)
    # Money-path paranoia: the qty is derived from THIS instrument's lot step,
    # so verify the gateway actually answered for the symbol we asked about
    # (this gateway has deviated from stock v5 filtering semantics before).
    if not isinstance(inst, dict) or str(inst.get("symbol", "")).upper() != symbol.upper():
        raise HTTPException(
            status_code=502,
            detail=f"could not determine the lot step for {symbol}; close fully instead",
        )
    step_raw = inst.get("lotSizeFilter", {}).get("qtyStep")
    try:
        step = Decimal(str(step_raw))
        size = Decimal(str(pos.get("size")).strip())
        pct = Decimal(str(percent))
    except (InvalidOperation, TypeError):
        raise HTTPException(
            status_code=502,
            detail=f"could not determine the lot step for {symbol}; close fully instead",
        )
    if step <= 0 or size <= 0:
        raise HTTPException(
            status_code=502,
            detail=f"could not determine the lot step for {symbol}; close fully instead",
        )
    qty = (size * pct / Decimal(100) / step).to_integral_value(rounding=ROUND_FLOOR) * step
    if qty <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"{percent:g}% of {size} rounds below one lot step ({step}); "
            "use a larger percent or close fully",
        )
    # Flooring a <100% slice can never exceed the live size; format as a plain
    # decimal string at the step's own precision (str(Decimal) can emit 1E-7).
    return format(qty.quantize(step), "f")


@app.post("/api/position/close")
async def api_close_position(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    """Close a position — fully, or a percent slice — with a reduce-only market
    order in the opposite side.

    The side / size / positionIdx are re-derived from the LIVE exchange
    position — never trusted from the client — so a stale or forged request
    can't close the wrong size or side. reduceOnly guarantees this can only
    ever reduce, never open or flip, a position. An optional `percent` in
    (0, 100] closes that share of the live size, floored to the instrument's
    lot step server-side; omitted or 100 keeps the exact full-close behaviour
    (the exchange's own size string, no re-derivation).
    """
    percent = 100.0
    percent_raw = payload.get("percent")
    if percent_raw is not None:
        try:
            percent = float(percent_raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="percent must be a number")
        if not math.isfinite(percent) or not (0 < percent <= 100):
            raise HTTPException(status_code=400, detail="percent must be greater than 0 and at most 100")

    pos = await _resolve_open_position(payload.get("symbol"), payload.get("positionIdx"))
    size = _safe_float(pos.get("size"))
    side = str(pos.get("side", ""))
    if size <= 0 or side.lower() not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="Position has no closable size")

    if percent >= 100:
        # Echo back the exchange's own size string (validated >0 above),
        # stripped of stray whitespace — avoids any reformatting drift.
        qty = str(pos.get("size")).strip()
    else:
        qty = await _partial_close_qty(pos, percent)

    order = {
        "symbol": pos.get("symbol"),
        "side": "Sell" if side.lower() == "buy" else "Buy",
        "orderType": "Market",
        "qty": qty,
        "reduceOnly": True,
        "positionIdx": pos.get("positionIdx", 0),
    }
    audit_body = {**order, "percent": percent} if percent < 100 else order
    return await _audited(request, user, "position.close", audit_body,
                          lambda: dma_client.create_order(order))


@app.post("/api/position/trading-stop")
async def api_trading_stop(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    """Set or cancel TP/SL on an existing position (Full mode, market exit).

    positionIdx is re-derived from the LIVE position so the stop always attaches
    to the correct leg (critical in hedge mode). A value of "0" cancels that
    leg; at least one of takeProfit/stopLoss must be supplied.
    """
    take_profit = payload.get("takeProfit")
    stop_loss = payload.get("stopLoss")

    def _validate(name, value):
        # Empty/None => not supplied (leave that leg untouched). "0" => cancel.
        if value in (None, ""):
            return None
        if isinstance(value, str) and "_" in value:
            # float("70_000") parses, but the raw string goes to the exchange.
            raise HTTPException(status_code=400, detail=f"{name} must be a number")
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{name} must be a number")
        if not math.isfinite(number):
            raise HTTPException(status_code=400, detail=f"{name} must be a finite number")
        if number < 0:
            raise HTTPException(status_code=400, detail=f"{name} must be >= 0 (0 cancels)")
        return str(value).strip()

    tp = _validate("takeProfit", take_profit)
    sl = _validate("stopLoss", stop_loss)
    if tp is None and sl is None:
        raise HTTPException(
            status_code=400, detail="at least one of takeProfit or stopLoss is required"
        )

    # Validate the trigger source (allowlist, like every other write field) BEFORE
    # the upstream position lookup, so a bad value fails fast without a wasted
    # round-trip and can never be forwarded to silently no-op the stop.
    trigger_by = payload.get("triggerBy")
    if trigger_by and str(trigger_by) not in ("LastPrice", "MarkPrice", "IndexPrice"):
        raise HTTPException(
            status_code=400, detail="triggerBy must be LastPrice, MarkPrice or IndexPrice"
        )

    pos = await _resolve_open_position(payload.get("symbol"), payload.get("positionIdx"))

    body = {
        "symbol": pos.get("symbol"),
        "tpslMode": "Full",
        "positionIdx": pos.get("positionIdx", 0),
    }
    if tp is not None:
        body["takeProfit"] = tp
    if sl is not None:
        body["stopLoss"] = sl
    if trigger_by:  # already allowlist-validated above
        body["tpTriggerBy"] = trigger_by
        body["slTriggerBy"] = trigger_by
    return await _audited(request, user, "position.trading-stop", body,
                          lambda: dma_client.set_trading_stop(body))


@app.post("/api/account/set-margin-mode")
async def api_set_margin_mode(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    mode = payload.get("setMarginMode") or payload.get("mode")
    if not mode:
        raise HTTPException(status_code=400, detail="setMarginMode is required")
    # Allowlist the mode like every other write field (side/orderType/direction).
    # Small fixed domain, so a forged/garbled value is rejected locally with a
    # clean 400 instead of being forwarded for the exchange to reject.
    mode = str(mode).upper()
    if mode not in ("ISOLATED_MARGIN", "REGULAR_MARGIN", "PORTFOLIO_MARGIN"):
        raise HTTPException(
            status_code=400,
            detail="setMarginMode must be ISOLATED_MARGIN, REGULAR_MARGIN or PORTFOLIO_MARGIN",
        )
    return await _audited(request, user, "account.set-margin-mode",
                          {"setMarginMode": mode},
                          lambda: dma_client.set_margin_mode(mode))


@app.post("/api/funds/transfer")
async def api_transfer_funds(request: Request, payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    direction = payload.get("direction")
    amount = payload.get("amount")
    quote_asset = payload.get("quote_asset") or payload.get("quoteAsset")
    client_txn_id = payload.get("client_txn_id")
    if not direction or amount is None or not quote_asset:
        raise HTTPException(
            status_code=400, detail="direction, amount and quote_asset are required"
        )
    # Idempotency is MANDATORY on the money-movement path. The client owns a stable
    # id per transfer intent so a retry after a local timeout is a no-op at the
    # exchange (the dedup key is unchanged) instead of a second, real transfer.
    if not isinstance(client_txn_id, str) or not client_txn_id.strip():
        raise HTTPException(status_code=400, detail="client_txn_id is required for a transfer")
    if str(direction).upper() not in ("IN", "OUT"):
        raise HTTPException(status_code=400, detail="direction must be IN or OUT")
    if not _positive_finite(amount):
        raise HTTPException(status_code=400, detail="amount must be a finite number greater than 0")
    direction = str(direction).upper()
    txn_id = client_txn_id.strip()
    return await _audited(
        request, user, "funds.transfer",
        {"direction": direction, "amount": amount, "quote_asset": quote_asset,
         "client_txn_id": txn_id},
        lambda: dma_client.transfer_funds(direction, amount, quote_asset, txn_id),
    )


# --------------------------------------------------------------------------
# DMA error handling
# --------------------------------------------------------------------------
def _upstream_error_message(detail) -> str:
    """Concise, browser-safe message for an upstream DMA error. A dict detail is
    the full upstream envelope — it can carry reflected params, request ids and
    internal diagnostics, so only its human message field is surfaced (the full
    detail is logged server-side by the callers). Shared by the HTTP handler and
    the WebSocket error frames so the two can never diverge in what they leak."""
    if isinstance(detail, dict):
        return (
            detail.get("retMsg")
            or detail.get("message")
            or detail.get("error")
            or "The exchange rejected the request"
        )
    return str(detail)


@app.exception_handler(dma_client.DMAError)
async def dma_error_handler(request: Request, exc: dma_client.DMAError):
    # Never let an UPSTREAM auth error (coinswitch 401/403 — e.g. a bad API
    # key) reach the browser as 401/403. Those codes have local meaning here:
    # the frontend treats 401 as "session expired" and would wrongly redirect
    # a logged-in user to /login. Remap upstream auth failures to 502 so they
    # are clearly "exchange rejected the request", not "you are logged out".
    status = exc.status
    if status in (401, 403):
        status = 502
    if isinstance(exc.detail, dict):
        logger.warning("upstream DMA error %s: %s", exc.status, exc.detail)
    return JSONResponse(status_code=status, content={"error": _upstream_error_message(exc.detail)})


@app.exception_handler(market_data.MarketDataError)
async def market_data_error_handler(request: Request, exc: market_data.MarketDataError):
    # Read-only public-data errors. Never remapped to 401/403 (those would make
    # the frontend think the session expired); validation failures are 400 and
    # upstream issues are 502, both safe for the browser to see.
    return JSONResponse(status_code=exc.status, content={"error": exc.detail})


# --------------------------------------------------------------------------
# WebSocket live feed — ONE shared poller, fanned out to every connected socket.
#
# Previously each connection ran its own build_dashboard loop, so N open tabs
# cost 3×N signed exchange reads per poll interval. All sockets receive the
# same account snapshot anyway (the feed carries no per-user data — both roles
# see identical positions/orders/balance), so one shared poll per interval
# serves any number of tabs at a constant upstream cost. The poller starts
# lazily with the first client and stops when the last one disconnects, so an
# idle deploy polls nothing — exactly like before.
# --------------------------------------------------------------------------
def _ws_origin_ok(websocket: WebSocket) -> bool:
    """Reject cross-origin WebSocket handshakes (defense in depth)."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # non-browser client; still needs a valid session cookie
    return urlparse(origin).netloc == websocket.headers.get("host", "")


# Connected sockets -> their session payload ({'u','r','sid'}), used for the
# per-cycle eviction check. Mutated only on the event loop (no locking needed).
_ws_clients: dict[WebSocket, dict] = {}
_ws_broadcast_task: asyncio.Task | None = None
# Last serialized frame + its monotonic stamp, replayed to a newly-connected
# socket so a fresh tab paints without waiting a full poll interval.
_ws_last_frame: tuple[float, str] | None = None
# A stalled send must not hold up the shared broadcast cycle indefinitely.
_WS_SEND_TIMEOUT_S = 10.0


# When the exchange rate-limits a build, sit out this many EXTRA poll periods
# before the next one — hammering a throttled API prolongs the throttle, and
# clients keep their last frame + staleness cue in the meantime.
_WS_RATE_LIMIT_EXTRA_CYCLES = 2


async def _ws_build_frame() -> tuple[str, float]:
    """One dashboard snapshot serialized once for every socket, plus extra
    cooldown seconds (0 normally; >0 after an upstream rate limit). Errors
    become a sanitized {'type':'error'} frame (the client keeps its last rows
    and flags the feed) — never internal exception text or the raw envelope."""
    cooldown = 0.0
    try:
        data = await build_dashboard()
    except dma_client.DMAError as exc:
        if isinstance(exc.detail, dict):
            logger.warning("upstream DMA error in ws feed: %s", exc.detail)
        if dma_client.is_rate_limit(exc):
            cooldown = settings.POLL_INTERVAL * _WS_RATE_LIMIT_EXTRA_CYCLES
            logger.warning("ws feed: upstream rate limit — backing off %.0fs extra", cooldown)
        data = {"type": "error", "error": _upstream_error_message(exc.detail)}
    except Exception:  # defensive: keep the feed alive
        logger.exception("dashboard build failed")
        data = {"type": "error", "error": "dashboard refresh failed"}
    # allow_nan=False turns the "invalid JSON the browser silently drops"
    # failure mode into a loud, caught-by-the-broadcaster exception; it cannot
    # fire in practice because build_dashboard strips non-finite floats.
    return json.dumps(data, allow_nan=False), cooldown


async def _ws_send_frame(websocket: WebSocket, user: dict, payload: str) -> None:
    """Deliver one frame to one socket; evict superseded sessions with 1008 so
    the tab redirects itself to /login. A dead/stalled socket is dropped rather
    than allowed to delay the next shared broadcast cycle."""
    if not auth.is_active_session(user.get("r"), user.get("sid")):
        _ws_clients.pop(websocket, None)
        try:
            await websocket.close(code=1008)
        except Exception:
            pass
        return
    try:
        await asyncio.wait_for(websocket.send_text(payload), _WS_SEND_TIMEOUT_S)
    except asyncio.CancelledError:
        raise
    except Exception:
        # Normal for an abruptly-closed tab (send after close raises RuntimeError,
        # not WebSocketDisconnect); the handler's receive() unregisters it too —
        # pop here as well so a stalled-but-open socket can't stall every cycle.
        _ws_clients.pop(websocket, None)
        try:
            await websocket.close()
        except Exception:
            pass


async def _ws_broadcaster() -> None:
    """Shared poll loop: one build_dashboard per POLL_INTERVAL, fanned out to all
    connected sockets in parallel. Exits when the last client disconnects (the
    next connection starts a fresh task)."""
    global _ws_last_frame
    while _ws_clients:
        # Per-iteration guard: this task is now the ONE feed for every open tab,
        # and nothing restarts it until a new connection arrives — so no cycle
        # failure, however unexpected, may be allowed to kill the loop.
        cooldown = 0.0
        try:
            payload, cooldown = await _ws_build_frame()
            _ws_last_frame = (time.monotonic(), payload)
            # Snapshot the registry: sends may evict entries while we iterate.
            await asyncio.gather(
                *(_ws_send_frame(ws, user, payload) for ws, user in list(_ws_clients.items())),
                return_exceptions=True,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ws broadcast cycle failed; feed continues next cycle")
        await asyncio.sleep(settings.POLL_INTERVAL + cooldown)


def _ensure_ws_broadcaster() -> None:
    """Start the shared poller if it isn't running. Registration happens before
    this call and only at await boundaries, so the loop's emptiness check can
    never miss a just-added client."""
    global _ws_broadcast_task
    if _ws_broadcast_task is None or _ws_broadcast_task.done():
        _ws_broadcast_task = asyncio.create_task(_ws_broadcaster())


@app.websocket("/ws")
async def ws_feed(websocket: WebSocket):
    if not _ws_origin_ok(websocket):
        await websocket.close(code=1008)
        return
    token = websocket.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    _ws_clients[websocket] = user
    _ensure_ws_broadcaster()
    # Fast first paint: replay the latest broadcast frame if it is still fresh.
    # (A brand-new broadcaster builds its first frame immediately, and the SPA
    # also GETs /api/dashboard on boot, so a stale replay is never needed.)
    if _ws_last_frame is not None and (
        time.monotonic() - _ws_last_frame[0] < settings.POLL_INTERVAL * 2
    ):
        try:
            await websocket.send_text(_ws_last_frame[1])
        except Exception:
            pass
    try:
        while True:
            # The browser never sends application data; this parks the handler
            # until the socket closes (client-side, or by the broadcaster on
            # eviction), at which point receive raises WebSocketDisconnect.
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
    except Exception:
        logger.exception("websocket receive loop error")
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        _ws_clients.pop(websocket, None)


class NoCacheStaticFiles(StaticFiles):
    """Serve static assets with Cache-Control: no-cache so browsers always
    revalidate. The server still returns 304 when the file is unchanged (cheap),
    but immediately after a deploy the browser fetches the new app.js/styles.css
    instead of pairing fresh HTML with a stale cached script.
    """

    def file_response(self, *args, **kwargs) -> StarletteResponse:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


# Static assets (css/js). Mounted last so it doesn't shadow API routes.
app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")
