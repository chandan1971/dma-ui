"""Operational visibility: /healthz sync freshness + wedged-sync Telegram alert."""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import db, history_sync, main as main_mod, notifier


# ---- /healthz: history sync freshness --------------------------------------

def test_healthz_reports_sync_age(monkeypatch):
    now_ms = int(time.time() * 1000)
    monkeypatch.setitem(history_sync._last_synced_ms, db.TRADES, now_ms - 90_000)
    monkeypatch.setitem(history_sync._last_synced_ms, db.CLOSED_PNL, None)
    r = TestClient(main_mod.app).get("/healthz")
    assert r.status_code == 200
    ages = r.json()["historySyncAgeSeconds"]
    assert 85 <= ages["trades"] <= 95   # ~90s, tolerant of test runtime
    assert ages["closedPnl"] is None    # no completed run yet


# ---- wedged-sync alert ------------------------------------------------------

@pytest.fixture
def alert_env(monkeypatch):
    """Failing/succeeding sync_kind under caller control + captured alerts."""
    sent = []

    async def fake_notify(text):
        sent.append(text)

    state = {"fail": True}

    async def fake_sync_kind(kind):
        if state["fail"]:
            raise RuntimeError("upstream down")
        return {}

    monkeypatch.setattr(notifier, "notify", fake_notify)
    monkeypatch.setattr(history_sync, "sync_kind", fake_sync_kind)
    monkeypatch.setattr(
        history_sync, "_consecutive_failures",
        {db.TRADES: 0, db.CLOSED_PNL: 0, db.TRANSACTIONS: 0},
    )
    monkeypatch.setattr(history_sync, "_unsupported", set())
    return {"sent": sent, "state": state}


def test_sync_alerts_once_after_consecutive_failures(alert_env):
    for _ in range(5):  # keeps failing well past the threshold
        asyncio.run(history_sync.sync_all())
    warnings = [t for t in alert_env["sent"] if "failed" in t]
    # One alert per collection, never repeated per run.
    assert len(warnings) == 3
    assert any("trades" in t for t in warnings)
    assert any("closed-pnl" in t for t in warnings)
    assert any("transactions" in t for t in warnings)


def test_sync_recovery_notifies_and_resets(alert_env):
    for _ in range(3):
        asyncio.run(history_sync.sync_all())
    alert_env["state"]["fail"] = False
    asyncio.run(history_sync.sync_all())
    recoveries = [t for t in alert_env["sent"] if "recovered" in t]
    assert len(recoveries) == 3
    assert history_sync._consecutive_failures[db.TRADES] == 0
    # A later single failure starts counting from scratch — no immediate re-alert.
    alert_env["state"]["fail"] = True
    asyncio.run(history_sync.sync_all())
    assert len([t for t in alert_env["sent"] if "failed" in t]) == 3  # unchanged


def test_no_alert_below_threshold(alert_env):
    for _ in range(2):  # threshold is 3
        asyncio.run(history_sync.sync_all())
    assert alert_env["sent"] == []
