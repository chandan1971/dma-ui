"""Read-only public market-data client for the dashboard candlestick charts.

ISOLATION / SAFETY
==================
This module is deliberately SEPARATE from `dma_client` and the signed trading
path. It talks ONLY to a public market-data host (Bybit v5, no authentication),
carries NO API key or secret, and performs NO request signing. It therefore
cannot place, cancel, or read account / funds data — it serves public OHLC
candles only. There is no write capability anywhere in this file.

Abuse / SSRF protection: the route layer requires a logged-in session, and the
symbol + interval are validated server-side BEFORE any upstream call. A symbol
is allowed only if it is on the static CHART_SYMBOLS allowlist OR is a symbol
the market scanner has actually observed in the venue's live ticker universe
(a bounded, venue-authoritative set — never an arbitrary string). The upstream
URL/host is fixed from configuration and only the (validated) symbol/interval/
limit vary — so this proxy can never be coerced into fetching an arbitrary URL
or market.
"""
import asyncio
import time

import httpx

from . import scanner
from .config import settings


class MarketDataError(Exception):
    """Raised when the public market-data upstream errors or input is rejected."""

    def __init__(self, status: int, detail):
        self.status = status
        self.detail = detail
        super().__init__(f"market-data error {status}: {detail}")


# UI interval label / Bybit code -> Bybit v5 kline `interval`. Anything not in
# this map is rejected; arbitrary intervals are never passed through.
_INTERVALS = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "4h": "240", "1d": "D",
    "1": "1", "3": "3", "5": "5", "15": "15", "30": "30",
    "60": "60", "240": "240", "d": "D",
}

_DEFAULT_LIMIT = 200
_MAX_LIMIT = 1000
# `limit` is snapped UP to this small fixed ladder before it becomes part of the
# cache key. This bounds the key cardinality so an authenticated caller cannot
# explode the cache (or trip its size-cap clear) by sweeping limit=1..1000 — the
# cache is the only upstream back-pressure, so its key space must stay bounded.
_LIMIT_BUCKETS = (60, 160, 200, 500, 1000)

# Dedicated client for the PUBLIC host. No auth headers are EVER attached here.
# trust_env=False for parity with the signed client (ignore ambient proxy/CA env).
_client = httpx.AsyncClient(timeout=10, trust_env=False)

# Tiny in-process response cache to coalesce the ~1s frontend polling and shield
# the upstream public API. Keyed by (symbol, bybit_interval, limit_bucket). The
# per-key lock provides single-flight: concurrent same-key misses await one
# upstream call rather than each firing their own.
_cache: dict[tuple, tuple[float, dict]] = {}
_locks: dict[tuple, asyncio.Lock] = {}


async def aclose() -> None:
    """Close the shared client on app shutdown (called from the lifespan hook)."""
    await _client.aclose()


def _validate(symbol: str, interval: str) -> tuple[str, str]:
    """Validate the symbol + interval. Raises MarketDataError(400) on anything
    not explicitly allowed. A symbol passes if it is on the static
    CHART_SYMBOLS allowlist OR the scanner has observed it in the venue's live
    ticker universe — both are bounded, venue-real sets, so this remains the
    SSRF/abuse guard (never an arbitrary passthrough)."""
    sym = (symbol or "").strip().upper()
    if sym not in set(settings.CHART_SYMBOLS) and not scanner.is_known_symbol(sym):
        raise MarketDataError(400, "symbol not allowed for charts")
    raw = (interval or "").strip()
    code = _INTERVALS.get(raw.lower()) or _INTERVALS.get(raw)
    if not code:
        raise MarketDataError(400, "interval not allowed for charts")
    return sym, code


def _bucket_limit(limit) -> int:
    """Snap the requested limit UP to the next allowed bucket (capped at the
    upstream max). Keeps the response large enough for any caller while bounding
    the cache-key cardinality — see _LIMIT_BUCKETS."""
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = _DEFAULT_LIMIT
    n = max(1, min(_MAX_LIMIT, n))
    for bucket in _LIMIT_BUCKETS:
        if n <= bucket:
            return bucket
    return _LIMIT_BUCKETS[-1]


def _fresh(key, ttl, now):
    """Return the cached payload for `key` if still within TTL, else None."""
    cached = _cache.get(key)
    if cached is not None and ttl > 0 and (now - cached[0]) < ttl:
        return cached[1]
    return None


async def _fetch_upstream(sym: str, code: str, lim: int) -> dict:
    """One unsigned GET to the public kline endpoint. Read-only; no auth headers.
    Any non-2xx or non-zero retCode is surfaced as 502 (an upstream problem from
    this app's view) rather than leaking upstream status codes to the browser."""
    url = settings.MARKET_DATA_BASE_URL + "/v5/market/kline"
    params = {
        "category": settings.CATEGORY,
        "symbol": sym,
        "interval": code,
        "limit": str(lim),
    }
    try:
        resp = await _client.get(url, params=params)
    except httpx.HTTPError as exc:
        raise MarketDataError(502, f"upstream request failed: {exc}") from exc
    try:
        data = resp.json()
    except ValueError as exc:
        raise MarketDataError(502, "invalid response from market-data upstream") from exc
    if resp.status_code >= 400:
        raise MarketDataError(502, "market-data upstream returned an error")
    if isinstance(data, dict):
        ret = data.get("retCode")
        if ret not in (None, 0, "0"):
            raise MarketDataError(502, data.get("retMsg") or "market-data upstream rejected the request")
    return data


async def get_kline(symbol: str, interval: str, limit=None) -> dict:
    """Fetch public OHLC candles for a whitelisted symbol/interval.

    Returns the upstream JSON unchanged (Bybit v5 shape:
    result.list = [[start, open, high, low, close, volume, turnover], ...],
    newest first). Read-only; never signed.
    """
    sym, code = _validate(symbol, interval)
    lim = _bucket_limit(limit)
    key = (sym, code, lim)
    ttl = settings.CHART_CACHE_TTL

    # Fast path: a fresh cache hit needs no lock.
    hit = _fresh(key, ttl, time.monotonic())
    if hit is not None:
        return hit

    # Single-flight per key: concurrent misses (cold start, TTL boundary, many
    # tabs) await ONE upstream call instead of each issuing their own.
    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()
    async with lock:
        now = time.monotonic()
        hit = _fresh(key, ttl, now)  # another coroutine may have filled it
        if hit is not None:
            return hit
        data = await _fetch_upstream(sym, code, lim)
        if ttl > 0:
            # The key space is bounded by real markets × intervals × limit-buckets
            # (the scanner universe made it wider than the old 3-symbol allowlist),
            # so cap growth in two stages: drop expired entries first, and only if
            # a sweep somehow keeps thousands warm, clear. Clear ONLY _cache —
            # never a held lock: the lock we currently hold must not be orphaned
            # mid-flight (a new caller would otherwise mint a second lock and
            # issue a redundant GET). Un-held locks are safe to prune.
            if len(_cache) > 1024:
                now2 = time.monotonic()
                for k in [k for k, (ts, _) in _cache.items() if (now2 - ts) >= ttl]:
                    _cache.pop(k, None)
                if len(_cache) > 4096:
                    _cache.clear()
            if len(_locks) > 1024:
                for k in [k for k, lk in _locks.items() if not lk.locked()]:
                    _locks.pop(k, None)
            # NOTE: the cached payload is SHARED by reference across concurrent
            # callers; it is read-only here (the route only serializes it) and
            # must never be mutated in place by a future consumer.
            # Stamp from fetch COMPLETION (not the pre-await `now`): a slow upstream
            # fetch (up to 10s) would otherwise mark a just-fetched payload as
            # already several seconds old and force an immediate refetch.
            _cache[key] = (time.monotonic(), data)
        return data


async def get_kline_uncached(symbol: str, interval: str, limit: int) -> dict:
    """Same public read as get_kline but bypassing the response cache — for the
    strategy runner, which must see the venue's CURRENT bar set right after a
    candle close, never a chart poll cached a second before the boundary.
    `symbol` comes from server config (STRATEGY_SYMBOLS), not from a client;
    the interval still goes through the fixed map."""
    code = _INTERVALS.get(str(interval).lower())
    if not code:
        raise MarketDataError(400, "interval not allowed")
    lim = max(1, min(_MAX_LIMIT, int(limit)))
    return await _fetch_upstream(str(symbol).strip().upper(), code, lim)
