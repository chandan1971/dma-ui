"""Background sync: mirror executions, closed-PnL & the transaction log from the
exchange into MongoDB.

Runs inside the web process (started from the FastAPI lifespan, like the
Telegram watcher): every SYNC_INTERVAL_SECONDS (default one minute) it brings
the `Trades`, `Closed-PnL` and `Transactions` collections up to date, so the
exchange's history endpoints are only ever hit from here — the dashboard reads
MongoDB (app/db.py). The transaction log is PROBATIONAL: the endpoint is not in
the DMA Postman collection, so the first live call doubles as a capability
probe — a 404/405 disables that mirror for the process lifetime (logged once,
surfaced on /healthz as transactionLogSupported=false, no Telegram alert)
instead of failing and alerting every minute against a gateway that simply
doesn't proxy it. On an empty
collection it backfills SYNC_BACKFILL_DAYS of history in sequential <=7-day
windows; afterwards each run only covers the span since the newest stored
record. Fetching stays strictly cursor-free (startTime/endTime windows with
time-bisection, see app/dma_client.py) because the signer cannot survive the
gateway's percent-encoded cursors.

Crash-safety model (the invariants everything below leans on):
  * Windows are walked OLDEST -> NEWEST and each window is upserted before the
    next is fetched, so the stored data is always a contiguous prefix of the
    planned range. The resume point (watermark) is derived from the DATA
    itself — max tsMs in the collection — so it can never point past a gap:
    a crashed/aborted run simply leaves less data, never wrong state. Once a
    run has COMPLETED (covered through `now`), later resumes start at that
    run's end bound minus the overlap instead of a possibly-stale watermark:
    completion certifies coverage, so re-walking back to a watermark that
    stopped moving (no new records) would only re-fetch immutable ranges.
  * Re-running is idempotent: `_id` is the record's natural identity (execId /
    orderId:updatedTime) and writes are ReplaceOne upserts, so overlap and
    repeats are free. Each run restarts two hours before the watermark to
    absorb same-millisecond ties and late-visible records.
  * Budget exhaustion (transient) STOPS the run — continuing would advance the
    watermark past unfetched ranges and permanently hide them. Density
    truncation (permanent: a <=60s span still saturating the 100-record page)
    only WARNS and moves on — no retry can ever fix it, and stopping would
    wedge the sync on that window forever.
"""
import asyncio
import logging
import random
import time
from datetime import datetime, timezone

from . import db, dma_client, notifier
from .config import settings

logger = logging.getLogger("dma-ui.history_sync")

_STARTUP_DELAY_S = 15          # let the app finish booting before the first run
# Re-fetch this far behind the watermark every run. Re-fetching is FREE
# (idempotent upserts), while a too-small overlap permanently loses any record
# the gateway makes queryable later than the overlap after its own timestamp
# (replication lag, incidents, delayed settlement/liquidation fills). At the
# one-minute cadence, 2h of overlap is normally a single extra request per run
# and still dwarfs any realistic late-visibility window.
_OVERLAP_MS = 2 * 60 * 60 * 1000
_PACE_S = 0.2                  # sleep between upstream requests (background politeness)
_MAX_REQUESTS_PER_RUN = 2000   # per collection per run; cold start needs ~105
_MIN_BISECT_WINDOW_MS = 60 * 1000  # finer than the interactive 1h: sync is account-wide
_RETRY_ATTEMPTS = 4
_RETRY_BASE_S = 1.0            # backoff: 1s, 2s, 4s (+ jitter) between the 4 attempts
# A stored timestamp materially in the future would poison the max-tsMs
# watermark (every later run would think it is already caught up); reject
# anything further ahead than this and count it as skipped.
_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000
# Once an hour a run re-covers the dashboard's full 31-day window instead of
# just [watermark - 2h, now]: the 2h overlap alone would PERMANENTLY miss any
# record the gateway first exposes more than 2h after its own timestamp
# (delayed settlement / liquidation fills, replication incidents). With
# $setOnInsert upserts the re-scan is nearly free (~8 extra GETs per hour).
_DEEP_RESCAN_INTERVAL_MS = 60 * 60 * 1000
_DEEP_RESCAN_SPAN_MS = dma_client._HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean_value(value):
    if isinstance(value, dict):
        return {
            k: _clean_value(v)
            for k, v in value.items()
            if not k.startswith("$") and "." not in k
        }
    if isinstance(value, list):
        return [_clean_value(v) for v in value]
    return value


def _clean_record(record: dict) -> dict:
    """Copy of a raw gateway record that is safe to store: MongoDB rejects (or
    misinterprets) field names that are $-prefixed or dotted — at ANY nesting
    depth — and ONE poison key in a response would abort the bulk write and
    wedge the sync on that window forever (the watermark never advances past
    it)."""
    return _clean_value(record)


def _trade_doc(record: dict, synced_at: datetime) -> dict | None:
    """Storable doc for one execution, or None if it has no usable identity.
    `_id` = execId, the gateway's globally unique fill id (NEVER orderId — one
    order legitimately produces many fills that must all be kept)."""
    exec_id = record.get("execId")
    if not exec_id:
        return None
    return {
        **_clean_record(record),
        "_id": str(exec_id),
        "tsMs": dma_client._to_int_ms(record.get("execTime")),
        "syncedAt": synced_at,
    }


def _pnl_doc(record: dict, synced_at: datetime) -> dict | None:
    """Storable doc for one closed-PnL row, or None if it has no usable
    identity. `_id` = orderId:updatedTime — the same composite identity the
    live dedup used. BOTH parts must be present and non-empty: an empty
    updatedTime would mint one `_id` now and a different one if the gateway
    later fills the field in, and that close would then double-count."""
    order_id = record.get("orderId")
    updated = record.get("updatedTime")
    if not order_id or not updated:
        return None
    return {
        **_clean_record(record),
        "_id": f"{order_id}:{updated}",
        "tsMs": dma_client._to_int_ms(updated),
        "syncedAt": synced_at,
    }


def _txn_doc(record: dict, synced_at: datetime) -> dict | None:
    """Storable doc for one transaction-log row, or None if it has no usable
    timestamp (transactionTime is both the range key and part of the fallback
    identity — a row without it can neither be read back nor deduped). `_id`
    prefers the gateway's own `id`; rows without one get a composite of the
    fields that make a ledger line unique — time, type, currency, the
    trade/order it came from, the balance delta AND the resulting balance
    (cashBalance disambiguates two identical same-millisecond entries)."""
    ts = dma_client._to_int_ms(record.get("transactionTime"))
    if ts <= 0:
        return None
    txn_id = record.get("id") or ":".join(
        str(record.get(k) or "")
        for k in ("transactionTime", "type", "currency", "tradeId", "orderId",
                  "change", "cashBalance")
    )
    return {
        **_clean_record(record),
        "_id": str(txn_id),
        "tsMs": ts,
        "syncedAt": synced_at,
    }


# The gateway rejects transaction-log queries "earlier than 2 years" (a LIVE
# 400 from the deployed gateway, so the endpoint itself exists). A cold start
# at the default SYNC_BACKFILL_DAYS=730 begins EXACTLY 2 years back, which is
# already over the line by the time the request lands — and the failed run
# never advances the watermark, so it would re-fail every minute forever. Cap
# this kind's backfill a safe month inside the rule; ~23 months of ledger is
# the most the endpoint can serve anyway.
_TXN_MAX_BACKFILL_DAYS = 700

# Fetchers are late-bound (lambdas) so the dma_client attribute stays
# monkeypatchable, consistent with every other cross-module seam here.
# page_limit: per-endpoint page cap (the transaction log caps at 50, half the
# 100 of the other two) — saturation detection must match what was requested.
# max_backfill_days: per-endpoint cap on the cold-start lookback (None = the
# configured SYNC_BACKFILL_DAYS as-is).
_KINDS = {
    db.TRADES: {
        "label": "trades",
        "fetch": lambda s, e, st: dma_client.get_executions_window(s, e, st),
        "to_doc": _trade_doc,
        "page_limit": dma_client._HISTORY_PAGE_LIMIT,
        "max_backfill_days": None,
    },
    db.CLOSED_PNL: {
        "label": "closed-pnl",
        "fetch": lambda s, e, st: dma_client.get_closed_pnl_window(s, e, st),
        "to_doc": _pnl_doc,
        "page_limit": dma_client._HISTORY_PAGE_LIMIT,
        "max_backfill_days": None,
    },
    db.TRANSACTIONS: {
        "label": "transactions",
        "fetch": lambda s, e, st: dma_client.get_transaction_log_window(s, e, st),
        "to_doc": _txn_doc,
        "page_limit": dma_client.TXN_PAGE_LIMIT,
        "max_backfill_days": _TXN_MAX_BACKFILL_DAYS,
    },
}

# Kinds whose endpoint is NOT in the DMA Postman collection: the first live
# call is a capability probe, and a 404/405 permanently (for this process)
# disables the kind. Trades/closed-PnL are documented endpoints — a 404 there
# is a gateway incident that must keep failing loudly, never a probe verdict.
_PROBATIONAL_KINDS = frozenset({db.TRANSACTIONS})
_unsupported: set = set()


def is_unsupported(kind: str) -> bool:
    """True when the gateway rejected this kind's endpoint as nonexistent."""
    return kind in _unsupported

# Single-flight: a slow backfill must never overlap the next scheduled run.
_sync_lock = asyncio.Lock()

# When each collection last completed a full sync (epoch ms of the run's `end`
# bound; None until the first successful run after boot). Surfaced to the
# dashboard via the history endpoints' `result.lastSyncedMs` so users can see
# how fresh the data is. In-memory only: a restart re-syncs within ~1 minute.
_last_synced_ms: dict = {db.TRADES: None, db.CLOSED_PNL: None, db.TRANSACTIONS: None}

# When each collection last completed a run that covered the full deep-rescan
# span (epoch ms; 0 = never, so the first run after boot is always deep).
_last_deep_rescan_ms: dict = {db.TRADES: 0, db.CLOSED_PNL: 0, db.TRANSACTIONS: 0}


def last_synced_ms(kind: str):
    return _last_synced_ms.get(kind)

# Message-string fallback for transient errors whose v5 retCode we haven't
# mapped (the primary classification is the NUMERIC ret_code below — strings
# are brittle against upstream copy changes).
_RETRYABLE_HINTS = (
    "too many", "rate limit", "too frequent", "timeout", "timed out",
    "system busy", "system error", "service unavailable",
)


def _is_retryable(exc: dma_client.DMAError) -> bool:
    status = getattr(exc, "status", None)
    if status == 429 or (isinstance(status, int) and status >= 500):
        return True
    if getattr(exc, "ret_code", None) in dma_client.RETRYABLE_RET_CODES:
        return True
    detail = str(getattr(exc, "detail", "")).lower()
    return any(hint in detail for hint in _RETRYABLE_HINTS)


async def _fetch_window_with_retry(fetch, start_ms: int, end_ms: int, state: dict) -> list:
    """One window fetch with exponential backoff on transient upstream errors.
    Non-retryable errors (auth, validation) raise immediately — they abort the
    run, which is safe: nothing past the last upserted window was recorded."""
    delay = _RETRY_BASE_S
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            return await fetch(start_ms, end_ms, state)
        except dma_client.DMAError as exc:
            if attempt >= _RETRY_ATTEMPTS or not _is_retryable(exc):
                raise
            logger.warning(
                "history sync: transient upstream error on window [%s..%s] "
                "(attempt %d/%d, retrying in %.1fs): %s",
                _iso(start_ms), _iso(end_ms), attempt, _RETRY_ATTEMPTS, delay, exc,
            )
            await asyncio.sleep(delay + random.uniform(0.0, delay / 2))
            delay *= 2
    raise AssertionError("unreachable")  # loop always returns or raises


async def sync_kind(kind: str) -> dict:
    """Bring one collection up to date. Returns the run's summary counters."""
    spec = _KINDS[kind]
    now_ms = int(time.time() * 1000)
    synced_at = datetime.now(timezone.utc)
    backfill_days = settings.SYNC_BACKFILL_DAYS
    if spec["max_backfill_days"] is not None:
        backfill_days = min(backfill_days, spec["max_backfill_days"])
    floor_ms = now_ms - backfill_days * 86_400_000

    # The deep-rescan start is capped by the backfill floor: covering down to
    # it counts as a full deep pass even when the floor is shallower than the
    # nominal 31-day span.
    deep_start_ms = max(now_ms - _DEEP_RESCAN_SPAN_MS, floor_ms)

    watermark = await db.latest_ts_ms(kind)
    if watermark is None:
        start_ms, mode = floor_ms, "cold-start backfill"
    else:
        start_ms, mode = max(watermark - _OVERLAP_MS, floor_ms), "resume"
        last_run_ms = _last_synced_ms.get(kind)
        if last_run_ms is not None:
            # A completed run certifies coverage through its end bound, so a
            # later resume only needs the overlap's late-visibility budget
            # behind THAT — never the full span back to the watermark. The
            # watermark stops moving whenever no new records arrive (weeks
            # without a closed trade), and re-walking every window back to it
            # on every run burned 5 requests/minute against data that cannot
            # change — the standing load behind the Sep '26 upstream
            # rate-limit bursts. Records surfacing later than the overlap
            # remain the hourly deep rescan's job, exactly as they already
            # were for a moving watermark. Crash-safe: the stamp is only
            # written by runs that reached `now`, and the first run after a
            # boot (stamp None) still walks from the watermark, healing any
            # downtime gap.
            start_ms = max(start_ms, last_run_ms - _OVERLAP_MS)
        if (
            now_ms - _last_deep_rescan_ms.get(kind, 0) >= _DEEP_RESCAN_INTERVAL_MS
            and deep_start_ms < start_ms
        ):
            start_ms, mode = deep_start_ms, "deep rescan"
    if start_ms > now_ms:
        # Future watermark (clock skew / bad record): re-cover the recent past
        # instead of computing an empty or inverted range.
        start_ms = now_ms - _OVERLAP_MS
    logger.info(
        "history sync %s: %s covering [%s..%s]",
        spec["label"], mode, _iso(start_ms), _iso(now_ms),
    )

    state = dma_client.new_history_state(
        max_requests=_MAX_REQUESTS_PER_RUN,
        min_window_ms=_MIN_BISECT_WINDOW_MS,
        pace_s=_PACE_S,
        page_limit=spec["page_limit"],
    )
    totals = {"windows": 0, "fetched": 0, "upserted": 0, "matched": 0, "skipped": 0}
    density_warned = False

    # _time_windows yields newest-first (right for the dashboard); the sync MUST
    # walk oldest-first so a partial run leaves contiguous coverage — sort the
    # (start, end) tuples ascending.
    for w_start, w_end in sorted(dma_client._time_windows(start_ms, now_ms)):
        records = await _fetch_window_with_retry(spec["fetch"], w_start, w_end, state)
        docs = [
            spec["to_doc"](r, synced_at) for r in records if isinstance(r, dict)
        ]
        # Timestamp sanity: tsMs=0 (unparseable) would be invisible to every
        # range read, and a far-future tsMs would poison the max-tsMs
        # watermark so later runs never revisit older ranges. Skip both.
        keep = [
            d for d in docs
            if d is not None and 0 < d["tsMs"] <= now_ms + _MAX_FUTURE_SKEW_MS
        ]
        skipped = len(records) - len(keep)
        upserted, matched = await db.bulk_upsert(kind, keep)

        totals["windows"] += 1
        totals["fetched"] += len(records)
        totals["upserted"] += upserted
        totals["matched"] += matched
        totals["skipped"] += skipped
        logger.info(
            "history sync %s: window [%s..%s] fetched=%d upserted=%d matched=%d "
            "skipped=%d requests=%d",
            spec["label"], _iso(w_start), _iso(w_end),
            len(records), upserted, matched, skipped, state["requests"],
        )

        if state["density_truncated"] and not density_warned:
            density_warned = True
            logger.warning(
                "history sync %s: a span <=%ds still saturates the %d-record page; "
                "records beyond the cap in that span are unreachable without a "
                "cursor — continuing with the rest of the range",
                spec["label"], _MIN_BISECT_WINDOW_MS // 1000, state["page_limit"],
            )
        if state["budget_exhausted"]:
            # Transient cap: stop HERE. Later windows must not be fetched, or the
            # data-derived watermark would leap past the unfetched span and the
            # next run would never go back for it.
            logger.warning(
                "history sync %s: request budget (%d) exhausted after %d windows — "
                "stopping this run; the next run resumes from the last stored record",
                spec["label"], _MAX_REQUESTS_PER_RUN, totals["windows"],
            )
            break

    if not state["budget_exhausted"]:
        # Data is now current up to this run's `end` bound. A budget-stopped
        # run keeps the previous stamp — its coverage did NOT reach `now`.
        _last_synced_ms[kind] = now_ms
        if watermark is None or start_ms <= deep_start_ms:
            # This run covered the whole deep span (a cold-start backfill
            # always does) — the next deep rescan is due an hour from now.
            _last_deep_rescan_ms[kind] = now_ms
    elif mode == "deep rescan":
        # Deep passes are hourly ATTEMPTS, not guaranteed completions. A deep
        # span too dense to finish within one budget must still advance the
        # deep stamp: otherwise it would re-select itself on every run and
        # starve the cheap incremental resume that captures NEW fills — a
        # freshness stall in exchange for a rescan that can never finish.
        _last_deep_rescan_ms[kind] = now_ms
    logger.info(
        "history sync %s: run complete windows=%d fetched=%d upserted=%d "
        "matched=%d skipped=%d requests=%d budget_exhausted=%s density_truncated=%s",
        spec["label"], totals["windows"], totals["fetched"], totals["upserted"],
        totals["matched"], totals["skipped"], state["requests"],
        state["budget_exhausted"], state["density_truncated"],
    )
    return totals


# A single failed run is routine (transient upstream/Mongo blips) and only
# logged; this many CONSECUTIVE failures means the mirror is actually wedged
# and going stale, so the operator is alerted out-of-band (Telegram) once —
# and told again when it recovers. At the 1-minute cadence, 3 ≈ 3 minutes.
_FAILURES_BEFORE_ALERT = 3
_consecutive_failures: dict = {db.TRADES: 0, db.CLOSED_PNL: 0, db.TRANSACTIONS: 0}

# A rate limit that survives the in-run retry ladder is a ban measured in
# minutes ("Access too frequent. Please try again in 5 minutes."), not a blip:
# keeping the 1-minute cadence pokes the throttled gateway and extends the
# ban. One such failure pauses ALL kinds for this long (matching the ban's own
# stated duration). Skipped runs are deliberate, not failures — a single burst
# never pages Telegram; sustained throttling still does, after
# _FAILURES_BEFORE_ALERT failed attempts spaced a cooldown apart (~10+ min).
_RATE_LIMIT_COOLDOWN_S = 300.0
_rate_limited_until_ms = 0.0


async def sync_all() -> None:
    """One scheduled run: each collection independently, under the single-flight
    lock. A failure in one collection is logged and never blocks the others; a
    failed run leaves the data consistent (see module docstring) so the next
    run simply resumes. A probational kind whose endpoint the gateway rejects
    as nonexistent (404/405) is disabled for the process lifetime — that is a
    capability verdict, not an incident."""
    global _rate_limited_until_ms
    async with _sync_lock:
        if time.time() * 1000 < _rate_limited_until_ms:
            logger.info(
                "history sync: upstream rate-limit cooldown active (%.0fs left) "
                "— skipping this run",
                (_rate_limited_until_ms - time.time() * 1000) / 1000,
            )
            return
        for kind in (db.TRADES, db.CLOSED_PNL, db.TRANSACTIONS):
            if kind in _unsupported:
                continue
            label = _KINDS[kind]["label"]
            try:
                await sync_kind(kind)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if (
                    kind in _PROBATIONAL_KINDS
                    and isinstance(exc, dma_client.DMAError)
                    and exc.status in (404, 405)
                ):
                    # Capability verdict, not an incident: log once, disable,
                    # and never route this into the failure counter/alert.
                    _unsupported.add(kind)
                    logger.warning(
                        "history sync %s: the gateway does not proxy this "
                        "endpoint (HTTP %s) — disabling the %s mirror until the "
                        "next restart (/healthz reports "
                        "transactionLogSupported=false)",
                        label, exc.status, label,
                    )
                    continue
                throttled = isinstance(exc, dma_client.DMAError) and \
                    dma_client.is_rate_limit(exc)
                if throttled:
                    _rate_limited_until_ms = (
                        time.time() * 1000 + _RATE_LIMIT_COOLDOWN_S * 1000
                    )
                    # warning, not exception: the ban is an upstream state, not
                    # a code path worth a traceback every occurrence.
                    logger.warning(
                        "history sync %s: upstream rate limit persisted through "
                        "retries (%s) — pausing all history sync for %.0fs; data "
                        "is intact and the next run resumes from the last stored "
                        "record",
                        label, exc, _RATE_LIMIT_COOLDOWN_S,
                    )
                else:
                    logger.exception(
                        "history sync %s: run failed; data is intact and the next "
                        "run resumes from the last stored record",
                        label,
                    )
                _consecutive_failures[kind] += 1
                # == (not >=): alert exactly once per wedge, not every minute.
                if _consecutive_failures[kind] == _FAILURES_BEFORE_ALERT:
                    await notifier.notify(
                        f"⚠️ DMA terminal: the {label} history sync has failed "
                        f"{_FAILURES_BEFORE_ALERT} runs in a row — the History tab "
                        "is going stale. Check the deploy logs."
                    )
                if throttled:
                    # The remaining kinds share the throttled gateway — hitting
                    # them right now is exactly the traffic the ban punishes.
                    break
            else:
                if _consecutive_failures[kind] >= _FAILURES_BEFORE_ALERT:
                    await notifier.notify(
                        f"✅ DMA terminal: the {label} history sync has recovered."
                    )
                _consecutive_failures[kind] = 0


async def run_scheduler() -> None:
    """Lifetime task (started in the lifespan): first sync shortly after boot —
    a fresh deploy on an empty DB starts its backfill immediately — then every
    SYNC_INTERVAL_SECONDS. Same shape as notifier.run_watcher: the loop
    survives any exception and exits only via task cancellation on shutdown."""
    indexes_ready = False
    await asyncio.sleep(_STARTUP_DELAY_S)
    while True:
        if not indexes_ready:
            # Self-healing: retried each cycle until it succeeds, repairing a
            # boot where Mongo (or index creation) was unavailable so reads
            # never sit on unindexed sorts forever; skipped once done.
            try:
                await db.ensure_indexes()
                indexes_ready = True
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("history sync: ensure_indexes failed; syncing anyway")
        try:
            await sync_all()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("history sync: scheduled run crashed")
        await asyncio.sleep(settings.SYNC_INTERVAL_SECONDS)
