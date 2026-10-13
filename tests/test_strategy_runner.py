"""Strategy runner (app/strategy_runner.py): closed-bar verification, limit /
reduce-only order construction, live-vs-dry-run gating, exit chasing, restart
arming and hedge-mode refusal — against an in-memory fake exchange."""
import asyncio

import pytest

from app import db, dma_client, market_data, notifier
from app import strategy as st
from app import strategy_runner as sr
from app.config import settings

SYM = "BTCUSDT"
BAR = sr.BAR_MS
NOW = 100 * BAR + 30_000          # 30s after a 4h boundary
LAST_CLOSED = 99 * BAR


def _klines(last_closed_t, close=100.0, n=5):
    """Bybit shape, newest first, including one forming bar on top."""
    rows = [[str(last_closed_t + BAR), "1", "1", "1", str(close), "0", "0"]]
    for k in range(n):
        rows.append([str(last_closed_t - k * BAR), "1", "1", "1", str(close), "0", "0"])
    return {"retCode": 0, "result": {"list": rows}}


class FakeExchange:
    def __init__(self):
        self.position = (None, "0")   # (side "Buy"/"Sell"/None, size)
        self.pos_idx = "0"
        self.orders: list[dict] = []
        self.cancelled: list[str] = []
        self.leverage_calls = 0
        self.kline_last = LAST_CLOSED
        self.close = 100.0

    async def kline(self, sym, interval, limit):
        return _klines(self.kline_last, self.close)

    async def instruments(self, sym):
        return {"result": {"list": [{"symbol": sym,
                                      "lotSizeFilter": {"qtyStep": "0.001", "minOrderQty": "0.001"},
                                      "priceFilter": {"tickSize": "0.1"}}]}}

    async def position_by_symbol(self, sym):
        side, size = self.position
        return {"result": {"list": [{"symbol": sym, "side": side or "", "size": size,
                                      "positionIdx": self.pos_idx}]}}

    async def create_order(self, body):
        self.orders.append(body)
        return {"retCode": 0, "result": {"orderId": f"o{len(self.orders)}"}}

    async def cancel_order(self, sym, oid):
        self.cancelled.append(oid)
        return {"retCode": 0}

    async def set_leverage(self, sym, b, s):
        self.leverage_calls += 1
        raise dma_client.DMAError(400, "leverage not modified", ret_code=110043)


@pytest.fixture
def ex(monkeypatch):
    fx = FakeExchange()
    monkeypatch.setattr(market_data, "get_kline_uncached", fx.kline)
    monkeypatch.setattr(dma_client, "get_instruments", fx.instruments)
    monkeypatch.setattr(dma_client, "get_position_by_symbol", fx.position_by_symbol)
    monkeypatch.setattr(dma_client, "create_order", fx.create_order)
    monkeypatch.setattr(dma_client, "cancel_order", fx.cancel_order)
    monkeypatch.setattr(dma_client, "set_leverage", fx.set_leverage)

    async def _quiet(text):
        return None
    monkeypatch.setattr(notifier, "notify", _quiet)
    # Order registry (Mongo) — in-memory stand-in.
    fx.registry = {}

    async def reg_insert(doc):
        fx.registry[doc["_id"]] = doc

    async def reg_ids(symbol=None, bar_t=None):
        return [k for k, d in fx.registry.items()
                if (symbol is None or d["symbol"] == symbol)
                and (bar_t is None or d["barT"] == bar_t)]
    monkeypatch.setattr(db, "strategy_order_insert", reg_insert)
    monkeypatch.setattr(db, "strategy_order_ids", reg_ids)
    monkeypatch.setattr(sr, "_state", {})
    monkeypatch.setattr(sr, "_instruments", {})
    monkeypatch.setattr(sr, "_leverage_ok", set())
    monkeypatch.setattr(settings, "STRATEGY_LIVE", True)
    monkeypatch.setattr(settings, "STRATEGY_NOTIONAL", 50.0)
    monkeypatch.setattr(settings, "STRATEGY_NOTIONAL_OVERRIDES", {})
    monkeypatch.setattr(st, "REVERSE_ON_EXIT", True)
    return fx


def _force(monkeypatch, signal, ema200):
    """Pin the last bar's signal / EMA200 — the indicator math has its own tests."""
    monkeypatch.setattr(st, "signal_at", lambda ind, closes, i: signal)
    real = st.indicators

    def fake_ind(closes):
        ind = real(closes)
        ind["ema200"] = [ema200] * len(closes)
        return ind
    monkeypatch.setattr(st, "indicators", fake_ind)


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def test_entry_qty_floors_to_step_and_respects_min():
    assert sr.entry_qty(50, 61234.5, "0.001", "0.001") is None             # 0.0008 < min
    assert sr.entry_qty(50, 2500, "0.01", "0.01") == "0.02"
    assert sr.entry_qty(50, 150.37, "0.1", "0.1") == "0.3"


def test_price_str_rounds_to_tick():
    assert sr.price_str(150.374, "0.01") == "150.37"
    assert sr.price_str(61234.56, "0.1") == "61234.6"


def test_expected_last_closed():
    assert sr.expected_last_closed_t(NOW) == LAST_CLOSED


# ---------------------------------------------------------------------------
# process_bar
# ---------------------------------------------------------------------------
def test_flat_buy_above_ema200_places_limit_long(ex, monkeypatch):
    _force(monkeypatch, st.BUY, 90.0)
    snap = run(sr.process_bar(SYM, NOW))
    assert snap["actions"] == ["OPEN_LONG"]
    assert ex.orders == [{"symbol": SYM, "side": "Buy", "orderType": "Limit",
                          "qty": "0.500", "price": "100.0", "timeInForce": "GTC",
                          "positionIdx": 0}]
    assert ex.leverage_calls == 1          # "not modified" tolerated


def test_flat_buy_below_ema200_does_nothing(ex, monkeypatch):
    _force(monkeypatch, st.BUY, 110.0)
    snap = run(sr.process_bar(SYM, NOW))
    assert snap["actions"] == [] and ex.orders == []


def test_long_sell_reverses_with_reduce_only_exit(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 110.0)    # close < EMA200 -> short allowed
    snap = run(sr.process_bar(SYM, NOW))
    assert snap["actions"] == ["CLOSE_LONG", "OPEN_SHORT"]
    exit_o, entry_o = ex.orders
    assert exit_o["side"] == "Sell" and exit_o["reduceOnly"] is True
    assert exit_o["qty"] == "0.48" and exit_o["orderType"] == "Limit"
    assert exit_o["price"] == "100.0"
    assert entry_o["side"] == "Sell" and "reduceOnly" not in entry_o
    assert entry_o["qty"] == "0.500"


def test_long_sell_above_ema200_exits_only(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 90.0)
    snap = run(sr.process_bar(SYM, NOW))
    assert snap["actions"] == ["CLOSE_LONG"]
    assert len(ex.orders) == 1 and ex.orders[0]["reduceOnly"] is True


def test_dry_run_sends_nothing(ex, monkeypatch):
    monkeypatch.setattr(settings, "STRATEGY_LIVE", False)
    _force(monkeypatch, st.BUY, 90.0)
    snap = run(sr.process_bar(SYM, NOW))
    assert ex.orders == [] and ex.leverage_calls == 0
    assert snap["orders"][0]["status"] == "dry-run"


def test_arm_only_records_bar_without_trading(ex, monkeypatch):
    _force(monkeypatch, st.BUY, 90.0)
    run(sr.process_bar(SYM, NOW, arm_only=True))
    assert ex.orders == []
    # Same bar again (e.g. loop woke twice) is still a no-op.
    run(sr.process_bar(SYM, NOW))
    assert ex.orders == []


def test_previous_orders_cancelled_and_exit_chased(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 90.0)
    run(sr.process_bar(SYM, NOW))                       # exit placed: o1
    # Next bar: exit did not fill, no new signal, price moved.
    ex.kline_last, ex.close = LAST_CLOSED + BAR, 95.0
    _force(monkeypatch, None, 90.0)
    snap = run(sr.process_bar(SYM, NOW + BAR))
    assert ex.cancelled == ["o1"]
    assert snap["actions"] == ["CLOSE_LONG"]
    assert ex.orders[-1]["price"] == "95.0" and ex.orders[-1]["reduceOnly"] is True


def test_exit_chase_abandoned_on_same_side_reentry(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 90.0)
    run(sr.process_bar(SYM, NOW))
    ex.kline_last = LAST_CLOSED + BAR
    _force(monkeypatch, st.BUY, 90.0)                   # would re-enter long
    snap = run(sr.process_bar(SYM, NOW + BAR))
    assert snap["actions"] == [] and snap["pending_exit"] is None
    assert len(ex.orders) == 1


def test_pending_exit_cleared_once_flat(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 90.0)
    run(sr.process_bar(SYM, NOW))
    ex.position = (None, "0")                           # exit filled
    ex.kline_last = LAST_CLOSED + BAR
    _force(monkeypatch, None, 90.0)
    snap = run(sr.process_bar(SYM, NOW + BAR))
    assert snap["actions"] == [] and snap["pending_exit"] is None


def test_hedge_mode_refused(ex, monkeypatch):
    ex.pos_idx = "1"
    _force(monkeypatch, st.BUY, 90.0)
    with pytest.raises(sr.StrategyError, match="hedge"):
        run(sr.process_bar(SYM, NOW))
    assert ex.orders == []


def test_bar_not_rolled_yet_retries_then_fails(ex, monkeypatch):
    ex.kline_last = LAST_CLOSED - BAR                   # venue still a bar behind
    calls = []

    async def no_sleep(sec):
        calls.append(sec)
    monkeypatch.setattr(sr.asyncio, "sleep", no_sleep)
    with pytest.raises(sr.StrategyError, match="not available"):
        run(sr.process_bar(SYM, NOW))
    assert len(calls) == sr._FETCH_RETRIES - 1
    assert ex.orders == []


def test_leverage_failure_blocks_entry(ex, monkeypatch):
    async def bad_lev(sym, b, s):
        raise dma_client.DMAError(400, "nope", ret_code=10001)
    monkeypatch.setattr(dma_client, "set_leverage", bad_lev)
    _force(monkeypatch, st.BUY, 90.0)
    with pytest.raises(sr.StrategyError, match="leverage"):
        run(sr.process_bar(SYM, NOW))
    assert ex.orders == []


def test_snapshot_response_shape(ex, monkeypatch):
    _force(monkeypatch, st.BUY, 90.0)
    run(sr.process_bar(SYM, NOW))
    body = sr.snapshot_response()
    assert body["live"] is True and body["notional"][SYM] == 50.0
    assert body["symbols"][SYM]["signal"] == st.BUY


def test_placed_orders_recorded_in_registry(ex, monkeypatch):
    ex.position = ("Buy", "0.48")
    _force(monkeypatch, st.SELL, 110.0)
    run(sr.process_bar(SYM, NOW))
    assert set(ex.registry) == {"o1", "o2"}
    assert ex.registry["o1"]["action"] == "exit" and ex.registry["o1"]["barT"] == LAST_CLOSED
    assert ex.registry["o2"]["action"] == "entry"


def test_restart_cancels_previous_bar_orders_from_registry(ex, monkeypatch):
    ex.registry["old1"] = {"symbol": SYM, "barT": LAST_CLOSED - BAR}
    ex.registry["older"] = {"symbol": SYM, "barT": LAST_CLOSED - 2 * BAR}
    _force(monkeypatch, None, 90.0)
    run(sr.process_bar(SYM, NOW))           # fresh process: memory empty
    assert ex.cancelled == ["old1"]


def test_registry_failure_does_not_block_trading(ex, monkeypatch):
    async def down(doc):
        raise RuntimeError("mongo down")
    monkeypatch.setattr(db, "strategy_order_insert", down)
    _force(monkeypatch, st.BUY, 90.0)
    snap = run(sr.process_bar(SYM, NOW))
    assert snap["orders"][0]["status"] == "placed"


def test_per_symbol_notional_override(ex, monkeypatch):
    monkeypatch.setattr(settings, "STRATEGY_NOTIONAL_OVERRIDES", {SYM: 100.0})
    _force(monkeypatch, st.BUY, 90.0)
    run(sr.process_bar(SYM, NOW))
    assert ex.orders[0]["qty"] == "1.000"      # 100 USDT / 100 px
    assert sr.notional_for("ETHUSDT") == 50.0


def test_notional_overrides_parser():
    from app.config import _notional_overrides
    assert _notional_overrides("BTCUSDT=100, ethusdt=60") == {"BTCUSDT": 100.0, "ETHUSDT": 60.0}
    assert _notional_overrides("BTCUSDT=abc,SOL=-5,") == {}
    assert _notional_overrides("") == {}
