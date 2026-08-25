"""Background history sync (app/history_sync.py) against a fake gateway + fake DB.

Pins the crash-safety model: cursor-free ascending 7-day windows, per-window
durable upserts, data-derived watermark resume (with overlap), idempotent
re-runs, retry-on-transient, stop-on-budget vs continue-on-density.
"""
import asyncio
import json
from urllib.parse import parse_qs, urlparse

import pytest

from app import db, dma_client, history_sync

DAY_MS = 24 * 60 * 60 * 1000
FIXED_NOW_MS = 1_800_000_000_000  # frozen clock -> deterministic windows
BACKFILL_DAYS = 21                # -> exactly 3 windows of <=7 days
FLOOR_MS = FIXED_NOW_MS - BACKFILL_DAYS * DAY_MS


class _Resp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


def _fill(exec_id, ts, symbol="BTCUSDT"):
    return {"execId": exec_id, "orderId": f"ord-{exec_id}", "symbol": symbol,
            "side": "Buy", "execQty": "1", "execPrice": "100", "execFee": "0.1",
            "execTime": str(ts)}


def _pnl(order_id, ts, symbol="BTCUSDT"):
    return {"orderId": order_id, "symbol": symbol, "closedPnl": "1.5",
            "updatedTime": str(ts), "createdTime": str(ts - 500)}


def _page(dataset, start, end, ts_key):
    """Mimic the gateway: records in [start, end], newest-first, capped at 100."""
    hits = [r for r in dataset if start <= int(r[ts_key]) <= end]
    hits.sort(key=lambda r: int(r[ts_key]), reverse=True)
    return hits[:dma_client._HISTORY_PAGE_LIMIT]


def _install(monkeypatch, trades=(), pnls=(), backfill_days=BACKFILL_DAYS):
    """Freeze the clock, neutralise pacing/backoff, shrink the backfill, and
    serve `trades`/`pnls` from a fake gateway with real paging semantics.
    Returns (calls, handlers): calls = [(path, start_ms, end_ms), ...];
    swap handlers["fn"] to inject failures (it may return a list of records
    or a ready _Resp). Every request is asserted cursor-free and <=7 days."""
    monkeypatch.setattr(history_sync.time, "time", lambda: FIXED_NOW_MS / 1000)
    monkeypatch.setattr(history_sync, "_PACE_S", 0.0)
    monkeypatch.setattr(history_sync, "_RETRY_BASE_S", 0.001)
    monkeypatch.setattr(history_sync.settings, "SYNC_BACKFILL_DAYS", backfill_days)
    # Fresh freshness-stamps per test (writes go into this replacement dict).
    monkeypatch.setattr(history_sync, "_last_synced_ms",
                        {db.TRADES: None, db.CLOSED_PNL: None, db.TRANSACTIONS: None})
    # Deep rescans "just ran" by default so incremental tests see the plain
    # watermark-overlap resume; the dedicated deep-rescan test overrides this.
    monkeypatch.setattr(history_sync, "_last_deep_rescan_ms",
                        {db.TRADES: FIXED_NOW_MS, db.CLOSED_PNL: FIXED_NOW_MS,
                         db.TRANSACTIONS: FIXED_NOW_MS})
    # Fresh probe/failure state so no test inherits an "unsupported" verdict
    # or a failure streak from another.
    monkeypatch.setattr(history_sync, "_unsupported", set())
    monkeypatch.setattr(history_sync, "_consecutive_failures",
                        {db.TRADES: 0, db.CLOSED_PNL: 0, db.TRANSACTIONS: 0})

    calls: list[tuple[str, int, int]] = []

    def default_handler(path, start, end):
        if "/v5/execution/list" in path:
            return _page(trades, start, end, "execTime")
        return _page(pnls, start, end, "updatedTime")

    handlers = {"fn": default_handler}

    async def fake_get(url, headers=None):
        parsed = urlparse(url)
        q = parse_qs(parsed.query)
        assert "cursor" not in q, f"cursor must never be sent: {url}"
        assert "startTime" in q and "endTime" in q, f"missing time range: {url}"
        start, end = int(q["startTime"][0]), int(q["endTime"][0])
        assert end - start <= dma_client._HISTORY_WINDOW_MS, f"window > 7d: {url}"
        calls.append((parsed.path, start, end))
        out = handlers["fn"](parsed.path, start, end)
        if isinstance(out, _Resp):
            return out
        return _Resp(200, {"retCode": 0, "result": {"category": "linear", "list": out}})

    monkeypatch.setattr(dma_client._client, "get", fake_get)
    return calls, handlers


def _exec_calls(calls):
    return [c for c in calls if "/v5/execution/list" in c[0]]


# Three windows for the 21-day backfill; one record per window per kind.
W1_TS = FLOOR_MS + 3_600_000
W2_TS = FLOOR_MS + 8 * DAY_MS
W3_TS = FIXED_NOW_MS - 1_000
THREE_FILLS = [_fill("e1", W1_TS), _fill("e2", W2_TS), _fill("e3", W3_TS)]
THREE_PNLS = [_pnl("o1", W1_TS), _pnl("o2", W2_TS), _pnl("o3", W3_TS)]


def test_cold_start_walks_ascending_7day_windows_and_stores_both_kinds(monkeypatch, fake_db):
    calls, _ = _install(monkeypatch, trades=THREE_FILLS, pnls=THREE_PNLS)
    asyncio.run(history_sync.sync_all())

    for path in ("/v5/execution/list", "/v5/position/closed-pnl"):
        kind_calls = [c for c in calls if c[0].endswith(path)]
        assert len(kind_calls) == 3, "21 days -> 3 windows, one GET each"
        starts = [c[1] for c in kind_calls]
        assert starts[0] == FLOOR_MS, "cold start begins at the backfill floor"
        assert starts == sorted(starts), "windows must be walked OLDEST-first"
        assert kind_calls[-1][2] == FIXED_NOW_MS, "walk reaches the present"

    assert set(fake_db[db.TRADES]) == {"e1", "e2", "e3"}
    doc = fake_db[db.TRADES]["e3"]
    assert doc["tsMs"] == W3_TS and doc["execTime"] == str(W3_TS)
    assert set(fake_db[db.CLOSED_PNL]) == {f"o1:{W1_TS}", f"o2:{W2_TS}", f"o3:{W3_TS}"}
    assert fake_db[db.CLOSED_PNL][f"o2:{W2_TS}"]["tsMs"] == W2_TS
    # A completed run stamps freshness with the run's end bound for both kinds.
    assert history_sync.last_synced_ms(db.TRADES) == FIXED_NOW_MS
    assert history_sync.last_synced_ms(db.CLOSED_PNL) == FIXED_NOW_MS


def test_incremental_run_resumes_from_watermark_minus_overlap(monkeypatch, fake_db):
    calls, _ = _install(monkeypatch, trades=THREE_FILLS)
    seed_ts = FIXED_NOW_MS - 3 * DAY_MS
    fake_db[db.TRADES]["seed"] = {"_id": "seed", "tsMs": seed_ts, "execId": "seed"}

    asyncio.run(history_sync.sync_kind(db.TRADES))

    exec_calls = _exec_calls(calls)
    assert exec_calls[0][1] == seed_ts - history_sync._OVERLAP_MS, \
        "resume must start at watermark - overlap, not at the backfill floor"
    assert len(exec_calls) == 1, "a 3-day tail fits in one window"
    assert "e3" in fake_db[db.TRADES] and "e1" not in fake_db[db.TRADES], \
        "only the tail is (re)covered on an incremental run"


def test_rerun_is_idempotent_no_duplicates(monkeypatch, fake_db):
    recent = [_fill("e1", FIXED_NOW_MS - 1_000), _fill("e2", FIXED_NOW_MS - 2_000),
              _fill("e3", FIXED_NOW_MS - 3_000)]
    _install(monkeypatch, trades=recent)

    first = asyncio.run(history_sync.sync_kind(db.TRADES))
    assert (first["upserted"], first["matched"]) == (3, 0)

    second = asyncio.run(history_sync.sync_kind(db.TRADES))
    assert second["upserted"] == 0, "re-running must never create documents"
    assert second["matched"] == 3, "overlap re-fetches the same records as no-ops"
    assert len(fake_db[db.TRADES]) == 3


def test_nonretryable_failure_aborts_run_then_next_run_fills_gap_free(monkeypatch, fake_db):
    calls, handlers = _install(monkeypatch, trades=THREE_FILLS)
    default = handlers["fn"]

    def fail_window2(path, start, end):
        if start <= W2_TS <= end:
            return _Resp(200, {"retCode": 10001, "retMsg": "params error"})
        return default(path, start, end)

    handlers["fn"] = fail_window2
    with pytest.raises(dma_client.DMAError):
        asyncio.run(history_sync.sync_kind(db.TRADES))
    assert set(fake_db[db.TRADES]) == {"e1"}, \
        "windows before the failure are durably stored; nothing after it"

    handlers["fn"] = default  # gateway healed
    asyncio.run(history_sync.sync_kind(db.TRADES))
    assert set(fake_db[db.TRADES]) == {"e1", "e2", "e3"}, \
        "resume from the stored watermark recovers the failed span with no gap"


def test_transient_error_is_retried_then_succeeds(monkeypatch, fake_db):
    calls, handlers = _install(monkeypatch, trades=[_fill("e1", FIXED_NOW_MS - 1_000)],
                               backfill_days=5)
    default = handlers["fn"]
    state = {"failed": 0}

    def flaky(path, start, end):
        if state["failed"] < 1:
            state["failed"] += 1
            return _Resp(200, {"retCode": 10006, "retMsg": "Too many visits! Rate limit."})
        return default(path, start, end)

    handlers["fn"] = flaky
    asyncio.run(history_sync.sync_kind(db.TRADES))

    assert "e1" in fake_db[db.TRADES]
    assert len(_exec_calls(calls)) == 2, "exactly one retry after the rate-limit hit"


@pytest.mark.parametrize("exc,retryable", [
    (dma_client.DMAError(502, "upstream request failed: boom"), True),
    (dma_client.DMAError(429, "slow down"), True),
    (dma_client.DMAError(400, "Too many visits!"), True),   # message fallback
    # NUMERIC ret_code is the primary signal — retryable even when the message
    # matches no hint string (upstream copy changes must not break this).
    (dma_client.DMAError(400, "opaque message", ret_code=10006), True),
    (dma_client.DMAError(400, "opaque message", ret_code=10016), True),
    (dma_client.DMAError(400, "opaque message", ret_code=10001), False),
    (dma_client.DMAError(400, "params error"), False),
    (dma_client.DMAError(401, "Invalid signature"), False),
])
def test_is_retryable_classification(exc, retryable):
    assert history_sync._is_retryable(exc) is retryable


def test_is_rate_limit_classification():
    assert dma_client.is_rate_limit(dma_client.DMAError(429, "x")) is True
    assert dma_client.is_rate_limit(dma_client.DMAError(400, "x", ret_code=10006)) is True
    assert dma_client.is_rate_limit(dma_client.DMAError(400, "Rate limit hit")) is True
    assert dma_client.is_rate_limit(dma_client.DMAError(400, "params error")) is False
    assert dma_client.is_rate_limit(dma_client.DMAError(502, "network")) is False
    assert dma_client.is_rate_limit(RuntimeError("boom")) is False


def test_budget_exhaustion_stops_run_and_next_run_completes(monkeypatch, fake_db):
    calls, _ = _install(monkeypatch, trades=THREE_FILLS)
    monkeypatch.setattr(history_sync, "_MAX_REQUESTS_PER_RUN", 2)

    asyncio.run(history_sync.sync_kind(db.TRADES))
    assert len(_exec_calls(calls)) == 2, "the third window must not be requested"
    assert set(fake_db[db.TRADES]) == {"e1", "e2"}, \
        "budget stop keeps coverage contiguous — nothing beyond the last window"
    assert history_sync.last_synced_ms(db.TRADES) is None, \
        "a budget-stopped run did NOT reach `now` — it must not claim freshness"

    asyncio.run(history_sync.sync_kind(db.TRADES))  # fresh budget
    assert set(fake_db[db.TRADES]) == {"e1", "e2", "e3"}, \
        "the next run resumes from the watermark and finishes the job"
    assert history_sync.last_synced_ms(db.TRADES) == FIXED_NOW_MS


def test_dense_span_is_capped_but_run_continues(monkeypatch, fake_db):
    # 150 closed-pnl rows on the SAME millisecond in window 1: time-bisection can
    # never separate them, so 100 (the page cap) are kept — and the run must NOT
    # stop: the later window's record still arrives.
    dense = [_pnl(f"dense-{i}", W1_TS) for i in range(150)]
    _install(monkeypatch, pnls=dense + [_pnl("late", W3_TS)])

    totals = asyncio.run(history_sync.sync_kind(db.CLOSED_PNL))

    assert f"late:{W3_TS}" in fake_db[db.CLOSED_PNL], "run continued past the dense span"
    assert len(fake_db[db.CLOSED_PNL]) == dma_client._HISTORY_PAGE_LIMIT + 1
    assert totals["windows"] == 3, "density truncation never aborts the walk"


def test_records_without_identity_are_skipped_and_counted(monkeypatch, fake_db):
    trades = [_fill("e1", FIXED_NOW_MS - 1_000),
              {"symbol": "BTCUSDT", "execTime": str(FIXED_NOW_MS - 2_000)}]  # no execId
    _install(monkeypatch, trades=trades, backfill_days=5)

    totals = asyncio.run(history_sync.sync_kind(db.TRADES))

    assert set(fake_db[db.TRADES]) == {"e1"}
    assert totals["skipped"] == 1


def test_doc_builders_identity_and_timestamp():
    from datetime import datetime, timezone
    at = datetime.now(timezone.utc)

    doc = history_sync._trade_doc({"execId": "e9", "execTime": "123"}, at)
    assert doc["_id"] == "e9" and doc["tsMs"] == 123 and doc["syncedAt"] is at
    assert history_sync._trade_doc({"orderId": "o", "execTime": "1"}, at) is None

    doc = history_sync._pnl_doc({"orderId": "o9", "updatedTime": "456"}, at)
    assert doc["_id"] == "o9:456" and doc["tsMs"] == 456
    # Identity needs BOTH parts non-empty: an empty updatedTime would mint a
    # second _id if the gateway later fills it in (double-counted close).
    assert history_sync._pnl_doc({"orderId": "o9", "updatedTime": "", "createdTime": "789"}, at) is None
    assert history_sync._pnl_doc({"updatedTime": "456"}, at) is None
    assert history_sync._pnl_doc({"closedPnl": "1.0"}, at) is None


def test_doc_builders_strip_mongo_hostile_keys():
    from datetime import datetime, timezone
    at = datetime.now(timezone.utc)
    doc = history_sync._trade_doc(
        {"execId": "e1", "execTime": "123", "$where": "1", "a.b": "x", "ok": "y",
         "nested": {"$inc": 1, "fine": 2}, "arr": [{"c.d": 3, "keep": 4}]}, at
    )
    assert "$where" not in doc and "a.b" not in doc and doc["ok"] == "y", \
        "$-prefixed/dotted keys would abort the bulk write and wedge the sync"
    assert doc["nested"] == {"fine": 2} and doc["arr"] == [{"keep": 4}], \
        "hostile keys must be stripped at ANY nesting depth"


def test_deep_rescan_budget_exhaustion_does_not_starve_incremental(monkeypatch, fake_db):
    calls, _ = _install(monkeypatch, trades=THREE_FILLS)
    fake_db[db.TRADES]["seed"] = {"_id": "seed", "tsMs": FIXED_NOW_MS - 1_000, "execId": "seed"}
    history_sync._last_deep_rescan_ms[db.TRADES] = 0        # deep pass due
    monkeypatch.setattr(history_sync, "_MAX_REQUESTS_PER_RUN", 2)

    asyncio.run(history_sync.sync_kind(db.TRADES))          # deep pass, budget dies
    assert history_sync._last_deep_rescan_ms[db.TRADES] == FIXED_NOW_MS, \
        "an unfinishable deep pass must still stamp, or it would re-select " \
        "itself every run and starve the incremental tail where NEW fills land"

    calls.clear()
    asyncio.run(history_sync.sync_kind(db.TRADES))          # back to cheap resume
    assert len(_exec_calls(calls)) == 1, "next run is a plain watermark-overlap resume"
    assert history_sync.last_synced_ms(db.TRADES) == FIXED_NOW_MS, \
        "freshness recovers immediately after the deep attempt"


def test_to_int_ms_tolerates_float_strings():
    assert dma_client._to_int_ms("1699999999999.0") == 1699999999999
    assert dma_client._to_int_ms("1699999999999") == 1699999999999
    assert dma_client._to_int_ms("garbage") == 0


def test_unparseable_or_future_timestamps_are_skipped(monkeypatch, fake_db):
    trades = [
        _fill("good", FIXED_NOW_MS - 1_000),
        _fill("no-ts", FIXED_NOW_MS - 2_000) | {"execTime": ""},          # tsMs=0
        _fill("future", FIXED_NOW_MS + 3 * DAY_MS),                       # poison watermark
    ]
    # The future record must be served by the gateway to be a threat: widen the
    # fake's window match by handing it back regardless of range.
    calls, handlers = _install(monkeypatch, trades=[], backfill_days=5)
    handlers["fn"] = lambda path, s, e: [dict(t) for t in trades] if "/v5/execution/list" in path else []

    totals = asyncio.run(history_sync.sync_kind(db.TRADES))

    assert set(fake_db[db.TRADES]) == {"good"}
    assert totals["skipped"] == 2, "tsMs=0 and far-future records are both skipped"
    assert asyncio.run(_watermark()) == FIXED_NOW_MS - 1_000


async def _watermark():
    return await db.latest_ts_ms(db.TRADES)


def test_hourly_deep_rescan_recovers_late_visible_records(monkeypatch, fake_db):
    calls, _ = _install(monkeypatch, trades=THREE_FILLS)
    # Seed a recent watermark: a plain resume would only cover the last ~2h
    # and never see the older fills (late-visibility scenario).
    fake_db[db.TRADES]["seed"] = {"_id": "seed", "tsMs": FIXED_NOW_MS - 1_000, "execId": "seed"}
    history_sync._last_deep_rescan_ms[db.TRADES] = 0  # deep pass is due

    asyncio.run(history_sync.sync_kind(db.TRADES))

    exec_calls = _exec_calls(calls)
    assert exec_calls[0][1] == FLOOR_MS, \
        "deep rescan covers the whole window (capped by the backfill floor)"
    assert {"e1", "e2", "e3"} <= set(fake_db[db.TRADES]), \
        "late-visible records inside the deep span are recovered"
    assert history_sync._last_deep_rescan_ms[db.TRADES] == FIXED_NOW_MS

    calls.clear()
    asyncio.run(history_sync.sync_kind(db.TRADES))
    assert len(_exec_calls(calls)) == 1, \
        "within the hour the next run is a plain watermark-overlap resume"


def test_sync_all_isolates_kind_failures(monkeypatch, fake_db):
    calls, handlers = _install(monkeypatch, trades=THREE_FILLS, pnls=THREE_PNLS)
    default = handlers["fn"]

    def trades_broken(path, start, end):
        if "/v5/execution/list" in path:
            return _Resp(200, {"retCode": 10001, "retMsg": "params error"})
        return default(path, start, end)

    handlers["fn"] = trades_broken
    asyncio.run(history_sync.sync_all())  # must not raise

    assert not fake_db[db.TRADES], "failed kind stored nothing"
    assert len(fake_db[db.CLOSED_PNL]) == 3, "the other kind still synced fully"


# ---- transaction-log mirror (probational endpoint) ---------------------------

def _txn(txn_id, ts, type_="TRADE", symbol="BTCUSDT"):
    return {"id": txn_id, "symbol": symbol, "type": type_, "currency": "USDT",
            "side": "Buy", "change": "-0.05", "cashFlow": "0",
            "cashBalance": "1000", "fee": "0.05", "tradeId": f"t-{txn_id}",
            "orderId": f"o-{txn_id}", "transactionTime": str(ts)}


def test_txn_doc_identity_prefers_id_with_composite_fallback():
    from datetime import datetime, timezone
    at = datetime.now(timezone.utc)

    doc = history_sync._txn_doc(_txn("tx1", 123), at)
    assert doc["_id"] == "tx1" and doc["tsMs"] == 123 and doc["syncedAt"] is at

    # No gateway id -> deterministic composite of the uniqueness fields.
    rec = _txn("", 456)
    doc = history_sync._txn_doc(rec, at)
    assert doc["_id"] == "456:TRADE:USDT:t-:o-:-0.05:1000"

    # No usable timestamp -> no identity, no range key: skip.
    assert history_sync._txn_doc({"id": "x", "type": "TRADE"}, at) is None
    assert history_sync._txn_doc({"id": "x", "transactionTime": "junk"}, at) is None


def test_transaction_window_requests_limit_50_and_account_type(monkeypatch):
    seen = {}

    async def fake_get(url, headers=None):
        parsed = urlparse(url)
        seen.update(path=parsed.path, q=parse_qs(parsed.query))
        return _Resp(200, {"retCode": 0, "result": {"list": []}})

    monkeypatch.setattr(dma_client._client, "get", fake_get)
    state = dma_client.new_history_state(page_limit=dma_client.TXN_PAGE_LIMIT)
    asyncio.run(dma_client.get_transaction_log_window(0, 1000, state))
    assert seen["path"].endswith("/v5/account/transaction-log")
    # 50 (the endpoint's cap), NOT the 100 of the other history endpoints —
    # limit=100 would make a full 50-record page look unsaturated (data loss).
    assert seen["q"]["limit"] == ["50"]
    assert seen["q"]["accountType"] == ["UNIFIED"]
    assert seen["q"]["category"] == ["linear"]


def test_transaction_sync_cold_start_stores_rows(monkeypatch, fake_db):
    txns = [_txn("t1", W1_TS), _txn("t2", W2_TS), _txn("t3", W3_TS)]
    calls, handlers = _install(monkeypatch)
    default = handlers["fn"]
    handlers["fn"] = (
        lambda path, s, e: _page(txns, s, e, "transactionTime")
        if "transaction-log" in path else default(path, s, e)
    )

    asyncio.run(history_sync.sync_kind(db.TRANSACTIONS))

    assert set(fake_db[db.TRANSACTIONS]) == {"t1", "t2", "t3"}
    assert fake_db[db.TRANSACTIONS]["t2"]["tsMs"] == W2_TS
    txn_calls = [c for c in calls if "transaction-log" in c[0]]
    starts = [c[1] for c in txn_calls]
    assert len(txn_calls) == 3 and starts == sorted(starts), \
        "same cursor-free ascending-window walk as the other kinds"
    assert history_sync.last_synced_ms(db.TRANSACTIONS) == FIXED_NOW_MS


def test_unsupported_transaction_endpoint_disables_kind_without_alert(monkeypatch, fake_db):
    calls, handlers = _install(monkeypatch, trades=THREE_FILLS, pnls=THREE_PNLS)
    default = handlers["fn"]
    handlers["fn"] = (
        lambda path, s, e: _Resp(404, {"message": "no such route"})
        if "transaction-log" in path else default(path, s, e)
    )
    alerts = []

    async def fake_notify(text):
        alerts.append(text)

    monkeypatch.setattr(history_sync.notifier, "notify", fake_notify)

    asyncio.run(history_sync.sync_all())
    assert history_sync.is_unsupported(db.TRANSACTIONS)
    assert set(fake_db[db.TRADES]) == {"e1", "e2", "e3"}, "other kinds unaffected"
    assert len(fake_db[db.CLOSED_PNL]) == 3
    probe_calls = len([c for c in calls if "transaction-log" in c[0]])
    assert probe_calls == 1, "a 404 is non-retryable: the probe is ONE request"

    # Subsequent runs skip the kind entirely — no re-probing every minute.
    for _ in range(4):
        asyncio.run(history_sync.sync_all())
    assert len([c for c in calls if "transaction-log" in c[0]]) == probe_calls
    assert alerts == [], "a capability verdict must never page the operator"
    assert history_sync._consecutive_failures[db.TRANSACTIONS] == 0
    assert history_sync.last_synced_ms(db.TRANSACTIONS) is None


def test_transaction_endpoint_5xx_is_an_incident_not_a_verdict(monkeypatch, fake_db):
    calls, handlers = _install(monkeypatch)
    default = handlers["fn"]
    handlers["fn"] = (
        lambda path, s, e: _Resp(503, {"message": "service unavailable"})
        if "transaction-log" in path else default(path, s, e)
    )

    asyncio.run(history_sync.sync_all())  # must not raise (failure isolation)

    assert not history_sync.is_unsupported(db.TRANSACTIONS), \
        "only 404/405 is a capability verdict; a 5xx must keep retrying"
    assert history_sync._consecutive_failures[db.TRANSACTIONS] == 1
