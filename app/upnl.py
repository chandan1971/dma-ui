"""Overall unrealised-PnL tracker — the data engine behind the "PnL" tab.

WHAT THIS IS
============
One background sampler (started from the app lifespan, like the scanner and
history sync) reads the account's open positions every UPNL_SAMPLE_INTERVAL
seconds — ONE signed read-only request per interval regardless of how many
browser tabs are open — sums their `unrealisedPnl`, and persists the series in
Redis (Railway's Redis service, via REDIS_URL). `/api/upnl` serves range
queries straight from Redis; the live "current" value additionally rides the
dashboard's shared WebSocket snapshot, so the tab costs the exchange nothing
beyond the sampler's single read.

ISOLATION / SAFETY
==================
Read-only by construction: this module only ever calls `get_positions` (a
read) and writes to its own `upnl:*` Redis keys. It holds no write capability
and fabricates nothing — a failed exchange read or Redis outage DROPS the
sample (a gap in the series is honest; an interpolated point is not) and the
API carries an `error` field the UI surfaces.

STORAGE LAYOUT / MEMORY BUDGET (Railway Redis: 500 MB cap)
==========================================================
  upnl:raw   stream · one entry per sample     (v=<pnl>, n=<open positions>)
             MAXLEN ≈ 7 days of samples (120,960 @ the default 5s cadence)
  upnl:1m    stream · one entry per FULL minute (t,o,h,l,c)  MAXLEN 86,400 (60d)
  upnl:1h    stream · one entry per FULL hour   (t,o,h,l,c)  MAXLEN 17,520 (2y)
  upnl:ext   hash   · all-time extremes (maxV, maxTs, minV, minTs)

Entries this small live in listpack stream nodes (~<100 bytes each incl.
overhead), so full retention is ≈ 225k entries ≈ 22 MB — under 5% of the
500 MB plan. Every XADD carries `MAXLEN ~` so the trim is enforced on EVERY
write: the store cannot outgrow its budget no matter how long it runs.

Rollup entries are XADD'd with auto IDs (server-clock, monotonic-safe) and
carry their bucket-start ms in the `t` field; range reads over-fetch by one
bucket and filter on `t`, so a clock step can never wedge the sampler the way
explicit non-monotonic stream IDs would.
"""
import asyncio
import logging
import math
import time

import redis.asyncio as redis_async
from redis.exceptions import RedisError

from . import dma_client
from .config import settings

logger = logging.getLogger("dma-ui.upnl")

RAW_KEY = "upnl:raw"
M1_KEY = "upnl:1m"
H1_KEY = "upnl:1h"
EXT_KEY = "upnl:ext"

M1_MS = 60_000
H1_MS = 3_600_000

# Retention caps (see the memory-budget math in the module docstring).
RAW_KEEP_MS = 7 * 86_400_000
M1_MAXLEN = 60 * 1440       # 60 days of minutes
H1_MAXLEN = 730 * 24        # 2 years of hours

# A range response never ships more points than this — extremes are computed
# over the FULL-resolution rows first, so downsampling changes chart density,
# never the max/min/end the tab reports.
MAX_POINTS = 720

# range key -> (window ms or None for everything, source stream)
RANGES: dict[str, tuple[int | None, str]] = {
    "1h": (3_600_000, RAW_KEY),
    "6h": (21_600_000, RAW_KEY),
    "24h": (86_400_000, M1_KEY),
    "7d": (7 * 86_400_000, M1_KEY),
    "30d": (30 * 86_400_000, H1_KEY),
    "all": (None, H1_KEY),
}

# After an upstream rate limit, sit out this many EXTRA sample intervals
# (hammering a throttled API prolongs the throttle — same as the scanner).
_RATE_LIMIT_EXTRA_CYCLES = 3

_redis: redis_async.Redis | None = None
# In-progress rollup buckets ({"t","o","h","l","c"} or None until 1st sample).
_m1_bucket: dict | None = None
_h1_bucket: dict | None = None
# All-time extremes cache (loaded from Redis once, then maintained in-process;
# None = not loaded yet, {} = loaded-and-empty store).
_extremes: dict | None = None
# Latest successful sample (served as "current" without touching Redis).
_last_sample_ms: int | None = None
_last_value: float | None = None
_last_count: int | None = None
_last_error: str | None = None
# INFO memory is diagnostics, not data — cache it so range queries stay 1 read.
_mem_cache: tuple[float, dict] | None = None
_MEM_CACHE_S = 60.0


def enabled() -> bool:
    return settings.UPNL_ENABLED and bool(settings.REDIS_URL)


def last_sample_ms() -> int | None:
    """For /healthz: when the sampler last persisted a value (None until it has)."""
    return _last_sample_ms


def _client() -> redis_async.Redis:
    global _redis
    if _redis is None:
        # Tight socket timeouts: a hung Redis must degrade the PnL tab, never
        # stall the sampler task (or a request handler) indefinitely.
        _redis = redis_async.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_timeout=5.0,
            socket_connect_timeout=5.0,
        )
    return _redis


async def aclose() -> None:
    global _redis
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None


def _f(value):
    """Parse to a FINITE float or None — the same trust boundary as the
    scanner: a missing/garbled/inf upstream field never becomes a fake 0."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _raw_maxlen() -> int:
    return max(1, int(RAW_KEEP_MS / 1000 / settings.UPNL_SAMPLE_INTERVAL))


def roll_bucket(bucket: dict | None, ts_ms: int, value: float, width_ms: int):
    """Fold one sample into an OHLC bucket. Returns (completed, bucket):
    `completed` is the finished previous bucket when `ts_ms` crossed into a
    new one (flush it to Redis), else None. Pure — unit-tested directly."""
    start = int(ts_ms // width_ms) * width_ms
    if bucket is None or bucket["t"] != start:
        return bucket, {"t": start, "o": value, "h": value, "l": value, "c": value}
    if value > bucket["h"]:
        bucket["h"] = value
    if value < bucket["l"]:
        bucket["l"] = value
    bucket["c"] = value
    return None, bucket


def downsample(rows: list[tuple], max_points: int = MAX_POINTS) -> list[tuple]:
    """Shrink [(ts, lo, hi, close)] to ≤ max_points buckets, keeping each
    bucket's true lo/hi so spikes survive. Pure — unit-tested directly."""
    n = len(rows)
    if n <= max_points:
        return rows
    out = []
    for k in range(max_points):
        i0 = k * n // max_points
        i1 = max(i0 + 1, (k + 1) * n // max_points)
        chunk = rows[i0:i1]
        out.append((
            chunk[-1][0],
            min(c[1] for c in chunk),
            max(c[2] for c in chunk),
            chunk[-1][3],
        ))
    return out


def _bucket_fields(b: dict) -> dict:
    return {
        "t": str(int(b["t"])),
        "o": f"{b['o']:.4f}", "h": f"{b['h']:.4f}",
        "l": f"{b['l']:.4f}", "c": f"{b['c']:.4f}",
    }


async def _load_extremes(r: redis_async.Redis) -> dict:
    """All-time extremes, loaded from Redis once then maintained in-process
    (the sampler is the only writer, so the cache cannot go stale)."""
    global _extremes
    if _extremes is None:
        raw = await r.hgetall(EXT_KEY)
        _extremes = {}
        for k in ("maxV", "minV"):
            v = _f(raw.get(k))
            if v is not None:
                _extremes[k] = v
        for k in ("maxTs", "minTs"):
            try:
                _extremes[k] = int(raw[k])
            except (KeyError, TypeError, ValueError):
                pass
    return _extremes


async def record_sample(value: float, count: int, ts_ms: int) -> None:
    """Persist one sample: raw stream append, minute/hour rollup flushes when
    their buckets complete, and the all-time extremes hash. One pipeline —
    a single round trip per sample. On success, becomes the "current" value
    served by range_response."""
    global _m1_bucket, _h1_bucket, _last_sample_ms, _last_value, _last_count
    r = _client()
    ext = await _load_extremes(r)

    pipe = r.pipeline(transaction=False)
    pipe.xadd(
        RAW_KEY,
        {"v": f"{value:.4f}", "n": str(int(count))},
        maxlen=_raw_maxlen(),
        approximate=True,
    )
    done_m1, _m1_bucket = roll_bucket(_m1_bucket, ts_ms, value, M1_MS)
    if done_m1 is not None:
        pipe.xadd(M1_KEY, _bucket_fields(done_m1), maxlen=M1_MAXLEN, approximate=True)
    done_h1, _h1_bucket = roll_bucket(_h1_bucket, ts_ms, value, H1_MS)
    if done_h1 is not None:
        pipe.xadd(H1_KEY, _bucket_fields(done_h1), maxlen=H1_MAXLEN, approximate=True)

    ext_updates: dict[str, str] = {}
    if ext.get("maxV") is None or value > ext["maxV"]:
        ext.update(maxV=value, maxTs=ts_ms)
        ext_updates.update(maxV=f"{value:.4f}", maxTs=str(ts_ms))
    if ext.get("minV") is None or value < ext["minV"]:
        ext.update(minV=value, minTs=ts_ms)
        ext_updates.update(minV=f"{value:.4f}", minTs=str(ts_ms))
    if ext_updates:
        pipe.hset(EXT_KEY, mapping=ext_updates)
    await pipe.execute()
    _last_sample_ms, _last_value, _last_count = ts_ms, value, int(count)


async def _sample_once() -> float:
    """One sampler cycle. Returns EXTRA cooldown seconds (0 normally; >0 after
    an upstream rate limit). Never raises — the loop must outlive any single
    failure, and a failed cycle simply leaves a gap in the series."""
    global _last_error
    try:
        payload = await dma_client.get_positions()
    except dma_client.DMAError as exc:
        _last_error = "exchange read failed"
        logger.warning("upnl sample failed: %s", exc.detail)
        if dma_client.is_rate_limit(exc):
            cooldown = settings.UPNL_SAMPLE_INTERVAL * _RATE_LIMIT_EXTRA_CYCLES
            logger.warning("upnl: upstream rate limit — backing off %.0fs extra", cooldown)
            return cooldown
        return 0.0
    except Exception:
        _last_error = "exchange read failed"
        logger.exception("upnl sample failed unexpectedly")
        return 0.0
    try:
        positions = dma_client.extract_list(payload)
        # Same summation the dashboard header shows (build_dashboard's
        # totalUnrealisedPnl): every parseable unrealisedPnl, missing -> 0.
        total = sum(v for p in positions if (v := _f(p.get("unrealisedPnl"))) is not None)
        open_count = sum(1 for p in positions if _f(p.get("size")))
        await record_sample(round(total, 4), open_count, int(time.time() * 1000))
        _last_error = None
    except (RedisError, OSError, asyncio.TimeoutError):
        _last_error = "redis unavailable"
        logger.warning("upnl: redis write failed — sample dropped")
    except Exception:
        _last_error = "sample failed"
        logger.exception("upnl ingest failed")
    return 0.0


async def run_sampler() -> None:
    """Background task (started from the app lifespan). No REDIS_URL (or
    UPNL_ENABLED=0) starts nothing and /api/upnl reports 'not configured'."""
    if not enabled():
        reason = "REDIS_URL not set" if not settings.REDIS_URL else "UPNL_ENABLED=0"
        logger.info("upnl tracker disabled (%s) — /api/upnl serves empty", reason)
        return
    logger.info(
        "upnl sampler started: interval=%.0fs raw=%dd 1m=%dd 1h=%dd",
        settings.UPNL_SAMPLE_INTERVAL, RAW_KEEP_MS // 86_400_000,
        M1_MAXLEN // 1440, H1_MAXLEN // 24,
    )
    while True:
        cooldown = await _sample_once()
        await asyncio.sleep(settings.UPNL_SAMPLE_INTERVAL + cooldown)


async def _read_rows(r: redis_async.Redis, key: str, since_ms: int | None) -> list[tuple]:
    """Full-resolution rows [(ts, lo, hi, close)] for one range. Raw entries
    take their timestamp from the (server-clock) stream ID; rollups carry the
    bucket start in `t` — over-fetch one bucket width and filter exactly."""
    if key == RAW_KEY:
        start = "-" if since_ms is None else f"{max(0, since_ms)}-0"
        rows = []
        for entry_id, fields in await r.xrange(RAW_KEY, min=start, max="+"):
            v = _f(fields.get("v"))
            if v is None:
                continue
            rows.append((int(str(entry_id).split("-")[0]), v, v, v))
        return rows
    width = M1_MS if key == M1_KEY else H1_MS
    start = "-" if since_ms is None else f"{max(0, since_ms - 2 * width)}-0"
    rows = []
    for _entry_id, fields in await r.xrange(key, min=start, max="+"):
        try:
            t = int(fields["t"])
        except (KeyError, TypeError, ValueError):
            continue
        c = _f(fields.get("c"))
        if c is None or (since_ms is not None and t < since_ms):
            continue
        lo, hi = _f(fields.get("l")), _f(fields.get("h"))
        rows.append((t, lo if lo is not None else c, hi if hi is not None else c, c))
    return rows


async def _memory_meta(r: redis_async.Redis) -> dict:
    """used/max memory from INFO, cached — diagnostics for the tab's honesty
    footer, refreshed at most once per _MEM_CACHE_S."""
    global _mem_cache
    now = time.monotonic()
    if _mem_cache is not None and now - _mem_cache[0] < _MEM_CACHE_S:
        return _mem_cache[1]
    info = await r.info("memory")
    meta = {
        "redisUsedBytes": info.get("used_memory"),
        "redisMaxBytes": info.get("maxmemory") or None,
    }
    _mem_cache = (now, meta)
    return meta


def _current() -> dict | None:
    if _last_sample_ms is None or _last_value is None:
        return None
    return {"v": _last_value, "ts": _last_sample_ms, "n": _last_count}


async def range_response(range_key: str) -> dict:
    """What /api/upnl returns for one range: a ≤MAX_POINTS series of
    [ts, lo, hi, close], window extremes computed over the FULL-resolution
    rows, the all-time extremes, and staleness/diagnostic context."""
    now_ms = int(time.time() * 1000)
    base = {
        "type": "upnl",
        "range": range_key,
        "enabled": enabled(),
        "intervalMs": int(settings.UPNL_SAMPLE_INTERVAL * 1000),
        "nowMs": now_ms,
        "lastSampleMs": _last_sample_ms,
        "series": [],
        "current": _current(),
        "window": None,
        "allTime": None,
        "error": _last_error,
    }
    if not enabled():
        base["error"] = "not configured — set REDIS_URL (attach Railway's Redis service) to record PnL history"
        return base

    window_ms, key = RANGES[range_key]
    since_ms = None if window_ms is None else now_ms - window_ms
    try:
        r = _client()
        rows = await _read_rows(r, key, since_ms)
        ext = dict(await _load_extremes(r))
        base.update(await _memory_meta(r))
    except (RedisError, OSError, asyncio.TimeoutError):
        logger.warning("upnl: redis read failed for /api/upnl")
        base["error"] = "redis unavailable"
        return base

    # Rollup-backed ranges lag by up to one bucket: append the in-progress
    # bucket(s) and the live sample so the series always reaches "now".
    if key != RAW_KEY:
        live = _m1_bucket if key == M1_KEY else _h1_bucket
        if live is not None and (not rows or live["t"] > rows[-1][0]):
            if since_ms is None or live["t"] >= since_ms:
                rows.append((live["t"], live["l"], live["h"], live["c"]))
    elif _last_sample_ms is not None and _last_value is not None:
        if (not rows or _last_sample_ms > rows[-1][0]) and (
            since_ms is None or _last_sample_ms >= since_ms
        ):
            rows.append((_last_sample_ms, _last_value, _last_value, _last_value))

    window = None
    if rows:
        hi_row = max(rows, key=lambda c: c[2])
        lo_row = min(rows, key=lambda c: c[1])
        window = {
            "max": hi_row[2], "maxTs": hi_row[0],
            "min": lo_row[1], "minTs": lo_row[0],
            "firstTs": rows[0][0], "lastTs": rows[-1][0],
            "samples": len(rows),
        }

    all_time = None
    if ext.get("maxV") is not None and ext.get("minV") is not None:
        all_time = {
            "max": ext["maxV"], "maxTs": ext.get("maxTs"),
            "min": ext["minV"], "minTs": ext.get("minTs"),
        }

    base.update(series=downsample(rows), window=window, allTime=all_time)
    return base
