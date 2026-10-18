"""Per-trade ledger for the automated strategy — built from REAL fills.

Input is the exchange's own executions (fill history) for the strategy
symbols, so prices, quantities and fees are what actually filled — not the
limit prices requested. Pure: no I/O.

History only reaches back a limited window. A position already open when the
window starts is passed in as `opening` (signed qty); its entry price is
unknown, so that trade reports entryPrice/realised/unrealised as None and
`entryBeforeWindow` True rather than inventing a cost basis.

Accounting (per symbol, fills in time order, average-cost basis):
  * a trade runs from flat to flat;
  * fills in the trade's direction add to it (avg entry re-weighted);
  * opposite fills reduce it; gross PnL realised = (px - avg) * qty * dir;
  * a fill that crosses zero is split: the closing part ends the trade, the
    rest opens the next one (its fee pro-rated by quantity).
Fees use the exchange sign: positive = paid, negative = maker rebate.

Per trade:
  realisedPnl   gross realised PnL minus ALL fees paid so far (net)
  unrealisedPnl (mark - avg entry) * open qty * dir — before the exit fee
"""
from collections import defaultdict

_EPS = 1e-12


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _new_trade(symbol: str, direction: int, ts: int | None) -> dict:
    return {
        "symbol": symbol, "direction": direction, "openedMs": ts, "closedMs": None,
        "known": True,
        "avg": 0.0, "openQty": 0.0, "entryQty": 0.0, "entryValue": 0.0,
        "exitQty": 0.0, "exitValue": 0.0, "entryFee": 0.0, "exitFee": 0.0,
        "gross": 0.0,
    }


def _finish(t: dict, mark: float | None) -> dict:
    closed = t["openQty"] <= _EPS
    fees = t["entryFee"] + t["exitFee"]
    known = t["known"]
    unreal = None
    if not closed and mark and known:
        unreal = (mark - t["avg"]) * t["openQty"] * t["direction"]
    realised = t["gross"] - fees if known else None
    return {
        "symbol": t["symbol"],
        "side": "LONG" if t["direction"] > 0 else "SHORT",
        "status": "CLOSED" if closed else "OPEN",
        "openedMs": t["openedMs"],
        "closedMs": t["closedMs"],
        "qty": t["entryQty"],
        "openQty": 0.0 if closed else t["openQty"],
        "entryPrice": t["entryValue"] / t["entryQty"] if known and t["entryQty"] > _EPS else None,
        "entryBeforeWindow": not known,
        "exitPrice": t["exitValue"] / t["exitQty"] if t["exitQty"] > _EPS else None,
        "markPrice": None if closed else mark,
        "fees": fees,
        "realisedPnl": realised,
        "unrealisedPnl": unreal,
        "netPnl": None if realised is None else realised + (unreal or 0.0),
    }


def build_trades(fills: list[dict], marks: dict[str, float] | None = None,
                 opening: dict[str, float] | None = None) -> list[dict]:
    """Trades newest first. `marks` maps symbol -> mark price for open trades;
    `opening` maps symbol -> signed position qty held before the first fill."""
    marks = marks or {}
    opening = opening or {}
    by_sym: dict[str, list[dict]] = defaultdict(list)
    for f in fills:
        if str(f.get("execType", "Trade")) not in ("Trade", ""):
            continue  # funding / settlement rows are not fills
        by_sym[str(f.get("symbol", ""))].append(f)

    out: list[dict] = []
    for sym in set(by_sym) | {s for s, q in opening.items() if abs(q) > _EPS}:
        rows = by_sym.get(sym, [])
        rows.sort(key=lambda r: (int(_f(r.get("tsMs") or r.get("execTime"))), str(r.get("execId", ""))))
        cur = None
        seed = _f(opening.get(sym))
        if abs(seed) > _EPS:
            cur = _new_trade(sym, 1 if seed > 0 else -1, None)
            cur["known"] = False
            cur["openQty"] = cur["entryQty"] = abs(seed)
        for r in rows:
            qty, px, fee = _f(r.get("execQty")), _f(r.get("execPrice")), _f(r.get("execFee"))
            ts = int(_f(r.get("tsMs") or r.get("execTime")))
            side = str(r.get("side", "")).lower()
            if qty <= _EPS or px <= 0 or side not in ("buy", "sell"):
                continue
            d = 1 if side == "buy" else -1
            remaining = qty
            while remaining > _EPS:
                if cur is None:
                    cur = _new_trade(sym, d, ts)
                if cur["direction"] == d:
                    part = remaining
                    cur["avg"] = (cur["avg"] * cur["openQty"] + px * part) / (cur["openQty"] + part)
                    cur["openQty"] += part
                    cur["entryQty"] += part
                    cur["entryValue"] += px * part
                    cur["entryFee"] += fee * part / qty
                    remaining = 0.0
                else:
                    part = min(remaining, cur["openQty"])
                    cur["gross"] += (px - cur["avg"]) * part * cur["direction"]
                    cur["openQty"] -= part
                    cur["exitQty"] += part
                    cur["exitValue"] += px * part
                    cur["exitFee"] += fee * part / qty
                    remaining -= part
                    if cur["openQty"] <= _EPS:
                        cur["openQty"] = 0.0
                        cur["closedMs"] = ts
                        out.append(_finish(cur, None))
                        cur = None
        if cur is not None:
            out.append(_finish(cur, marks.get(sym)))

    out.sort(key=lambda t: t["openedMs"] or 0, reverse=True)
    return out


def totals(trades: list[dict]) -> dict:
    return {
        "trades": len(trades),
        "open": sum(t["status"] == "OPEN" for t in trades),
        "fees": sum(t["fees"] for t in trades),
        "realisedPnl": sum(t["realisedPnl"] or 0.0 for t in trades),
        "unrealisedPnl": sum(t["unrealisedPnl"] or 0.0 for t in trades),
        "netPnl": sum(t["netPnl"] or 0.0 for t in trades),
        "entryBeforeWindow": sum(t["entryBeforeWindow"] for t in trades),
    }
