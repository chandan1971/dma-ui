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


# ---------------------------------------------------------------------------
# /api/strategy/trades
# ---------------------------------------------------------------------------
def test_api_strategy_trades(admin_client, monkeypatch):
    fills = [fill("Buy", 0.5, 100, 0.03, 1, oid="o1")]

    async def ids(**kw):
        return ["o1"]

    async def fills_for(order_ids):
        assert order_ids == ["o1"]
        return fills

    async def tickers(sym=None):
        return {"retCode": 0, "result": {"list": [{"symbol": sym, "markPrice": "104"}]}}
    monkeypatch.setattr(db, "strategy_order_ids", ids)
    monkeypatch.setattr(db, "fills_for_orders", fills_for)
    monkeypatch.setattr(dma_client, "get_tickers", tickers)
    r = admin_client.get("/api/strategy/trades")
    assert r.status_code == 200
    body = r.json()
    assert body["trades"][0]["unrealisedPnl"] == pytest.approx(2.0)
    assert body["totals"]["fees"] == pytest.approx(0.03)


def test_api_strategy_trades_mongo_down_is_503(admin_client, monkeypatch):
    from pymongo.errors import PyMongoError

    async def boom(**kw):
        raise PyMongoError("down")
    monkeypatch.setattr(db, "strategy_order_ids", boom)
    assert admin_client.get("/api/strategy/trades").status_code == 503
