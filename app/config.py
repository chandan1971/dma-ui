"""Runtime configuration, loaded entirely from environment variables.

Nothing secret is ever hard-coded here. On Railway these are set in the
service's "Variables" tab; locally they can be placed in a .env file (see
.env.example) which is loaded on import if present.
"""
import os
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader so local dev works without extra dependencies.

    Railway injects real env vars, so this is a no-op there.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # Do not override anything already present in the real environment.
        os.environ.setdefault(key, value)


_load_dotenv()


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        # Don't crash-loop the deploy on a typo'd env var; log-and-default.
        print(f"[config] invalid int for {name}={raw!r}; using default {default}")
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        print(f"[config] invalid float for {name}={raw!r}; using default {default}")
        return default
    return value if value > 0 else default


def _csv_env(name: str, default: list[str]) -> list[str]:
    """Parse a comma-separated env var into an upper-cased list, else default."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return list(default)
    items = [part.strip().upper() for part in raw.split(",") if part.strip()]
    return items or list(default)


def _notional_overrides(raw: str) -> dict[str, float]:
    """Parse "BTCUSDT=100,ETHUSDT=60" -> {"BTCUSDT": 100.0, ...}; bad or
    non-positive entries are skipped with a log line (never crash the boot)."""
    out: dict[str, float] = {}
    for part in (raw or "").split(","):
        if not part.strip():
            continue
        sym, _, amt = part.partition("=")
        try:
            value = float(amt)
        except ValueError:
            value = 0.0
        if sym.strip() and value > 0:
            out[sym.strip().upper()] = value
        else:
            print(f"[config] invalid STRATEGY_NOTIONAL_OVERRIDES entry {part!r}; ignored")
    return out


class Settings:
    def __init__(self) -> None:
        # --- CoinSwitch DMA credentials (NEVER hard-code) ---
        self.DMA_API_KEY: str = os.environ.get("DMA_API_KEY", "")
        self.DMA_API_SECRET: str = os.environ.get("DMA_API_SECRET", "")
        self.DMA_BASE_URL: str = os.environ.get(
            "DMA_BASE_URL", "https://dma.coinswitch.co"
        ).rstrip("/")

        # --- Frontend login credentials (two roles) ---
        self.ADMIN_USERNAME: str = os.environ.get("ADMIN_USERNAME", "")
        self.ADMIN_PASSWORD: str = os.environ.get("ADMIN_PASSWORD", "")
        self.VIEWER_USERNAME: str = os.environ.get("VIEWER_USERNAME", "")
        self.VIEWER_PASSWORD: str = os.environ.get("VIEWER_PASSWORD", "")

        # --- Session signing ---
        self.SESSION_SECRET: str = os.environ.get("SESSION_SECRET", "")

        # --- Trade token: a second secret that must accompany EVERY write
        # (order/cancel/leverage/transfer/etc). The admin types it into the
        # dashboard; it is sent per write request and checked here. Writes are
        # fail-closed: if this is unset, no write can happen. ---
        self.TRADE_TOKEN: str = os.environ.get("TRADE_TOKEN", "")
        # Session lifetime in seconds (default 12h).
        self.SESSION_MAX_AGE: int = _int_env("SESSION_MAX_AGE", 12 * 3600)

        # --- Trading / market defaults ---
        self.CATEGORY: str = os.environ.get("CATEGORY", "linear")
        self.SETTLE_COIN: str = os.environ.get("SETTLE_COIN", "USDT")
        self.ACCOUNT_TYPE: str = os.environ.get("ACCOUNT_TYPE", "UNIFIED")
        # USDT→INR rate for the dashboard's DISPLAY-ONLY currency lens. Served
        # to the frontend at login; nothing sent to the exchange ever uses it.
        # A fixed configured rate (not a live feed) is deliberate — the lens is
        # a mental-model aid, not an FX quote.
        self.INR_RATE: float = _float_env("INR_RATE", 94.0)
        # Attach a server-generated `orderLinkId` tag to every created order
        # (idempotency/forensics: after an ambiguous timeout, the maybe-placed
        # order can be found by its tag). OFF by default: it is a standard
        # Bybit-v5 field, but this gateway has deviated from stock v5 before —
        # place ONE small live order with this enabled to verify acceptance,
        # then leave it on.
        self.SEND_ORDER_LINK_ID: bool = (
            os.environ.get("SEND_ORDER_LINK_ID", "").strip().lower() in ("1", "true", "yes", "on")
        )

        # --- Live dashboard poll interval (seconds) ---
        # Floored at 1s: each poll is 3 signed exchange reads, so a typo'd
        # sub-second interval would hammer the venue (and its rate limits).
        self.POLL_INTERVAL: float = max(1.0, _float_env("POLL_INTERVAL", 5.0))

        # --- Number of TRUSTED reverse-proxy hops in front of the app ---
        # The client IP used for rate-limit bucketing is taken this many hops from
        # the RIGHT of X-Forwarded-For — i.e. the hop(s) your own proxies appended,
        # which a client cannot forge. Railway alone = 1 (default). If you put an
        # edge proxy in front (e.g. Cloudflare -> Railway), set this to 2 so the
        # real per-client IP is used; otherwise every client collapses into a
        # single shared bucket and one attacker could lock everyone out.
        self.TRUSTED_PROXY_HOPS: int = max(1, _int_env("TRUSTED_PROXY_HOPS", 1))

        # --- Public market-data for the dashboard charts (READ-ONLY) ---
        # A SEPARATE, unauthenticated host used ONLY for public OHLC candles.
        # It NEVER carries the DMA API key/secret and is isolated from the signed
        # trading client (see app/market_data.py). Default is Bybit's public v5
        # market API, which is shape-compatible with the DMA upstream.
        self.MARKET_DATA_BASE_URL: str = os.environ.get(
            "MARKET_DATA_BASE_URL", "https://api.bybit.com"
        ).rstrip("/")
        # Static allowlist of chart symbols that are ALWAYS servable, even when
        # the scanner is disabled or still warming up. When the scanner is
        # running, the kline proxy additionally accepts any symbol the scanner
        # has observed in the venue's live ticker universe — a bounded,
        # venue-real set — so every real market charts without env changes
        # while the proxy still can never relay an arbitrary string
        # (defence-in-depth against an open relay; see app/market_data.py).
        self.CHART_SYMBOLS: list[str] = _csv_env(
            "CHART_SYMBOLS", ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        )
        # Seconds to cache a kline response in-process. Coalesces the frontend
        # chart polling into at most one upstream call per (symbol, interval,
        # limit) per TTL, shielding the public API. Floored so a typo can't
        # disable the only upstream back-pressure.
        self.CHART_CACHE_TTL: float = max(0.5, _float_env("CHART_CACHE_TTL", 1.0))

        # --- Market Scanner sampler (READ-ONLY) ---
        # A background task (app/scanner.py) polls the full ticker list — ONE
        # signed read-only request per interval regardless of how many browser
        # tabs are open — and keeps a rolling in-memory history so the scanner
        # can compute 5m/15m/1h changes, volatility and funding drift honestly.
        # Floored at 5s: each sample is a full-universe upstream read, so a
        # typo'd sub-second interval must never hammer the venue.
        self.SCANNER_SAMPLE_INTERVAL: float = max(5.0, _float_env("SCANNER_SAMPLE_INTERVAL", 10.0))
        # Kill switch: SCANNER_ENABLED=0 starts no sampler and the scanner API
        # serves an empty (clearly-flagged) snapshot.
        self.SCANNER_ENABLED: bool = (
            os.environ.get("SCANNER_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
        )

        # --- Automated EMA-cross strategy (app/strategy.py + strategy_runner.py) ---
        # Two independent switches, both OFF by default:
        #   STRATEGY_ENABLED=1  run the 4h loop: compute indicators/signals on each
        #                       candle close and expose them at /api/strategy.
        #   STRATEGY_LIVE=1     additionally PLACE orders (limit entries, reduce-only
        #                       limit exits). Without it every intended order is
        #                       logged as a dry run and nothing is sent.
        self.STRATEGY_ENABLED: bool = (
            os.environ.get("STRATEGY_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
        )
        self.STRATEGY_LIVE: bool = (
            os.environ.get("STRATEGY_LIVE", "").strip().lower() in ("1", "true", "yes", "on")
        )
        self.STRATEGY_SYMBOLS: list[str] = _csv_env(
            "STRATEGY_SYMBOLS", ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        )
        # Fixed notional per trade per coin (settle coin), at STRATEGY_LEVERAGE.
        self.STRATEGY_NOTIONAL: float = _float_env("STRATEGY_NOTIONAL", 50.0)
        # Per-symbol override "SYM=amount,SYM=amount" (e.g. BTC's 0.001 minimum
        # lot is worth more than the default notional).
        self.STRATEGY_NOTIONAL_OVERRIDES: dict[str, float] = _notional_overrides(
            os.environ.get("STRATEGY_NOTIONAL_OVERRIDES", "BTCUSDT=100")
        )
        self.STRATEGY_LEVERAGE: int = max(1, _int_env("STRATEGY_LEVERAGE", 1))
        # Seconds after each 4h boundary before reading candles, so the venue has
        # rolled the bar. The runner still verifies the bar actually closed.
        self.STRATEGY_CLOSE_DELAY: float = _float_env("STRATEGY_CLOSE_DELAY", 10.0)

        # --- Overall unrealised-PnL tracker (READ-ONLY; needs Redis) ---
        # A background task (app/upnl.py) samples the account's total
        # unrealised PnL — ONE signed read-only positions request per interval
        # regardless of open browser tabs — and persists the series in Redis
        # (Railway's Redis service). OFF unless REDIS_URL is set; the PnL tab
        # then shows a clear "not configured" state. Retention is budgeted for
        # Railway's 500 MB Redis cap (see app/upnl.py's docstring math).
        self.REDIS_URL: str = os.environ.get("REDIS_URL", "")
        # Floored at 2s: each sample is a signed exchange read, so a typo'd
        # sub-second interval must never hammer the venue.
        self.UPNL_SAMPLE_INTERVAL: float = max(2.0, _float_env("UPNL_SAMPLE_INTERVAL", 5.0))
        # Kill switch: UPNL_ENABLED=0 starts no sampler even with REDIS_URL set.
        self.UPNL_ENABLED: bool = (
            os.environ.get("UPNL_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
        )

        # --- Execution alerts via Telegram (READ-ONLY, opt-in) ---
        # A background watcher (app/notifier.py) polls the account's executions
        # and pushes a Telegram message on each fill / TP-SL / liquidation. It is
        # read-only (cannot trade) and OFF unless BOTH values below are set.
        # Token/chat are secrets — set them as env vars, never in code.
        self.TELEGRAM_BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.TELEGRAM_CHAT_ID: str = os.environ.get("TELEGRAM_CHAT_ID", "")
        # How often the watcher polls executions (seconds) and how many recent
        # executions to scan each poll.
        self.NOTIFY_POLL_INTERVAL: float = max(5.0, _float_env("NOTIFY_POLL_INTERVAL", 10.0))
        self.NOTIFY_EXEC_LIMIT: int = max(1, _int_env("NOTIFY_EXEC_LIMIT", 50))
        # Realized-PnL alerts show an INR figure alongside the settle-coin value
        # using this FIXED conversion rate (INR = value * rate). Display-only —
        # nothing trades or settles in INR. Set to 0 to hide the INR figure.
        self.USDT_INR_RATE: float = _float_env("USDT_INR_RATE", 94.0)

        # --- MongoDB history store (trades & closed PnL) ---
        # A background sync (app/history_sync.py, every SYNC_INTERVAL_SECONDS —
        # default one minute) mirrors the account's executions and closed-PnL
        # from the exchange into MongoDB; the dashboard's history endpoints
        # read ONLY from Mongo (app/db.py). Credentials go in
        # separate vars (not the URI) so passwords never need URL-escaping. The TLS
        # CA is a FILE PATH on disk — the cert itself must never be committed.
        self.MONGO_URI: str = os.environ.get("MONGO_URI", "")
        self.MONGO_USERNAME: str = os.environ.get("MONGO_USERNAME", "")
        self.MONGO_PASSWORD: str = os.environ.get("MONGO_PASSWORD", "")
        self.MONGO_DB_NAME: str = os.environ.get("MONGO_DB_NAME", "DMA-trading")
        self.MONGO_TLS_CA_FILE: str = os.environ.get("MONGO_TLS_CA_FILE", "")
        # Alternative to MONGO_TLS_CA_FILE for hosts with no file on disk
        # (e.g. Railway): paste the CA certificate CONTENT (PEM text — a .crt
        # with "-----BEGIN CERTIFICATE-----" is the same format) and app/db.py
        # materialises it into a runtime temp file. Set exactly ONE of the two.
        # A CA certificate is public material, so an env var is safe for it.
        self.MONGO_TLS_CA_PEM: str = os.environ.get("MONGO_TLS_CA_PEM", "")
        # How often the history sync runs (seconds; default one minute) and how
        # far back a cold-start backfill reaches (days).
        self.SYNC_INTERVAL_SECONDS: float = max(10.0, _float_env("SYNC_INTERVAL_SECONDS", 60.0))
        self.SYNC_BACKFILL_DAYS: int = max(1, _int_env("SYNC_BACKFILL_DAYS", 730))

        # --- AI intelligence layer (READ-ONLY analysis; optional) ---
        # Which LLM provider backs the AI coach: mock (default — deterministic
        # rule-based analysis, no key, no network), claude, openai, local
        # (any OpenAI-compatible endpoint, e.g. Ollama/vLLM via AI_BASE_URL),
        # or gemini. The rest of the app never knows which one is active; the
        # AI layer is read-only by construction (it can never reach a trade
        # write) and only ever sends the sanitized serializations built in
        # app/ai_context.py — never credentials, secrets or cookies.
        self.AI_PROVIDER: str = os.environ.get("AI_PROVIDER", "mock").strip().lower()
        self.AI_API_KEY: str = os.environ.get("AI_API_KEY", "")
        # Model id for the chosen provider ("" = the provider's default).
        self.AI_MODEL: str = os.environ.get("AI_MODEL", "").strip()
        # Override the provider's API base URL (required for provider=local).
        self.AI_BASE_URL: str = os.environ.get("AI_BASE_URL", "").rstrip("/")
        self.AI_MAX_TOKENS: int = max(256, _int_env("AI_MAX_TOKENS", 2048))
        self.AI_TIMEOUT_S: float = max(10.0, _float_env("AI_TIMEOUT_S", 120.0))
        # Cost guardrail: LLM-invoking endpoints are capped at this many calls
        # per minute across the whole process (429 above it).
        self.AI_CALLS_PER_MIN: int = max(1, _int_env("AI_CALLS_PER_MIN", 6))
        # How long a generated briefing/session review stays cached when the
        # underlying data has not changed (seconds).
        self.AI_CACHE_TTL_S: float = max(0.0, _float_env("AI_CACHE_TTL_S", 600.0))

    def missing_required(self) -> list[str]:
        """Return the names of required vars that are not set."""
        required = {
            "DMA_API_KEY": self.DMA_API_KEY,
            "DMA_API_SECRET": self.DMA_API_SECRET,
            "ADMIN_USERNAME": self.ADMIN_USERNAME,
            "ADMIN_PASSWORD": self.ADMIN_PASSWORD,
            "VIEWER_USERNAME": self.VIEWER_USERNAME,
            "VIEWER_PASSWORD": self.VIEWER_PASSWORD,
            "SESSION_SECRET": self.SESSION_SECRET,
            "TRADE_TOKEN": self.TRADE_TOKEN,
            "MONGO_URI": self.MONGO_URI,
        }
        missing = [name for name, value in required.items() if not value]
        # Mongo credentials may live inside MONGO_URI (both vars empty) or in the
        # dedicated pair — but setting exactly ONE of the pair is always a mistake.
        if bool(self.MONGO_USERNAME) != bool(self.MONGO_PASSWORD):
            missing.append("MONGO_PASSWORD" if self.MONGO_USERNAME else "MONGO_USERNAME")
        return missing

    def insecure_required(self) -> list[str]:
        """Return human-readable problems with WEAK/PLACEHOLDER secrets.

        Money app: refusing to boot on a copy-pasted .env.example value is much
        safer than serving a forgeable session (a known SESSION_SECRET lets anyone
        mint an admin cookie) or a guessable password/trade token. This is a
        HARD-FAIL companion to missing_required(); callers should refuse to start
        if it returns anything. Length is only WARNED on (see warn_weak) so a real,
        already-deployed short secret is never crash-looped.
        """
        # Verbatim placeholders shipped in .env.example + a few obvious weak values.
        placeholders = {
            "change_this_admin_password",
            "change_this_viewer_password",
            "change_this_mongo_password",
            "generate_a_long_random_string",
            "generate_another_long_random_string",
            "changeme", "change_this", "password", "secret", "token",
            "admin", "viewer", "user", "trader", "test",
        }
        problems: list[str] = []
        for name, value in (
            ("ADMIN_PASSWORD", self.ADMIN_PASSWORD),
            ("VIEWER_PASSWORD", self.VIEWER_PASSWORD),
            ("SESSION_SECRET", self.SESSION_SECRET),
            ("TRADE_TOKEN", self.TRADE_TOKEN),
            ("MONGO_PASSWORD", self.MONGO_PASSWORD),
        ):
            if value and value.strip().lower() in placeholders:
                problems.append(f"{name} is set to a placeholder/weak value; use a unique high-entropy secret")
        return problems

    def warn_weak(self) -> list[str]:
        """Non-fatal warnings for low-entropy secrets (short length). Kept separate
        from insecure_required so a real-but-short secret warns instead of blocking
        an existing deploy."""
        warnings: list[str] = []
        for name, value in (("SESSION_SECRET", self.SESSION_SECRET), ("TRADE_TOKEN", self.TRADE_TOKEN)):
            if value and len(value) < 24:
                warnings.append(f"{name} is short (<24 chars); prefer a 32+ char random secret")
        return warnings


settings = Settings()
