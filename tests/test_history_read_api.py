"""MongoDB-backed history read endpoints (/api/closed-pnl, /api/executions).

The dashboard renders these responses unchanged, so the envelope and row shape
must be byte-identical to the old exchange passthrough: raw records only (no
_id/tsMs/syncedAt), newest-first, inside {"retCode":0,"result":{"list":...}}.
"""
from pymongo.errors import PyMongoError

from app import db as db_mod, history_sync, main as main_mod

DAY_MS = 24 * 60 * 60 * 1000
FIXED_NOW_MS = 1_800_000_000_000


def _freeze_now(monkeypatch):
    monkeypatch.setattr(main_mod.time, "time", lambda: FIXED_NOW_MS / 1000)


def _capture_query(monkeypatch, rows=None):
    """Replace db.query_history with an arg-capturing fake."""
    captured = {}

    async def fake_query(kind, *, symbol, start_ms, end_ms, limit):
        captured.update(kind=kind, symbol=symbol, start_ms=start_ms,
                        end_ms=end_ms, limit=limit)
        return list(rows or [])

    monkeypatch.setattr(db_mod, "query_history", fake_query)
    return captured


def test_closed_pnl_envelope_and_raw_row_passthrough(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch)
    older = {"orderId": "o1", "symbol": "BTCUSDT", "side": "Sell", "qty": "2",
             "avgEntryPrice": "100", "avgExitPrice": "101", "closedPnl": "2.0",
             "leverage": "10", "updatedTime": str(FIXED_NOW_MS - 2_000),
             "createdTime": str(FIXED_NOW_MS - 3_000)}
    newer = {"orderId": "o2", "symbol": "ETHUSDT", "side": "Buy", "qty": "1",
             "avgEntryPrice": "50", "avgExitPrice": "49", "closedPnl": "-1.0",
             "leverage": "5", "updatedTime": str(FIXED_NOW_MS - 1_000),
             "createdTime": str(FIXED_NOW_MS - 1_500)}
    for raw in (older, newer):
        _id = f"{raw['orderId']}:{raw['updatedTime']}"
        fake_db[db_mod.CLOSED_PNL][_id] = {
            **raw, "_id": _id, "tsMs": int(raw["updatedTime"]), "syncedAt": "X",
        }

    resp = admin_client.get("/api/closed-pnl")
    assert resp.status_code == 200
    body = resp.json()
    assert body["retCode"] == 0 and body["retMsg"] == "OK"
    assert body["result"]["category"] == "linear"
    assert body["result"]["truncated"] is False
    assert body["result"]["lastSyncedMs"] is None, "no sync has completed yet"
    assert body["result"]["nowMs"] == FIXED_NOW_MS, \
        "server clock included so the browser measures staleness skew-free"
    assert body["result"]["list"] == [newer, older], \
        "raw rows only (no _id/tsMs/syncedAt), newest-first"


def test_envelope_reports_last_synced_time(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    _capture_query(monkeypatch)
    monkeypatch.setattr(history_sync, "_last_synced_ms",
                        {db_mod.TRADES: 111_000, db_mod.CLOSED_PNL: 222_000})

    assert admin_client.get("/api/closed-pnl").json()["result"]["lastSyncedMs"] == 222_000
    assert admin_client.get("/api/executions?days=7").json()["result"]["lastSyncedMs"] == 111_000
    assert admin_client.get("/api/executions").json()["result"]["lastSyncedMs"] == 111_000


def test_closed_pnl_days_clamping_and_range(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    for query, want_days in (("", 30), ("?days=0", 30), ("?days=7", 7), ("?days=1000", 31)):
        resp = admin_client.get(f"/api/closed-pnl{query}")
        assert resp.status_code == 200
        assert captured["kind"] == db_mod.CLOSED_PNL
        assert captured["end_ms"] == FIXED_NOW_MS
        assert captured["start_ms"] == FIXED_NOW_MS - want_days * DAY_MS
        assert captured["limit"] == main_mod._HISTORY_READ_MAX


def test_symbol_is_normalized_or_rejected(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    assert admin_client.get("/api/closed-pnl?symbol=btcusdt").status_code == 200
    assert captured["symbol"] == "BTCUSDT"

    assert admin_client.get("/api/executions?symbol=btcusdt&days=7").status_code == 200
    assert captured["symbol"] == "BTCUSDT"

    resp = admin_client.get("/api/closed-pnl?symbol=bad!sym")
    assert resp.status_code == 400


def test_truncated_flag_when_read_cap_hit(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    rows = [{"orderId": f"o{i}", "closedPnl": "1"} for i in range(2)]
    _capture_query(monkeypatch, rows=rows)
    monkeypatch.setattr(main_mod, "_HISTORY_READ_MAX", 2)

    body = admin_client.get("/api/closed-pnl").json()
    assert body["result"]["truncated"] is True, \
        "a full page means the range may hold more than the cap"

    monkeypatch.setattr(main_mod, "_HISTORY_READ_MAX", 10)
    body = admin_client.get("/api/closed-pnl").json()
    assert body["result"]["truncated"] is False


def test_executions_days_branch_ignores_single_page_params(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    resp = admin_client.get("/api/executions?days=30&limit=7&startTime=1&endTime=2")
    assert resp.status_code == 200
    assert captured["kind"] == db_mod.TRADES
    assert captured["start_ms"] == FIXED_NOW_MS - 30 * DAY_MS
    assert captured["end_ms"] == FIXED_NOW_MS
    assert captured["limit"] == main_mod._HISTORY_READ_MAX, \
        "History-tab branch keeps the old semantics: limit/startTime/endTime ignored"


def test_executions_explorer_defaults_mimic_the_old_gateway_call(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    # No params: last 7 days, limit 50 (the gateway's defaults).
    assert admin_client.get("/api/executions").status_code == 200
    assert captured["kind"] == db_mod.TRADES
    assert captured["limit"] == 50
    assert (captured["start_ms"], captured["end_ms"]) == \
        (FIXED_NOW_MS - 7 * DAY_MS, FIXED_NOW_MS)

    # limit is clamped to the gateway's 1..100.
    admin_client.get("/api/executions?limit=250")
    assert captured["limit"] == 100

    # startTime only -> [start, start + 7d]; endTime only -> [end - 7d, end].
    admin_client.get("/api/executions?startTime=1000000")
    assert (captured["start_ms"], captured["end_ms"]) == (1000000, 1000000 + 7 * DAY_MS)
    admin_client.get("/api/executions?endTime=9000000000")
    assert (captured["start_ms"], captured["end_ms"]) == (9000000000 - 7 * DAY_MS, 9000000000)

    # Garbage inputs are rejected locally, never queried.
    assert admin_client.get("/api/executions?limit=abc").status_code == 400
    assert admin_client.get("/api/executions?startTime=abc").status_code == 400
    assert admin_client.get("/api/executions?endTime=-5").status_code == 400
    # Inverted ranges are a caller error, not an empty "no trades" result.
    assert admin_client.get(
        "/api/executions?startTime=9000000000000&endTime=1000"
    ).status_code == 400


def test_custom_range_mode_reads_full_window(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    resp = admin_client.get("/api/closed-pnl?startTime=1000&endTime=2000&symbol=solusdt")
    assert resp.status_code == 200
    assert captured["kind"] == db_mod.CLOSED_PNL
    assert captured["symbol"] == "SOLUSDT"
    assert (captured["start_ms"], captured["end_ms"]) == (1000, 2000)
    assert captured["limit"] == main_mod._HISTORY_READ_MAX

    resp = admin_client.get("/api/executions?startTime=1000&endTime=2000")
    assert resp.status_code == 200
    assert captured["kind"] == db_mod.TRADES
    assert (captured["start_ms"], captured["end_ms"]) == (1000, 2000)
    assert captured["limit"] == main_mod._HISTORY_READ_MAX, \
        "both bounds = History custom range, NOT the 50-row explorer page"

    # days still wins over an accompanying range (both endpoints agree).
    admin_client.get("/api/closed-pnl?days=7&startTime=1000&endTime=2000")
    assert captured["start_ms"] == FIXED_NOW_MS - 7 * DAY_MS


def test_custom_range_validation(admin_client, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)

    assert admin_client.get("/api/closed-pnl?startTime=1000").status_code == 400, \
        "one-sided range is a caller error on closed-pnl"
    assert admin_client.get("/api/closed-pnl?startTime=2000&endTime=1000").status_code == 400

    # "Overall" (epoch 0 -> now) is a legitimate range: the indexed, row-capped
    # read makes a wide span cost the same as a narrow one — never a 400.
    for path in ("/api/closed-pnl", "/api/executions"):
        resp = admin_client.get(f"{path}?startTime=0&endTime={FIXED_NOW_MS}")
        assert resp.status_code == 200, path
        assert (captured["start_ms"], captured["end_ms"]) == (0, FIXED_NOW_MS)
        assert captured["limit"] == main_mod._HISTORY_READ_MAX


def test_mongo_outage_maps_to_503(admin_client, monkeypatch):
    _freeze_now(monkeypatch)

    async def broken_query(kind, **kwargs):
        raise PyMongoError("connection refused")

    monkeypatch.setattr(db_mod, "query_history", broken_query)

    for path in ("/api/closed-pnl", "/api/executions?days=7", "/api/executions"):
        resp = admin_client.get(path)
        assert resp.status_code == 503, path
        assert resp.json()["detail"] == "history database unavailable"


# ---- /api/transactions (transaction-log mirror) -----------------------------

def test_transactions_envelope_and_raw_row_passthrough(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch)
    row = {"id": "tx1", "symbol": "BTCUSDT", "type": "TRADE", "currency": "USDT",
           "side": "Buy", "change": "-0.05", "cashBalance": "1000",
           "transactionTime": str(FIXED_NOW_MS - 1_000)}
    fake_db[db_mod.TRANSACTIONS]["tx1"] = {
        **row, "_id": "tx1", "tsMs": FIXED_NOW_MS - 1_000, "syncedAt": "X",
    }

    resp = admin_client.get("/api/transactions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["retCode"] == 0
    assert body["result"]["list"] == [row], \
        "raw rows only (no _id/tsMs/syncedAt; the gateway's own `id` stays)"
    assert body["result"]["lastSyncedMs"] is None
    assert body["result"]["nowMs"] == FIXED_NOW_MS


def test_transactions_default_range_and_symbol_filter(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch)
    captured = _capture_query(monkeypatch)
    resp = admin_client.get("/api/transactions", params={"symbol": "ethusdt"})
    assert resp.status_code == 200
    assert captured["kind"] == db_mod.TRANSACTIONS
    assert captured["symbol"] == "ETHUSDT"
    assert captured["end_ms"] == FIXED_NOW_MS
    assert captured["end_ms"] - captured["start_ms"] == 30 * DAY_MS, \
        "same default 30-day preset as /api/closed-pnl"


def test_transactions_501_when_gateway_lacks_endpoint(admin_client, monkeypatch):
    monkeypatch.setattr(history_sync, "_unsupported", {db_mod.TRANSACTIONS})
    resp = admin_client.get("/api/transactions")
    assert resp.status_code == 501
    assert "transaction log" in resp.json()["detail"]
