"""Strategy trade ledger (app/strategy_ledger.py) and /api/strategy/trades:
real-fill accounting — avg entry/exit, fees, net realised, mark-based
unrealised, partial fills and the zero-crossing reversal split."""
import pytest

from app import db, dma_client
from app import strategy_ledger as lg


def fill(side, qty, px, fee, ts, sym="SOLUSDT", exec_type="Trade", oid="o"):
    return {"symbol": sym, "side": side, "execQty": str(qty), "execPrice": str(px),
            "execFee": str(fee), "tsMs": ts, "execType": exec_type,
            "execId": f"e{ts}", "orderId": oid}


def test_closed_long_net_of_fees():
    t, = lg.build_trades([fill("Buy", 0.5, 100, 0.03, 1), fill("Sell", 0.5, 110, 0.033, 2)])
    assert t["status"] == "CLOSED" and t["side"] == "LONG"
    assert t["entryPrice"] == pytest.approx(100) and t["exitPrice"] == pytest.approx(110)
    assert t["fees"] == pytest.approx(0.063)
    assert t["realisedPnl"] == pytest.approx(5 - 0.063)
    assert t["unrealisedPnl"] is None and t["closedMs"] == 2


def test_closed_short_profit_on_fall():
    t, = lg.build_trades([fill("Sell", 2, 50, 0.01, 1), fill("Buy", 2, 45, 0.01, 2)])
    assert t["side"] == "SHORT"
    assert t["realisedPnl"] == pytest.approx(10 - 0.02)


def test_open_trade_unrealised_at_mark_and_entry_fee_in_realised():
    t, = lg.build_trades([fill("Buy", 0.5, 100, 0.03, 1)], {"SOLUSDT": 104})
    assert t["status"] == "OPEN" and t["openQty"] == pytest.approx(0.5)
    assert t["unrealisedPnl"] == pytest.approx(2.0)
    assert t["realisedPnl"] == pytest.approx(-0.03)
    assert t["netPnl"] == pytest.approx(1.97)
    assert t["markPrice"] == 104 and t["exitPrice"] is None


def test_open_trade_without_mark_has_no_unrealised():
    t, = lg.build_trades([fill("Buy", 0.5, 100, 0.03, 1)])
    assert t["unrealisedPnl"] is None


def test_partial_entry_fills_average_price():
    t, = lg.build_trades([fill("Buy", 0.2, 100, 0.01, 1), fill("Buy", 0.3, 105, 0.02, 2)])
    assert t["entryPrice"] == pytest.approx((20 + 31.5) / 0.5)
    assert t["qty"] == pytest.approx(0.5) and t["fees"] == pytest.approx(0.03)


def test_partial_exit_keeps_trade_open():
    t, = lg.build_trades([fill("Buy", 1, 100, 0, 1), fill("Sell", 0.4, 110, 0, 2)], {"SOLUSDT": 120})
    assert t["status"] == "OPEN" and t["openQty"] == pytest.approx(0.6)
    assert t["realisedPnl"] == pytest.approx(4.0)
    assert t["unrealisedPnl"] == pytest.approx(12.0)


def test_reversal_fill_crossing_zero_is_split_with_prorated_fee():
    # Long 0.5 @100, then ONE sell fill of 1.0 @90 closes it and opens short 0.5.
    trades = lg.build_trades([fill("Buy", 0.5, 100, 0.05, 1), fill("Sell", 1.0, 90, 0.10, 2)],
                             {"SOLUSDT": 80})
    short, long_ = trades                      # newest first (same ts sort: long opened first)
    assert long_["status"] == "CLOSED"
    assert long_["realisedPnl"] == pytest.approx(-5 - 0.05 - 0.05)
    assert short["side"] == "SHORT" and short["entryPrice"] == pytest.approx(90)
    assert short["fees"] == pytest.approx(0.05)
    assert short["unrealisedPnl"] == pytest.approx(5.0)


def test_maker_rebate_negative_fee_increases_pnl():
    t, = lg.build_trades([fill("Buy", 1, 100, -0.01, 1), fill("Sell", 1, 100, -0.01, 2)])
    assert t["realisedPnl"] == pytest.approx(0.02)


def test_funding_rows_ignored_and_symbols_separate():
    trades = lg.build_trades([
        fill("Buy", 1, 100, 0, 1),
        fill("Sell", 1, 100, 0.5, 2, exec_type="Funding"),
        fill("Sell", 0.01, 2500, 0, 3, sym="ETHUSDT"),
    ])
    assert {t["symbol"] for t in trades} == {"SOLUSDT", "ETHUSDT"}
    assert all(t["status"] == "OPEN" for t in trades)


def test_totals():
    trades = lg.build_trades([fill("Buy", 1, 100, 0.1, 1), fill("Sell", 1, 110, 0.1, 2),
                              fill("Buy", 1, 100, 0.1, 3)], {"SOLUSDT": 105})
    tot = lg.totals(trades)
    assert tot["trades"] == 2 and tot["open"] == 1
    assert tot["fees"] == pytest.approx(0.3)
    assert tot["realisedPnl"] == pytest.approx(10 - 0.2 - 0.1)
    assert tot["unrealisedPnl"] == pytest.approx(5)


def test_opening_position_before_window_has_unknown_entry():
    # Short 0.5 held before the window; only its exit fill is in history.
    trades = lg.build_trades([fill("Buy", 0.5, 90, 0.02, 5)], opening={"SOLUSDT": -0.5})
    t, = trades
    assert t["status"] == "CLOSED" and t["side"] == "SHORT"
    assert t["entryBeforeWindow"] is True and t["entryPrice"] is None
    assert t["exitPrice"] == pytest.approx(90)
    assert t["realisedPnl"] is None and t["netPnl"] is None
    assert t["fees"] == pytest.approx(0.02)


def test_opening_position_still_open_without_fills():
    t, = lg.build_trades([], {"SOLUSDT": 100}, opening={"SOLUSDT": 1.0})
    assert t["status"] == "OPEN" and t["entryBeforeWindow"] is True
    assert t["unrealisedPnl"] is None
    tot = lg.totals([t])
    assert tot["entryBeforeWindow"] == 1 and tot["netPnl"] == 0


def test_trade_after_unknown_one_is_fully_known():
    trades = lg.build_trades([fill("Sell", 1, 100, 0, 1), fill("Buy", 1, 100, 0, 2),
                              fill("Sell", 1, 90, 0, 3)], opening={"SOLUSDT": 1.0})
    known, unknown = trades                            # newest first
    assert unknown["entryBeforeWindow"] is True        # pre-window long, closed @100
    assert unknown["exitPrice"] == pytest.approx(100)
    assert known["entryBeforeWindow"] is False         # new long 100 -> 90
    assert known["entryPrice"] == pytest.approx(100)
    assert known["realisedPnl"] == pytest.approx(-10)


# ---------------------------------------------------------------------------
# /api/strategy/trades — exchange-backed, no database
# ---------------------------------------------------------------------------
def _patch_exchange(monkeypatch, fills_by_sym, positions):
    async def execs(symbol=None, days=None):
        return {"retCode": 0, "result": {"list": fills_by_sym.get(symbol, []), "truncated": False}}

    async def pos(symbol):
        return {"retCode": 0, "result": {"list": positions.get(symbol, [])}}
    monkeypatch.setattr(dma_client, "get_executions_history", execs)
    monkeypatch.setattr(dma_client, "get_position_by_symbol", pos)


def test_api_strategy_trades_from_exchange(admin_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "STRATEGY_SYMBOLS", ["SOLUSDT"])
    _patch_exchange(monkeypatch,
                    {"SOLUSDT": [fill("Buy", 0.5, 100, 0.03, 1),
                                 fill("Sell", 0.5, 0, 0.1, 2, exec_type="Funding")]},
                    {"SOLUSDT": [{"symbol": "SOLUSDT", "side": "Buy", "size": "0.5", "markPrice": "104"}]})
    r = admin_client.get("/api/strategy/trades")
    assert r.status_code == 200
    body = r.json()
    t, = body["trades"]
    assert t["entryBeforeWindow"] is False
    assert t["unrealisedPnl"] == pytest.approx(2.0)
    assert body["totals"]["fees"] == pytest.approx(0.03)
    assert body["days"] == 30


def test_api_strategy_trades_seeds_position_opened_before_window(admin_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "STRATEGY_SYMBOLS", ["SOLUSDT"])
    _patch_exchange(monkeypatch, {"SOLUSDT": []},
                    {"SOLUSDT": [{"symbol": "SOLUSDT", "side": "Sell", "size": "0.4", "markPrice": "95"}]})
    t, = admin_client.get("/api/strategy/trades").json()["trades"]
    assert t["side"] == "SHORT" and t["entryBeforeWindow"] is True and t["status"] == "OPEN"


def test_mongo_optional_get_client_raises_pymongo_error(monkeypatch):
    from pymongo.errors import PyMongoError
    from app.config import settings
    monkeypatch.setattr(settings, "MONGO_URI", "")
    with pytest.raises(PyMongoError):
        db.get_client()
    assert "MONGO_URI" not in settings.missing_required()
