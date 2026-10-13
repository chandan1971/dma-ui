"""EMA-cross + ALMA + EMA200 trend strategy — pure computation, no I/O.

RULES (4h closed candles, every decision at candle close, at the close price)
=============================================================================
Indicators
  EMA(n)   alpha = 2/(n+1), seeded with the SMA of the first n closes.
           EMA5, EMA10, EMA200.
  ALMA     window 21, offset 0.85, sigma 6:  m = 0.85*(21-1), s = 21/6,
           w[i] = exp(-(i-m)^2 / (2*s^2)), i = 0 is the OLDEST bar of the
           window;  ALMA = sum(close*w) / sum(w).
  BB(20,2) display only — never used in a decision.

Signals
  BUY   EMA5 crosses above EMA10 (prev EMA5 <= prev EMA10, now EMA5 > EMA10)
        AND close > ALMA.
  SELL  EMA5 crosses below EMA10 (prev EMA5 >= prev EMA10, now EMA5 < EMA10)
        AND close < ALMA.

Trading
  Entry only when flat:  BUY  and close > EMA200 -> open long
                         SELL and close < EMA200 -> open short
  Exit: the next opposite signal (EMA200 NOT checked for exits). The same
        bar then reverses into the new side if the EMA200 filter allows.
  No TP / SL.  Size: fixed notional per trade per coin, 1x leverage.

ISOLATION
=========
This module never touches the network or the exchange. It turns a list of
closed candles into indicator series, signals and position decisions; the
caller owns fetching and any order placement.
"""
import math
from dataclasses import dataclass, field

EMA_FAST = 5
EMA_SLOW = 10
EMA_TREND = 200
ALMA_WINDOW = 21
ALMA_OFFSET = 0.85
ALMA_SIGMA = 6.0
BB_WINDOW = 20
BB_MULT = 2.0

# Same-bar reversal: when an opposite signal closes a position, that SAME bar
# also opens the new position if it passes the EMA200 entry filter (the exit
# makes us flat, so "entry only when flat" is satisfied). False = exit only and
# wait for the next qualifying signal.
REVERSE_ON_EXIT = True

FLAT, LONG, SHORT = "FLAT", "LONG", "SHORT"
BUY, SELL = "BUY", "SELL"


# ---------------------------------------------------------------------------
# Candles
# ---------------------------------------------------------------------------
def closed_candles(bybit_list: list) -> list[dict]:
    """Bybit v5 kline `result.list` (newest first, rows of
    [start, open, high, low, close, volume, turnover]) -> oldest-first dicts of
    CLOSED candles only. Bybit always includes the still-forming candle as the
    newest row, so it is dropped unconditionally."""
    rows = []
    for r in bybit_list or []:
        try:
            rows.append({
                "t": int(r[0]), "o": float(r[1]), "h": float(r[2]),
                "l": float(r[3]), "c": float(r[4]), "v": float(r[5]),
            })
        except (TypeError, ValueError, IndexError):
            continue
    rows.sort(key=lambda x: x["t"])
    return rows[:-1]


# ---------------------------------------------------------------------------
# Indicators — each returns a list aligned with `values`; None until warm.
# ---------------------------------------------------------------------------
def ema(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    alpha = 2.0 / (n + 1)
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = alpha * values[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def alma_weights(window=ALMA_WINDOW, offset=ALMA_OFFSET, sigma=ALMA_SIGMA) -> list[float]:
    m = offset * (window - 1)
    s = window / sigma
    return [math.exp(-((i - m) ** 2) / (2 * s * s)) for i in range(window)]


def alma(values: list[float], window=ALMA_WINDOW, offset=ALMA_OFFSET,
         sigma=ALMA_SIGMA) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    w = alma_weights(window, offset, sigma)
    wsum = sum(w)
    for i in range(window - 1, len(values)):
        win = values[i - window + 1: i + 1]  # win[0] is the oldest bar
        out[i] = sum(c * wi for c, wi in zip(win, w)) / wsum
    return out


def bollinger(values: list[float], n=BB_WINDOW, mult=BB_MULT):
    """(mid, upper, lower) series; population std-dev. Display only."""
    mid: list[float | None] = [None] * len(values)
    up: list[float | None] = [None] * len(values)
    lo: list[float | None] = [None] * len(values)
    for i in range(n - 1, len(values)):
        win = values[i - n + 1: i + 1]
        mean = sum(win) / n
        sd = math.sqrt(sum((x - mean) ** 2 for x in win) / n)
        mid[i], up[i], lo[i] = mean, mean + mult * sd, mean - mult * sd
    return mid, up, lo


def indicators(closes: list[float]) -> dict:
    bb_mid, bb_up, bb_lo = bollinger(closes)
    return {
        "ema5": ema(closes, EMA_FAST),
        "ema10": ema(closes, EMA_SLOW),
        "ema200": ema(closes, EMA_TREND),
        "alma": alma(closes),
        "bb_mid": bb_mid, "bb_up": bb_up, "bb_lo": bb_lo,
    }


# ---------------------------------------------------------------------------
# Signals and decisions
# ---------------------------------------------------------------------------
def signal_at(ind: dict, closes: list[float], i: int) -> str | None:
    """BUY / SELL / None on bar i (needs bar i-1 for the cross)."""
    if i < 1:
        return None
    f0, s0 = ind["ema5"][i - 1], ind["ema10"][i - 1]
    f1, s1 = ind["ema5"][i], ind["ema10"][i]
    a = ind["alma"][i]
    if None in (f0, s0, f1, s1, a):
        return None
    c = closes[i]
    if f0 <= s0 and f1 > s1 and c > a:
        return BUY
    if f0 >= s0 and f1 < s1 and c < a:
        return SELL
    return None


def decide(position: str, signal: str | None, close: float,
           ema200: float | None) -> list[str]:
    """Actions for one bar, in order. Possible actions:
    CLOSE_LONG, CLOSE_SHORT, OPEN_LONG, OPEN_SHORT."""
    actions: list[str] = []
    if signal is None:
        return actions

    if position == LONG and signal == SELL:
        actions.append("CLOSE_LONG")
        position = FLAT
        if not REVERSE_ON_EXIT:
            return actions
    elif position == SHORT and signal == BUY:
        actions.append("CLOSE_SHORT")
        position = FLAT
        if not REVERSE_ON_EXIT:
            return actions

    if position == FLAT and ema200 is not None:
        if signal == BUY and close > ema200:
            actions.append("OPEN_LONG")
        elif signal == SELL and close < ema200:
            actions.append("OPEN_SHORT")
    return actions


# ---------------------------------------------------------------------------
# Replay — drives backtests and the paper book from the same code path.
# ---------------------------------------------------------------------------
@dataclass
class Trade:
    side: str          # LONG / SHORT
    entry_t: int
    entry_px: float
    qty: float
    exit_t: int | None = None
    exit_px: float | None = None

    @property
    def pnl(self) -> float | None:
        if self.exit_px is None:
            return None
        d = self.exit_px - self.entry_px
        return d * self.qty if self.side == LONG else -d * self.qty


@dataclass
class Book:
    position: str = FLAT
    open_trade: Trade | None = None
    trades: list[Trade] = field(default_factory=list)


def apply(book: Book, actions: list[str], t: int, px: float, notional: float) -> None:
    for a in actions:
        if a in ("CLOSE_LONG", "CLOSE_SHORT") and book.open_trade:
            book.open_trade.exit_t, book.open_trade.exit_px = t, px
            book.trades.append(book.open_trade)
            book.open_trade, book.position = None, FLAT
        elif a == "OPEN_LONG":
            book.open_trade = Trade(LONG, t, px, notional / px)
            book.position = LONG
        elif a == "OPEN_SHORT":
            book.open_trade = Trade(SHORT, t, px, notional / px)
            book.position = SHORT


def backtest(candles: list[dict], notional: float = 50.0) -> Book:
    closes = [c["c"] for c in candles]
    ind = indicators(closes)
    book = Book()
    for i in range(len(candles)):
        sig = signal_at(ind, closes, i)
        acts = decide(book.position, sig, closes[i], ind["ema200"][i])
        apply(book, acts, candles[i]["t"], closes[i], notional)
    return book
