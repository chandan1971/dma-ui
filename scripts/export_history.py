"""Dump order history, trade history (fills), closed PnL and the transaction
log from the exchange to CSV files — run locally, e.g. once a week.

    python scripts/export_history.py            # last 8 days (1-day overlap)
    python scripts/export_history.py --days 31  # max the gateway allows

Reads DMA_API_KEY / DMA_API_SECRET from .env (or the environment). READ-ONLY:
only GET history endpoints are called. Output goes to
exports/<YYYY-MM-DD>_<N>d/{orders,trades,closed_pnl,transactions}.csv,
oldest first. Overlapping weekly dumps are expected; dedup on the id columns
(orderId / execId) when combining them.
"""
import argparse
import asyncio
import csv
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import dma_client  # noqa: E402
from app.config import settings  # noqa: E402

DAY_MS = 24 * 60 * 60 * 1000

DATASETS = [
    # name, path, extra params, page limit, time field, dedup key
    ("orders", "/v5/order/history", {}, 50, "updatedTime",
     lambda r: (r.get("orderId"), r.get("updatedTime"))),
    ("trades", "/v5/execution/list", {}, 100, "execTime",
     lambda r: r.get("execId")),
    ("closed_pnl", "/v5/position/closed-pnl", {}, 100, "updatedTime",
     lambda r: (r.get("orderId"), r.get("updatedTime"))),
    ("transactions", "/v5/account/transaction-log",
     {"accountType": settings.ACCOUNT_TYPE}, dma_client.TXN_PAGE_LIMIT, "transactionTime",
     lambda r: tuple(sorted((k, str(v)) for k, v in r.items()))),
]


async def fetch(path, extra, page_limit, start_ms, end_ms):
    state = dma_client.new_history_state(max_requests=2000, pace_s=0.2, page_limit=page_limit)
    params = {"category": settings.CATEGORY, **extra}
    rows = []
    for w_start, w_end in reversed(dma_client._time_windows(start_ms, end_ms)):  # oldest first
        rows += await dma_client._fetch_time_range(path, params, w_start, w_end, state)
    return rows, state["budget_exhausted"] or state["density_truncated"]


def write_csv(path: Path, rows: list[dict]) -> None:
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols or ["empty"], extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=8, help="lookback in days (1-31, default 8)")
    ap.add_argument("--out", default="exports", help="output root folder (default exports)")
    args = ap.parse_args()
    days = max(1, min(args.days, 31))

    if not settings.DMA_API_KEY or not settings.DMA_API_SECRET:
        print("DMA_API_KEY / DMA_API_SECRET missing — set them in .env")
        return 2

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * DAY_MS
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = Path(args.out) / f"{stamp}_{days}d"
    out.mkdir(parents=True, exist_ok=True)

    failed = 0
    try:
        for name, path, extra, limit, tkey, dkey in DATASETS:
            try:
                rows, truncated = await fetch(path, extra, limit, start_ms, end_ms)
            except dma_client.DMAError as exc:
                print(f"{name:13s} FAILED: {exc}")
                failed += 1
                continue
            seen, uniq = set(), []
            for r in rows:
                k = dkey(r)
                if k in seen:
                    continue
                seen.add(k)
                uniq.append(r)
            uniq.sort(key=lambda r: dma_client._to_int_ms(r.get(tkey) or r.get("createdTime")))
            write_csv(out / f"{name}.csv", uniq)
            note = "  (TRUNCATED — partial, rerun with fewer days)" if truncated else ""
            print(f"{name:13s} {len(uniq):6d} rows{note}")
    finally:
        await dma_client.aclose()
    print(f"saved to {out.resolve()}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
