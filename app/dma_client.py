"""Thin async client for the CoinSwitch DMA API.

Every call is signed server-side with the Ed25519 key from the environment;
the API key/secret never leave the backend. Convenience wrappers cover the
endpoints used by the dashboard and the trading panel.
"""
import asyncio
import json
import logging
import time
import uuid

import httpx

from .config import settings
from .signer import build_signed_request

logger = logging.getLogger(__name__)


class DMAError(Exception):
    """Raised when the exchange returns an error or is unreachable.

    `ret_code` is the v5 business code (e.g. 10006 = rate limit) when the
    failure was an HTTP-200-with-nonzero-retCode rejection, else None. Callers
    classify retryability/rate-limiting on this NUMBER first — message-string
    sniffing is only the fallback for codes we haven't mapped."""

    def __init__(self, status: int, detail, ret_code: int | None = None):
        self.status = status
        self.detail = detail
        self.ret_code = ret_code
        super().__init__(f"DMA error {status}: {detail}")


# v5 business codes that a retry can plausibly fix: 10006/10018 are rate
# limits, 10016 is Bybit's transient "server error".
_RATE_LIMIT_RET_CODES = frozenset({10006, 10018})
RETRYABLE_RET_CODES = frozenset({10006, 10016, 10018})


def is_rate_limit(exc: Exception) -> bool:
    """True when `exc` is the exchange telling us to SLOW DOWN — pollers back
    off extra instead of hammering a throttled API (which extends the ban)."""
    if not isinstance(exc, DMAError):
        return False
    if exc.status == 429 or exc.ret_code in _RATE_LIMIT_RET_CODES:
        return True
    detail = str(exc.detail).lower()
    # "too frequent" is the gateway's hard-ban copy ("Access too frequent.
    # Please try again in 5 minutes.", HTTP 403) — the one shape that most
    # needs the back-off, and the one this check silently missed for weeks.
    return "too many" in detail or "rate limit" in detail or "too frequent" in detail


# One shared async client reused across all calls (connection pooling / keep-alive)
# instead of a new client + TLS handshake per request. Closed on app shutdown.
# trust_env=False: ignore ambient HTTP(S)_PROXY / SSL_CERT_FILE env vars so a
# misconfigured or hostile environment can't reroute or re-anchor the SIGNED
# trading traffic through a proxy/MITM.
_client = httpx.AsyncClient(timeout=20, trust_env=False)


async def aclose() -> None:
    await _client.aclose()


async def _request(method: str, path: str, params: dict | None = None, body: dict | None = None):
    if not settings.DMA_API_SECRET or not settings.DMA_API_KEY:
        raise DMAError(500, "DMA_API_KEY / DMA_API_SECRET are not configured")

    signature, epoch, full_path = build_signed_request(
        method, path, settings.DMA_API_SECRET, params
    )
    url = settings.DMA_BASE_URL + full_path
    headers = {
        "Content-Type": "application/json",
        "X-AUTH-SIGNATURE": signature,
        "X-AUTH-APIKEY": settings.DMA_API_KEY,
        "X-AUTH-EPOCH": epoch,
    }

    try:
        if method.upper() == "GET":
            resp = await _client.get(url, headers=headers)
        else:
            # Body is sent compact and is NOT part of the signature.
            # allow_nan=False: refuse to serialise NaN/Infinity (invalid JSON that
            # some parsers coerce to huge/zero numbers) into a money request — a
            # last-ditch guard behind the per-endpoint finite-number validation.
            try:
                content = json.dumps(body or {}, separators=(",", ":"), allow_nan=False)
            except ValueError as exc:
                raise DMAError(400, "request body contains a non-finite number") from exc
            resp = await _client.post(url, headers=headers, content=content)
    except httpx.HTTPError as exc:
        raise DMAError(502, f"upstream request failed: {exc}") from exc

    try:
        data = resp.json()
    except ValueError:
        data = {"raw": resp.text}

    if resp.status_code >= 400:
        raise DMAError(resp.status_code, data)

    # CRITICAL for a money app: the v5 DMA/Bybit API returns HTTP 200 with a
    # non-zero `retCode` for business-level rejections (insufficient balance,
    # qty below min, reduce-only would increase, position-idx mismatch, etc.).
    # Without this check those would be reported to the user as SUCCESS. We
    # only treat an EXPLICIT non-zero retCode as an error, so endpoints that
    # use a different envelope (e.g. the funds-transfer path) are unaffected.
    if isinstance(data, dict):
        ret_code = data.get("retCode")
        if ret_code not in (None, 0, "0"):
            detail = data.get("retMsg") or data
            try:
                code = int(ret_code)
            except (TypeError, ValueError):
                code = None
            raise DMAError(400, detail, ret_code=code)
    return data


def extract_list(payload) -> list:
    """Dig the v5 `result.list` array out of a response envelope, else []."""
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, dict) and isinstance(result.get("list"), list):
            return result["list"]
    return []


# --- Read endpoints -------------------------------------------------------

async def get_positions():
    return await _request(
        "GET",
        "/v5/position/list",
        params={"category": settings.CATEGORY, "settleCoin": settings.SETTLE_COIN},
    )


async def get_position_by_symbol(symbol: str):
    """Position record for ONE symbol. Unlike get_positions (settleCoin-scoped —
    only coins you currently hold), a symbol-scoped query returns the record
    including the current `leverage` even when size is 0. This is the source of
    truth for a coin's set leverage BEFORE any position exists."""
    return await _request(
        "GET",
        "/v5/position/list",
        params={"category": settings.CATEGORY, "symbol": symbol},
    )


async def get_open_orders():
    return await _request(
        "GET",
        "/v5/order/realtime",
        params={
            "category": settings.CATEGORY,
            "settleCoin": settings.SETTLE_COIN,
            "limit": "50",
        },
    )


async def get_wallet_balance():
    return await _request(
        "GET",
        "/v5/account/wallet-balance",
        params={"accountType": settings.ACCOUNT_TYPE, "coin": settings.SETTLE_COIN},
    )


async def get_instruments(symbol: str | None = None):
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    return await _request("GET", "/v5/market/instruments-info", params=params)


# --- Windowed history (closed-PnL & executions): cursor-free, time-windowed ---
# A single closed-pnl / execution-list query is capped at 100 records AND at a
# 7-day span (endTime - startTime <= 7d), and with NO time range the gateway
# returns only the last 7 days. To give the dashboard a full month we walk the
# range as a few <=7-day windows (startTime/endTime in epoch-ms) and merge pages.
#
# We deliberately do NOT use cursor pagination. The gateway returns a
# percent-encoded `nextPageCursor`; our signer would urlencode it (re-encoding
# the `%` -> `%25`) yet sign the unquote_plus'd form (decoding one level), so the
# SIGNED and SENT cursor differ -> HTTP 401 "Invalid signature". That mismatch is
# exactly what sank the earlier history-pagination attempt. A window that hits the
# 100-record cap is instead subdivided by TIME, which needs no cursor at all.
_HISTORY_PAGE_LIMIT = 100                     # gateway hard cap per page
_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000  # gateway rule: endTime - startTime <= 7d
_HISTORY_MIN_WINDOW_MS = 60 * 60 * 1000       # stop bisecting below 1h (density backstop)
_HISTORY_MAX_REQUESTS = 60                    # total upstream GETs per fetch (backstop)
_HISTORY_DEFAULT_DAYS = 30
_HISTORY_MAX_DAYS = 31                        # hard cap: never look back past ~1 month


def new_history_state(
    *,
    max_requests: int = _HISTORY_MAX_REQUESTS,
    min_window_ms: int = _HISTORY_MIN_WINDOW_MS,
    pace_s: float = 0.0,
    page_limit: int = _HISTORY_PAGE_LIMIT,
) -> dict:
    """Shared per-fetch state for the windowed history machinery. The defaults
    reproduce the interactive dashboard behaviour; the background sync passes a
    bigger request budget, a finer minimum window and a pacing delay. Two flags
    distinguish WHY coverage stopped short, because the sync must react in
    opposite ways ("truncated at all" is their OR — see _paginate_history):
      - budget_exhausted: transient — a fresh run's budget can finish the job,
        so the sync stops its run and resumes later;
      - density_truncated: permanent — a <=min-window span still saturates the
        page cap, so retrying can never help and the sync must move on."""
    return {
        "requests": 0,
        "category": None,
        "budget_exhausted": False,
        "density_truncated": False,
        "max_requests": max_requests,
        "min_window_ms": min_window_ms,
        "pace_s": pace_s,
        # Per-endpoint page cap: saturation (= "a page came back full, so more
        # may exist") must be detected against the limit actually REQUESTED —
        # probing a 50-capped endpoint with limit=100 would make a full
        # 50-record page look complete and silently drop everything past it.
        "page_limit": page_limit,
    }


def _to_int_ms(value) -> int:
    """Parse a millisecond-timestamp-ish value to int, else 0 (sorts oldest).
    Tolerates decimal formatting ("1699999999999.0") by truncating: this value
    is also the STORED range/index key in MongoDB (app/history_sync.py), where
    a 0 would make a real fill invisible to every dashboard read."""
    try:
        if value in (None, ""):
            return 0
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError, OverflowError):
            return 0


def _time_windows(start_ms: int, end_ms: int) -> list[tuple[int, int]]:
    """Non-overlapping (w_start, w_end) pairs covering [start_ms, end_ms], each
    spanning at most 7 days, NEWEST-first. Consecutive windows never overlap
    (next start = prev end + 1) so a boundary record can't be fetched twice."""
    windows: list[tuple[int, int]] = []
    w_start = start_ms
    while w_start <= end_ms:
        w_end = min(w_start + _HISTORY_WINDOW_MS, end_ms)
        windows.append((w_start, w_end))
        if w_end >= end_ms:
            break
        w_start = w_end + 1
    windows.reverse()  # newest window first (most decision-relevant)
    return windows


async def _fetch_time_range(path: str, base_params: dict, start_ms: int, end_ms: int, state: dict) -> list:
    """Return every record from `path` in [start_ms, end_ms]. If a query saturates
    (returns the full page limit, so more may exist), bisect the range by TIME and
    refetch each half — completeness without cursor pagination. `state` (see
    new_history_state) carries the shared request budget, minimum window span,
    optional pacing delay, the discovered `category`, and the truncation flags set
    if a backstop prevents full coverage."""
    if state["requests"] >= state["max_requests"]:
        state["budget_exhausted"] = True
        return []

    params = dict(base_params)
    params["limit"] = str(state["page_limit"])
    params["startTime"] = str(start_ms)
    params["endTime"] = str(end_ms)
    payload = await _request("GET", path, params=params)
    state["requests"] += 1
    if state["pace_s"]:
        # Background sync: spread upstream calls out instead of bursting.
        await asyncio.sleep(state["pace_s"])

    if state["category"] is None and isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, dict):
            state["category"] = result.get("category")

    records = extract_list(payload)
    if len(records) < state["page_limit"]:
        return records  # whole window fit in one page

    # Saturated: there may be more records than one page can show. Split the
    # window in half by time and refetch — the two halves fully tile this range,
    # so we DISCARD this capped page and use the sub-windows' results instead.
    span = end_ms - start_ms
    if span <= state["min_window_ms"]:
        state["density_truncated"] = True  # too dense to split further without a cursor
        return records
    mid = start_ms + span // 2
    # Left half strictly BEFORE right half: the background sync's crash-safety
    # relies on any interrupted fetch having covered a contiguous ASCENDING
    # time-prefix of the range (see app/history_sync.py). Do not reorder.
    left = await _fetch_time_range(path, base_params, start_ms, mid, state)
    right = await _fetch_time_range(path, base_params, mid + 1, end_ms, state)
    return left + right


async def _paginate_history(path, base_params, days, dedup_key, time_key, label):
    """Walk the last `days` days (clamped 1..31) of `path` as merged <=7-day windows
    and return a synthesized v5 envelope
    {"retCode":0,"result":{"list":[...],"category":...,"truncated":bool}} so the
    dashboard's existing renderers work unchanged. `dedup_key(record)` yields a
    hashable identity (or None to keep unconditionally); `time_key(record)` yields
    the ms used for the newest-first sort; `label` names the endpoint in the
    truncation log. `list` is newest-first, matching a single-page response."""
    lookback_days = max(1, min(int(days or _HISTORY_DEFAULT_DAYS), _HISTORY_MAX_DAYS))
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - lookback_days * 24 * 60 * 60 * 1000
    state = new_history_state()

    records: list = []
    for w_start, w_end in _time_windows(start_ms, now_ms):
        records.extend(await _fetch_time_range(path, base_params, w_start, w_end, state))

    # Dedup safety net: windows/bisections are non-overlapping, so this only guards
    # against a boundary record surfacing twice; it must NEVER merge two DISTINCT
    # records — hence per-endpoint keys (closing orderId+updatedTime for closed-pnl,
    # the globally unique execId for executions). Records without a key are kept.
    seen: set = set()
    deduped: list = []
    for record in records:
        key = dedup_key(record) if isinstance(record, dict) else None
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        deduped.append(record)

    deduped.sort(key=lambda r: time_key(r) if isinstance(r, dict) else 0, reverse=True)

    truncated = state["budget_exhausted"] or state["density_truncated"]
    if truncated:
        logger.warning(
            "%s backfill truncated for %s over %dd: kept %d records in %d requests "
            "(caps: %d requests / %.0fh min window)",
            label, base_params.get("symbol", "ALL"), lookback_days, len(deduped),
            state["requests"], _HISTORY_MAX_REQUESTS, _HISTORY_MIN_WINDOW_MS / 3_600_000,
        )

    result: dict = {"list": deduped, "truncated": truncated}
    if state["category"] is not None:
        result["category"] = state["category"]
    return {"retCode": 0, "retMsg": "OK", "result": result}


def _closed_pnl_dedup_key(record: dict):
    """Dedup identity for a closed-pnl record: closing orderId + updatedTime. None
    keeps the record unconditionally. Must never merge two distinct closes."""
    oid, upd = record.get("orderId"), record.get("updatedTime")
    return (oid, upd) if (oid is not None or upd is not None) else None


async def get_closed_pnl(symbol: str | None = None, days: int | None = None):
    """Closed PnL over the last `days` days (default 30), merged from several
    <=7-day windows so the dashboard sees a full month instead of just the
    gateway's default last-7-days page (see the notes above on why this is
    windowed-by-time rather than cursor-paginated). Newest-first; `truncated` is
    set only if a safety backstop stopped short of full coverage, and the UI
    surfaces it so a partial total is never shown as complete."""
    base_params = {"category": settings.CATEGORY}
    if symbol:
        base_params["symbol"] = symbol
    return await _paginate_history(
        "/v5/position/closed-pnl", base_params, days,
        dedup_key=_closed_pnl_dedup_key,
        time_key=lambda r: _to_int_ms(r.get("updatedTime") or r.get("createdTime")),
        label="closed-pnl",
    )


async def get_withdrawable(coin: str | None = None):
    return await _request(
        "GET",
        "/v5/account/withdrawal",
        params={"coinName": coin or settings.SETTLE_COIN},
    )


async def get_executions(
    symbol: str | None = None,
    limit: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
):
    """Trades / execution history."""
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    if limit:
        params["limit"] = str(limit)
    if start_time:
        params["startTime"] = str(start_time)
    if end_time:
        params["endTime"] = str(end_time)
    return await _request("GET", "/v5/execution/list", params=params)


async def get_executions_history(symbol: str | None = None, days: int | None = None):
    """Executions/fills over the last `days` days (default 30), merged from several
    <=7-day windows so the History tab's fees / maker-taker analytics cover the SAME
    period as closed PnL. Kept SEPARATE from get_executions (which stays a single
    recent-fills call for the Telegram notifier and the API Explorer, so neither
    fans out). Dedups on the globally unique execId — NEVER on orderId, since one
    order legitimately produces many fills that must all be counted."""
    base_params = {"category": settings.CATEGORY}
    if symbol:
        base_params["symbol"] = symbol
    return await _paginate_history(
        "/v5/execution/list", base_params, days,
        dedup_key=lambda r: r.get("execId"),
        time_key=lambda r: _to_int_ms(r.get("execTime")),
        label="executions",
    )


# --- Window primitives for the background history sync (app/history_sync.py) ---
# Account-wide (no symbol filter — the dashboard filters at read time from
# MongoDB) and raw: they return the records of ONE <=7-day window, leaving
# window-walking, retries and persistence to the sync service. `state` comes
# from new_history_state so the sync controls budget / min window / pacing and
# reads back the budget_exhausted / density_truncated flags. Cursor-free like
# everything above.

async def get_executions_window(start_ms: int, end_ms: int, state: dict) -> list:
    return await _fetch_time_range(
        "/v5/execution/list", {"category": settings.CATEGORY}, start_ms, end_ms, state
    )


async def get_closed_pnl_window(start_ms: int, end_ms: int, state: dict) -> list:
    return await _fetch_time_range(
        "/v5/position/closed-pnl", {"category": settings.CATEGORY}, start_ms, end_ms, state
    )


# The v5 transaction log caps a page at 50 records — HALF the 100-record cap of
# executions/closed-pnl — so its windows must be fetched with page_limit=50 (see
# new_history_state) or a full 50-record page would pass as unsaturated.
TXN_PAGE_LIMIT = 50


async def get_transaction_log_window(start_ms: int, end_ms: int, state: dict) -> list:
    """One <=7-day window of the account transaction log — the ledger behind
    every balance change (trades, trading fees, funding, transfers,
    settlements). This endpoint is NOT in the DMA Postman collection: whether
    the gateway proxies it is unknown until the first live call, so the
    history sync probes it and disables the mirror on a 404 (see
    app/history_sync.py); /healthz reports the probe's verdict."""
    return await _fetch_time_range(
        "/v5/account/transaction-log",
        {"accountType": settings.ACCOUNT_TYPE, "category": settings.CATEGORY},
        start_ms, end_ms, state,
    )


async def get_account_info():
    return await _request("GET", "/v5/account/info")


async def get_server_time():
    return await _request("GET", "/v5/market/time")


async def get_tickers(symbol: str | None = None):
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    return await _request("GET", "/v5/market/tickers", params=params)


async def get_orderbook(symbol: str, limit: str | None = None):
    params = {"category": settings.CATEGORY, "symbol": symbol}
    if limit:
        params["limit"] = str(limit)
    return await _request("GET", "/v5/market/orderbook", params=params)


# --- Write endpoints (admin only at the route layer) ----------------------

async def create_order(body: dict):
    payload = {"category": settings.CATEGORY, **body}
    return await _request("POST", "/v5/order/create", body=payload)


async def cancel_order(symbol: str, order_id: str):
    body = {"category": settings.CATEGORY, "symbol": symbol, "orderId": order_id}
    return await _request("POST", "/v5/order/cancel", body=body)


async def cancel_all(symbol: str | None = None):
    body = {"category": settings.CATEGORY, "settleCoin": settings.SETTLE_COIN}
    if symbol:
        body["symbol"] = symbol
    return await _request("POST", "/v5/order/cancel-all", body=body)


async def set_leverage(symbol: str, buy_leverage: str, sell_leverage: str):
    body = {
        "category": settings.CATEGORY,
        "symbol": symbol,
        "buyLeverage": str(buy_leverage),
        "sellLeverage": str(sell_leverage),
    }
    return await _request("POST", "/v5/position/set-leverage", body=body)


async def set_margin_mode(mode: str):
    return await _request(
        "POST", "/v5/account/set-margin-mode", body={"setMarginMode": mode}
    )


async def set_trading_stop(body: dict):
    """Passthrough to /v5/position/trading-stop (set/cancel TP/SL).

    This is a thin passthrough; the route layer owns the policy (tpslMode,
    re-derived positionIdx, validated takeProfit/stopLoss where "0" cancels)
    and builds the body. `category` is injected here.
    """
    payload = {"category": settings.CATEGORY, **body}
    return await _request("POST", "/v5/position/trading-stop", body=payload)


async def transfer_funds(direction: str, amount, quote_asset: str, client_txn_id: str | None = None):
    body = {
        "client_txn_id": client_txn_id or str(uuid.uuid4()),
        "direction": direction,
        "amount": amount,
        "quote_asset": quote_asset,
    }
    data = await _request("POST", "/dma/api/v1/funds/transfer", body=body)
    # This endpoint uses a non-v5 envelope (no retCode), so _request can't
    # auto-detect a business rejection. Money-path rule: only a POSITIVELY
    # CONFIRMED transfer may be reported as success; everything else raises so the
    # operator verifies rather than trusting a false "done". A confirmed real
    # response looks like:
    #   {"data": {..., "txn_id": "<uuid>"}, "message": "transfer successful"}
    # so the exchange-assigned txn_id is the reliable success signal (a declined
    # transfer gets none). client_txn_id idempotency makes a retry-after-error safe.
    if not isinstance(data, dict):
        raise DMAError(502, "unexpected transfer response from the exchange")

    inner = data.get("data") if isinstance(data.get("data"), dict) else {}
    message = str(data.get("message") or data.get("retMsg") or "").strip()

    # 1) Explicit failure -> raise. Substring STEMS (not exact words) over the
    #    message + any status field, so novel declines (denied, insufficient_balance,
    #    "transfer unsuccessful", processing_failed, …) are caught. "unsuccess" is
    #    listed so an "...unsuccessful" message can never fall through to the
    #    "success" allowlist below.
    if data.get("success") is False or data.get("error"):
        raise DMAError(400, data.get("error") or message or data)
    _FAIL_STEMS = (
        "fail", "error", "reject", "declin", "cancel",
        "denied", "insufficient", "invalid", "refus", "unsuccess",
    )
    haystack = " ".join(
        str(x) for x in (message, data.get("status", ""), inner.get("status", ""))
    ).lower()
    if any(stem in haystack for stem in _FAIL_STEMS):
        raise DMAError(400, message or data)

    # 2) POSITIVE confirmation (allowlist): an exchange-assigned txn_id, or an
    #    explicit boolean success. Only these are reported to the operator as done.
    txn_id = inner.get("txn_id") or inner.get("txnId") or data.get("txn_id")
    if txn_id not in (None, "") or data.get("success") is True:
        return data

    # 3) Neither confirmed nor an explicit failure -> INDETERMINATE. Never assert a
    #    money move we can't confirm; make the operator check (retry is idempotent).
    raise DMAError(502, "transfer status could not be confirmed — check your balance before retrying")
