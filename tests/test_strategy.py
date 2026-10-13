"""EMA-cross / ALMA / EMA200 strategy engine (app/strategy.py): indicator math,
closed-candle handling, signal crosses and the flat-only entry state machine."""
import math

import pytest

from app import strategy as st


# ---------------------------------------------------------------------------
# Candles
# ---------------------------------------------------------------------------
def test_closed_candles_drops_forming_bar_and_sorts_oldest_first():
    raw = [  # Bybit order: newest first
        ["3000", "1", "1", "1", "13", "0", "0"],  # forming
        ["2000", "1", "1", "1", "12", "0", "0"],
        ["1000", "1", "1", "1", "11", "0", "0"],
    ]
    out = st.closed_candles(raw)
    assert [c["t"] for c in out] == [1000, 2000]
    assert [c["c"] for c in out] == [11.0, 12.0]


def test_closed_candles_skips_garbled_rows():
    raw = [["3000", "1", "1", "1", "13", "0"], ["x"], ["1000", "1", "1", "1", "11", "0"]]
    assert [c["t"] for c in st.closed_candles(raw)] == [1000]


# ---------------------------------------------------------------------------
# EMA
# ---------------------------------------------------------------------------
def test_ema_seeded_with_sma_then_recursive():
    vals = [1, 2, 3, 4, 5]
    out = st.ema(vals, 3)
    assert out[:2] == [None, None]
    assert out[2] == pytest.approx(2.0)            # SMA(1,2,3)
    assert out[3] == pytest.approx(0.5 * 4 + 0.5 * 2.0)   # alpha = 2/4
    assert out[4] == pytest.approx(0.5 * 5 + 0.5 * 3.0)


def test_ema_too_short_is_all_none():
    assert st.ema([1, 2], 5) == [None, None]


# ---------------------------------------------------------------------------
# ALMA
# ---------------------------------------------------------------------------
def test_alma_weights_peak_at_offset_position():
    w = st.alma_weights()
    m = 0.85 * 20
    assert w.index(max(w)) == round(m)              # bar 17 (newest-ish)
    s = 21 / 6
    assert w[0] == pytest.approx(math.exp(-(m ** 2) / (2 * s * s)))


def test_alma_of_constant_series_is_constant():
    out = st.alma([7.0] * 30)
    assert out[19] is None
    assert out[20] == pytest.approx(7.0)
    assert out[29] == pytest.approx(7.0)


def test_alma_window_oldest_bar_gets_index_zero():
    # Rising series: ALMA leans to the newer end, so it sits above the SMA.
    vals = list(range(1, 22))
    a = st.alma(vals)[-1]
    assert a > sum(vals) / 21
    w = st.alma_weights()
    assert a == pytest.approx(sum(v * wi for v, wi in zip(vals, w)) / sum(w))


# ---------------------------------------------------------------------------
# Bollinger (display only)
# ---------------------------------------------------------------------------
def test_bollinger_population_std():
    vals = [float(x) for x in range(1, 21)]
    mid, up, lo = st.bollinger(vals)
    sd = math.sqrt(sum((x - 10.5) ** 2 for x in vals) / 20)
    assert mid[-1] == pytest.approx(10.5)
    assert up[-1] == pytest.approx(10.5 + 2 * sd)
    assert lo[-1] == pytest.approx(10.5 - 2 * sd)


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------
def _ind(e5, e10, alma):
    return {"ema5": e5, "ema10": e10, "alma": alma}


@pytest.mark.parametrize("prev5,prev10,now5,now10,close,alma_v,expected", [
    (1.0, 1.0, 2.0, 1.5, 10, 9, st.BUY),     # equal -> above counts as cross
    (0.9, 1.0, 2.0, 1.5, 10, 9, st.BUY),
    (0.9, 1.0, 2.0, 1.5, 9, 9, None),        # close not strictly > ALMA
    (1.1, 1.0, 2.0, 1.5, 10, 9, None),       # already above: no cross
    (1.0, 1.0, 1.0, 1.5, 8, 9, st.SELL),
    (1.1, 1.0, 1.0, 1.5, 8, 9, st.SELL),
    (1.1, 1.0, 1.0, 1.5, 9, 9, None),        # close not strictly < ALMA
    (1.0, 1.0, 1.0, 1.0, 8, 9, None),        # touching is not crossing
])
def test_signal_cross_and_alma_filter(prev5, prev10, now5, now10, close, alma_v, expected):
    ind = _ind([prev5, now5], [prev10, now10], [None, alma_v])
    assert st.signal_at(ind, [0, close], 1) == expected


def test_signal_none_while_warming_up():
    ind = _ind([None, 2.0], [1.0, 1.5], [None, 1.0])
    assert st.signal_at(ind, [0, 10], 1) is None
    assert st.signal_at(ind, [10], 0) is None


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("pos,sig,close,e200,expected", [
    (st.FLAT, st.BUY, 101, 100, ["OPEN_LONG"]),
    (st.FLAT, st.BUY, 99, 100, []),               # trend filter blocks long
    (st.FLAT, st.SELL, 99, 100, ["OPEN_SHORT"]),
    (st.FLAT, st.SELL, 101, 100, []),             # trend filter blocks short
    (st.FLAT, st.BUY, 101, None, []),             # EMA200 not warm: no entry
    (st.LONG, st.BUY, 101, 100, []),              # no pyramiding
    (st.SHORT, st.SELL, 99, 100, []),
    (st.LONG, st.SELL, 101, 100, ["CLOSE_LONG"]), # exit ignores EMA200
    (st.SHORT, st.BUY, 99, 100, ["CLOSE_SHORT"]),
    (st.LONG, st.SELL, 101, None, ["CLOSE_LONG"]),
    (st.LONG, None, 50, 100, []),
])
def test_decide(pos, sig, close, e200, expected, monkeypatch):
    monkeypatch.setattr(st, "REVERSE_ON_EXIT", False)
    assert st.decide(pos, sig, close, e200) == expected


def test_decide_reverse_on_exit_when_enabled(monkeypatch):
    monkeypatch.setattr(st, "REVERSE_ON_EXIT", True)
    assert st.decide(st.LONG, st.SELL, 99, 100) == ["CLOSE_LONG", "OPEN_SHORT"]
    assert st.decide(st.LONG, st.SELL, 101, 100) == ["CLOSE_LONG"]


# ---------------------------------------------------------------------------
# Book / backtest
# ---------------------------------------------------------------------------
def test_apply_sizes_fixed_notional_and_books_pnl():
    book = st.Book()
    st.apply(book, ["OPEN_SHORT"], 1, 100.0, 50.0)
    assert book.position == st.SHORT and book.open_trade.qty == pytest.approx(0.5)
    st.apply(book, ["CLOSE_SHORT"], 2, 90.0, 50.0)
    assert book.position == st.FLAT
    assert book.trades[0].pnl == pytest.approx(5.0)


def test_backtest_runs_on_synthetic_series():
    # Long uptrend (EMA200 below price) with periodic dips -> crosses happen.
    closes = [100 + i * 0.5 + 8 * math.sin(i / 6) for i in range(600)]
    candles = [{"t": i, "o": c, "h": c, "l": c, "c": c, "v": 0} for i, c in enumerate(closes)]
    book = st.backtest(candles)
    assert book.trades, "expected at least one closed trade"
    for tr in book.trades:
        assert tr.entry_t >= st.EMA_TREND - 1     # no entry before EMA200 warm
        assert tr.exit_t > tr.entry_t
