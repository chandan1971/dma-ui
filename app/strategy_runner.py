"""4h strategy runner — turns app/strategy.py decisions into exchange orders.

LOOP
====
Sleeps to each 4h boundary (UTC 00/04/08/12/16/20) + STRATEGY_CLOSE_DELAY,
then for every symbol in STRATEGY_SYMBOLS:

  1. fetch 1000 candles UNCACHED from the public kline endpoint, drop the
     forming bar, and verify the newest closed bar is the one that just closed
     (retry briefly if the venue has not rolled yet);
  2. cancel any order this runner placed on the previous bar (entries are
     never chased; an unfilled entry is simply dropped);
  3. read the LIVE position from the exchange — the source of truth, so a
     restart, partial fill or missed fill can never cause a double entry;
  4. strategy.decide() on the closed bar, plus the exit-chase rule below;
  5. place LIMIT orders at the signal bar's close: entries as plain limits,
     exits as reduce-only limits for the live position size.

Exit chase: an exit limit at the signal close often does not fill (the move
that made the signal keeps going). If the position is still open at the next
close, the reduce-only exit is re-placed at the NEW close, every bar, until
flat — unless a fresh signal on that bar would have re-entered the same side
anyway, in which case the exit is abandoned and the position is kept.

SAFETY
======
STRATEGY_ENABLED gates the loop; STRATEGY_LIVE gates every exchange write.
Without STRATEGY_LIVE all intended orders are logged ("dry-run") and nothing
is sent. On startup the newest closed bar is only ARMED (recorded, not
traded) so a deploy/restart never acts on a bar that closed while down.
One-way position mode only: a hedge-mode symbol is refused, never guessed.
Every write emits a line on the "dma-ui.audit" logger with user "strategy".
No database: after a restart the previous cycle's resting orders are found on
the exchange by their creation time (see _previous_cycle_orders).
"""
import asyncio
import json
import logging
import time
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation

from . import dma_client, market_data, notifier
from . import strategy as st
from .config import settings

logger = logging.getLogger("dma-ui.strategy")
_audit_log = logging.getLogger("dma-ui.audit")

BAR_MS = 4 * 60 * 60 * 1000
FETCH_LIMIT = 1000
_FETCH_RETRIES = 6
_FETCH_RETRY_SLEEP = 5.0
# Bybit v5 "leverage not modified" — setting the leverage it already has.
_RET_LEVERAGE_UNCHANGED = 110043
# The runner places its orders within this long after a 4h close (close delay
# + bar-roll retries + per-symbol work), used to recognise them after a restart.
_BOT_PLACE_WINDOW_MS = 5 * 60 * 1000

_state: dict[str, dict] = {}
_instruments: dict[str, dict] = {}
_leverage_ok: set[str] = set()


class StrategyError(Exception):
    pass


def _sym_state(sym: str) -> dict:
    return _state.setdefault(sym, {
        "last_bar_t": None,      # newest closed bar already handled
        "our_orders": [],        # orderIds placed on the previous bar
        "pending_exit": None,    # LONG / SHORT we are still trying to exit
        "last": None,            # snapshot served by /api/strategy
    })


def notional_for(sym: str) -> float:
    return settings.STRATEGY_NOTIONAL_OVERRIDES.get(sym, settings.STRATEGY_NOTIONAL)


def expected_last_closed_t(now_ms: int) -> int:
    return (now_ms // BAR_MS) * BAR_MS - BAR_MS


# ---------------------------------------------------------------------------
# Number formatting — exchange strings, never float reprs.
# ---------------------------------------------------------------------------
def entry_qty(notional: float, px: float, step: str, min_qty: str) -> str | None:
    """notional/px floored to the lot step; None if below the minimum."""
    try:
        d_step, d_min = Decimal(step), Decimal(min_qty)
        raw = Decimal(str(notional)) / Decimal(str(px))
    except (InvalidOperation, ZeroDivisionError):
        return None
    if d_step <= 0:
        return None
    qty = (raw / d_step).to_integral_value(rounding=ROUND_FLOOR) * d_step
    if qty <= 0 or qty < d_min:
        return None
    return format(qty.quantize(d_step), "f")


def price_str(px: float, tick: str) -> str:
    d_tick = Decimal(tick)
    p = (Decimal(str(px)) / d_tick).to_integral_value(rounding=ROUND_HALF_UP) * d_tick
    return format(p.quantize(d_tick), "f")


# ---------------------------------------------------------------------------
# Exchange reads
# ---------------------------------------------------------------------------
async def _load_candles(sym: str, now_ms: int) -> list[dict]:
    want = expected_last_closed_t(now_ms)
    for attempt in range(_FETCH_RETRIES):
        data = await market_data.get_kline_uncached(sym, "4h", FETCH_LIMIT)
        rows = (data.get("result") or {}).get("list") or []
        candles = st.closed_candles(rows)
        if candles and candles[-1]["t"] == want:
            return candles
        if candles and candles[-1]["t"] > want:
            # Clock skew: venue already further along than we think.
            return [c for c in candles if c["t"] <= want]
        if attempt < _FETCH_RETRIES - 1:
            await asyncio.sleep(_FETCH_RETRY_SLEEP)
    raise StrategyError(f"{sym}: closed 4h bar {want} not available yet")


async def _instrument(sym: str) -> dict:
    if sym not in _instruments:
        lst = dma_client.extract_list(await dma_client.get_instruments(sym))
        inst = next((i for i in lst if str(i.get("symbol", "")).upper() == sym), None)
        if not inst:
            raise StrategyError(f"{sym}: instrument info unavailable")
        lot, pf = inst.get("lotSizeFilter") or {}, inst.get("priceFilter") or {}
        if not lot.get("qtyStep") or not pf.get("tickSize"):
            raise StrategyError(f"{sym}: lot step / tick size unavailable")
        _instruments[sym] = {
            "qty_step": str(lot["qtyStep"]),
            "min_qty": str(lot.get("minOrderQty") or lot["qtyStep"]),
            "tick": str(pf["tickSize"]),
        }
    return _instruments[sym]


async def _live_position(sym: str) -> tuple[str, str | None]:
    """(LONG/SHORT/FLAT, exchange size string or None). One-way mode only."""
    lst = dma_client.extract_list(await dma_client.get_position_by_symbol(sym))
    lst = [p for p in lst if str(p.get("symbol", "")).upper() == sym]
    if any(str(p.get("positionIdx", "0")) in ("1", "2") for p in lst):
        raise StrategyError(f"{sym}: account is in hedge mode; strategy needs one-way")
    for p in lst:
        size = str(p.get("size", "0")).strip()
        try:
            open_ = Decimal(size) > 0
        except InvalidOperation:
            continue
        if open_:
            side = str(p.get("side", "")).lower()
            if side == "buy":
                return st.LONG, size
            if side == "sell":
                return st.SHORT, size
    return st.FLAT, None


# ---------------------------------------------------------------------------
# Exchange writes (all gated on STRATEGY_LIVE)
# ---------------------------------------------------------------------------
def _audit(action: str, body: dict, outcome: str, **extra) -> None:
    entry = {"audit": action, "user": "strategy", "role": "bot", "body": body,
             "outcome": outcome, **extra}
    log = _audit_log.info if outcome in ("ok", "dry-run") else _audit_log.warning
    log("%s", json.dumps(entry, default=str))


async def _previous_cycle_orders(sym: str, placed_from_ms: int) -> list[str]:
    """After a restart memory is empty, so find the previous cycle's resting
    orders on the exchange instead: open LIMIT orders on this symbol created
    in the few minutes right after the last 4h close — when the runner places
    its orders. A manual limit order placed in that same window on a strategy
    symbol would be cancelled too."""
    lst = dma_client.extract_list(await dma_client.get_open_orders())
    out = []
    for o in lst:
        try:
            created = int(o.get("createdTime") or 0)
        except (TypeError, ValueError):
            continue
        if (str(o.get("symbol", "")).upper() == sym
                and str(o.get("orderType", "")) == "Limit"
                and placed_from_ms <= created <= placed_from_ms + _BOT_PLACE_WINDOW_MS
                and o.get("orderId")):
            out.append(str(o["orderId"]))
    return out


async def _cancel_ours(sym: str, s: dict, placed_from_ms: int) -> None:
    ids = list(s["our_orders"])
    if not ids:
        try:
            ids = await _previous_cycle_orders(sym, placed_from_ms)
        except dma_client.DMAError:
            logger.exception("strategy %s: could not list open orders", sym)
    for oid in ids:
        try:
            await dma_client.cancel_order(sym, oid)
            _audit("strategy.cancel", {"symbol": sym, "orderId": oid}, "ok")
        except dma_client.DMAError as exc:
            # Usually "order not exists": already filled or cancelled.
            _audit("strategy.cancel", {"symbol": sym, "orderId": oid}, "rejected",
                   error=str(exc.detail))
    s["our_orders"] = []


async def _ensure_leverage(sym: str) -> None:
    if sym in _leverage_ok:
        return
    lev = str(settings.STRATEGY_LEVERAGE)
    try:
        await dma_client.set_leverage(sym, lev, lev)
    except dma_client.DMAError as exc:
        if exc.ret_code != _RET_LEVERAGE_UNCHANGED:
            raise StrategyError(f"{sym}: could not set leverage {lev}x: {exc.detail}") from exc
    _leverage_ok.add(sym)


async def _place(sym: str, s: dict, order: dict, action: str) -> dict:
    if not settings.STRATEGY_LIVE:
        _audit("strategy." + action, order, "dry-run")
        return {"action": action, "order": order, "status": "dry-run"}
    try:
        res = await dma_client.create_order(order)
    except dma_client.DMAError as exc:
        _audit("strategy." + action, order, "rejected", error=str(exc.detail))
        return {"action": action, "order": order, "status": "rejected",
                "error": str(exc.detail)}
    oid = ((res or {}).get("result") or {}).get("orderId")
    if oid:
        s["our_orders"].append(oid)
    _audit("strategy." + action, order, "ok", orderId=oid)
    return {"action": action, "order": order, "status": "placed", "orderId": oid}


# ---------------------------------------------------------------------------
# One closed bar for one symbol
# ---------------------------------------------------------------------------
def _with_exit_chase(s: dict, pos: str, actions: list[str], sig, px, e200) -> list[str]:
    if s["pending_exit"] != pos:
        s["pending_exit"] = None
        return actions
    if any(a.startswith("CLOSE") for a in actions):
        return actions
    # Would this bar's signal have put us back into the side we hold?
    reentry = st.decide(st.FLAT, sig, px, e200)
    if ("OPEN_" + pos) in reentry:
        s["pending_exit"] = None
        return actions
    return ["CLOSE_" + pos]


async def process_bar(sym: str, now_ms: int, *, arm_only: bool = False) -> dict:
    s = _sym_state(sym)
    candles = await _load_candles(sym, now_ms)
    closes = [c["c"] for c in candles]
    ind = st.indicators(closes)
    i = len(closes) - 1
    bar_t, px = candles[i]["t"], closes[i]
    sig = st.signal_at(ind, closes, i)
    snap = {
        "bar_t": bar_t, "close": px, "signal": sig,
        **{k: ind[k][i] for k in ("ema5", "ema10", "ema200", "alma", "bb_mid", "bb_up", "bb_lo")},
        "updated_ms": int(time.time() * 1000), "orders": [], "actions": [],
    }
    if arm_only or s["last_bar_t"] == bar_t:
        s["last_bar_t"] = bar_t
        snap["armed_only"] = True
        snap["pending_exit"] = s["pending_exit"]
        s["last"] = snap
        return snap
    s["last_bar_t"] = bar_t

    if settings.STRATEGY_LIVE:
        await _cancel_ours(sym, s, bar_t)
    pos, size = await _live_position(sym)
    actions = st.decide(pos, sig, px, ind["ema200"][i])
    actions = _with_exit_chase(s, pos, actions, sig, px, ind["ema200"][i])

    inst = await _instrument(sym)
    price = price_str(px, inst["tick"])
    for a in actions:
        if a.startswith("CLOSE"):
            order = {"symbol": sym, "side": "Sell" if a == "CLOSE_LONG" else "Buy",
                     "orderType": "Limit", "qty": size, "price": price,
                     "timeInForce": "GTC", "reduceOnly": True, "positionIdx": 0}
            snap["orders"].append(await _place(sym, s, order, "exit"))
            s["pending_exit"] = pos
        else:
            qty = entry_qty(notional_for(sym), px, inst["qty_step"], inst["min_qty"])
            if qty is None:
                snap["orders"].append({"action": "entry", "status": "skipped",
                                       "error": "notional below minimum order qty"})
                continue
            if settings.STRATEGY_LIVE:
                await _ensure_leverage(sym)
            order = {"symbol": sym, "side": "Buy" if a == "OPEN_LONG" else "Sell",
                     "orderType": "Limit", "qty": qty, "price": price,
                     "timeInForce": "GTC", "positionIdx": 0}
            snap["orders"].append(await _place(sym, s, order, "entry"))

    snap.update(position=pos, actions=actions, pending_exit=s["pending_exit"])
    s["last"] = snap
    if actions:
        mode = "LIVE" if settings.STRATEGY_LIVE else "DRY-RUN"
        lines = [f"[strategy {mode}] {sym} 4h close {price} signal={sig} pos={pos}"]
        lines += [f"  {o['action']} {o.get('order', {}).get('side', '')} "
                  f"{o.get('order', {}).get('qty', '')} -> {o['status']}"
                  for o in snap["orders"]]
        await notifier.notify("\n".join(lines))
    return snap


# ---------------------------------------------------------------------------
# Loop + status
# ---------------------------------------------------------------------------
async def _run_all(now_ms: int, arm_only: bool) -> None:
    for sym in settings.STRATEGY_SYMBOLS:
        try:
            await process_bar(sym, now_ms, arm_only=arm_only)
        except Exception as exc:  # one symbol must never stop the others
            logger.exception("strategy %s failed", sym)
            s = _sym_state(sym)
            s["last"] = {**(s["last"] or {}), "error": str(exc),
                         "updated_ms": int(time.time() * 1000)}
            await notifier.notify(f"[strategy] {sym} error: {exc}")


async def run_loop() -> None:
    if not settings.STRATEGY_ENABLED:
        return
    logger.info("strategy loop started live=%s symbols=%s",
                settings.STRATEGY_LIVE, settings.STRATEGY_SYMBOLS)
    await _run_all(int(time.time() * 1000), arm_only=True)
    while True:
        now = time.time() * 1000
        nxt = (now // BAR_MS + 1) * BAR_MS + settings.STRATEGY_CLOSE_DELAY * 1000
        await asyncio.sleep(max(1.0, (nxt - now) / 1000))
        await _run_all(int(time.time() * 1000), arm_only=False)


def snapshot_response() -> dict:
    return {
        "enabled": settings.STRATEGY_ENABLED,
        "live": settings.STRATEGY_LIVE,
        "notional": {sym: notional_for(sym) for sym in settings.STRATEGY_SYMBOLS},
        "leverage": settings.STRATEGY_LEVERAGE,
        "symbols": {sym: _sym_state(sym)["last"] for sym in settings.STRATEGY_SYMBOLS},
    }
