"""Shared test setup.

Required env vars are forced BEFORE importing app.* — importing app.main runs the
fail-fast startup validation, so the process must look correctly configured. We
use a valid Ed25519 hex seed and non-placeholder secrets so the guards pass.
"""
import os

os.environ["DMA_API_KEY"] = "testkey"
os.environ["DMA_API_SECRET"] = "00" * 32  # valid 32-byte Ed25519 seed (hex)
os.environ["ADMIN_USERNAME"] = "adm"
os.environ["ADMIN_PASSWORD"] = "Str0ng-Admin-Pass-9f3a2b"
os.environ["VIEWER_USERNAME"] = "vwr"
os.environ["VIEWER_PASSWORD"] = "Str0ng-Viewer-Pass-7c1d4e"
os.environ["SESSION_SECRET"] = "unit-test-session-secret-0123456789abcdef"
os.environ["TRADE_TOKEN"] = "unit-test-trade-token-0123456789abcdef"
# Mongo config: client construction is lazy (no I/O), and port 1 refuses
# instantly with tiny timeouts, so any test that accidentally reaches an
# UNMOCKED db helper fails fast instead of hanging on a real connection.
os.environ["MONGO_URI"] = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100&connectTimeoutMS=100"
os.environ["MONGO_USERNAME"] = "unit-test-mongo-user"
os.environ["MONGO_PASSWORD"] = "Str0ng-Mongo-Pass-5e8b1c"

import json  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import db as db_mod, dma_client, main as main_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """Clear the module-level auth-failure buckets around each test so no test
    depends (even incidentally) on rate-limit state left behind by another —
    keeps the suite order-independent under pytest-randomly/xdist."""
    main_mod._auth_failures.clear()
    yield
    main_mod._auth_failures.clear()


class _FakeResp:
    """Minimal stand-in for an httpx.Response."""

    def __init__(self, status: int, data: dict):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


@pytest.fixture
def fake_upstream(monkeypatch):
    """Replace the signed httpx client so no real network call is made and tests
    control the exact upstream envelope returned. Records the last POST body."""
    calls = {"post_body": None, "resp": _FakeResp(200, {"retCode": 0, "result": {}})}

    async def fake_post(url, headers=None, content=None):
        calls["post_body"] = content
        return calls["resp"]

    async def fake_get(url, headers=None):
        return calls["resp"]

    monkeypatch.setattr(dma_client._client, "post", fake_post)
    monkeypatch.setattr(dma_client._client, "get", fake_get)
    return calls


@pytest.fixture
def fake_db(monkeypatch):
    """In-memory stand-in for app.db's data helpers, keyed by _id like Mongo.
    Reproduces the real filter / newest-first sort / limit / projection
    semantics so the sync and read paths are exercised without a server.
    Returns the backing store: {kind: {_id: full stored doc}}."""
    store: dict[str, dict[str, dict]] = {
        db_mod.TRADES: {}, db_mod.CLOSED_PNL: {}, db_mod.TRANSACTIONS: {},
        db_mod.JOURNAL: {}, db_mod.JOURNAL_META: {},
        db_mod.AI_CONVERSATIONS: {},
    }

    async def latest_ts_ms(kind):
        docs = store[kind].values()
        return max((d["tsMs"] for d in docs), default=None)

    async def bulk_upsert(kind, docs):
        upserted = matched = 0
        for d in docs:
            if d["_id"] in store[kind]:
                # $setOnInsert semantics: an existing doc is never touched.
                matched += 1
            else:
                upserted += 1
                store[kind][d["_id"]] = dict(d)
        return (upserted, matched)

    async def query_history(kind, *, symbol, start_ms, end_ms, limit):
        rows = [
            d for d in store[kind].values()
            if start_ms <= d["tsMs"] <= end_ms and (not symbol or d.get("symbol") == symbol)
        ]
        rows.sort(key=lambda d: d["tsMs"], reverse=True)
        return [
            {k: v for k, v in d.items() if k not in ("_id", "tsMs", "syncedAt")}
            for d in rows[:limit]
        ]

    # --- journal helpers (same in-memory semantics as the Mongo layer) ---
    async def journal_query(*, symbol, start_ms, end_ms, limit):
        rows = [
            d for d in store[db_mod.JOURNAL].values()
            if start_ms <= d["tsMs"] <= end_ms and (not symbol or d.get("symbol") == symbol)
        ]
        rows.sort(key=lambda d: d["tsMs"], reverse=True)
        return [dict(d) for d in rows[:limit]]

    async def journal_get(entry_id):
        doc = store[db_mod.JOURNAL].get(entry_id)
        return dict(doc) if doc else None

    async def journal_upsert(entry_id, fields, *, insert_fields):
        doc = store[db_mod.JOURNAL].get(entry_id)
        if doc is None:
            doc = {"_id": entry_id, **insert_fields}
            store[db_mod.JOURNAL][entry_id] = doc
        doc.update(fields)
        return dict(doc)

    async def journal_delete(entry_id):
        return store[db_mod.JOURNAL].pop(entry_id, None) is not None

    async def journal_relabel(field, old, new):
        modified = 0
        for doc in store[db_mod.JOURNAL].values():
            if field in ("tags", "mistakes"):
                labels = doc.get(field) or []
                if old in labels:
                    kept = [x for x in labels if x != old]
                    if new and new not in kept:
                        kept.append(new)
                    doc[field] = kept
                    modified += 1
            elif doc.get(field) == old:
                if new:
                    doc[field] = new
                else:
                    doc.pop(field, None)
                modified += 1
        return modified

    async def journal_meta_get():
        doc = store[db_mod.JOURNAL_META].get("meta")
        return dict(doc) if doc else None

    async def journal_meta_set(doc):
        store[db_mod.JOURNAL_META]["meta"] = dict(doc)

    # --- AI conversation helpers (same in-memory semantics) ---
    def _conv_sorted(docs):
        return sorted(docs, key=lambda d: (not d.get("pinned"), -(d.get("updatedAtMs") or 0)))

    async def ai_conv_list(limit=100):
        metas = [{k: v for k, v in d.items() if k != "messages"}
                 for d in store[db_mod.AI_CONVERSATIONS].values()]
        return _conv_sorted(metas)[:limit]

    async def ai_conv_get(conv_id):
        doc = store[db_mod.AI_CONVERSATIONS].get(conv_id)
        return json.loads(json.dumps(doc)) if doc else None

    async def ai_conv_create(doc):
        store[db_mod.AI_CONVERSATIONS][doc["_id"]] = dict(doc)

    async def ai_conv_update(conv_id, fields):
        doc = store[db_mod.AI_CONVERSATIONS].get(conv_id)
        if doc is None:
            return False
        doc.update(fields)
        return True

    async def ai_conv_append(conv_id, messages, updated_ms, max_messages=200):
        doc = store[db_mod.AI_CONVERSATIONS].get(conv_id)
        if doc is None:
            return False
        doc["messages"] = (doc.get("messages", []) + list(messages))[-max_messages:]
        doc["updatedAtMs"] = updated_ms
        return True

    async def ai_conv_delete(conv_id):
        return store[db_mod.AI_CONVERSATIONS].pop(conv_id, None) is not None

    monkeypatch.setattr(db_mod, "latest_ts_ms", latest_ts_ms)
    monkeypatch.setattr(db_mod, "bulk_upsert", bulk_upsert)
    monkeypatch.setattr(db_mod, "query_history", query_history)
    monkeypatch.setattr(db_mod, "ai_conv_list", ai_conv_list)
    monkeypatch.setattr(db_mod, "ai_conv_get", ai_conv_get)
    monkeypatch.setattr(db_mod, "ai_conv_create", ai_conv_create)
    monkeypatch.setattr(db_mod, "ai_conv_update", ai_conv_update)
    monkeypatch.setattr(db_mod, "ai_conv_append", ai_conv_append)
    monkeypatch.setattr(db_mod, "ai_conv_delete", ai_conv_delete)
    monkeypatch.setattr(db_mod, "journal_query", journal_query)
    monkeypatch.setattr(db_mod, "journal_get", journal_get)
    monkeypatch.setattr(db_mod, "journal_upsert", journal_upsert)
    monkeypatch.setattr(db_mod, "journal_delete", journal_delete)
    monkeypatch.setattr(db_mod, "journal_relabel", journal_relabel)
    monkeypatch.setattr(db_mod, "journal_meta_get", journal_meta_get)
    monkeypatch.setattr(db_mod, "journal_meta_set", journal_meta_set)
    return store


@pytest.fixture
def admin_client(monkeypatch):
    """TestClient with the auth gates overridden to a fake admin, so route-level
    VALIDATION can be tested in isolation from the auth machinery. Also captures
    the body passed to each dma_client write wrapper."""
    captured = {}

    async def _cap(name):
        async def fn(body_or_symbol=None, *args, **kwargs):
            captured[name] = {"arg0": body_or_symbol, "args": args, "kwargs": kwargs}
            return {"retCode": 0, "result": {"orderId": "test-1"}}
        return fn

    async def fake_create_order(body):
        captured["create_order"] = body
        return {"retCode": 0, "result": {"orderId": "test-1"}}

    async def fake_set_leverage(symbol, buy, sell):
        captured["set_leverage"] = {"symbol": symbol, "buy": buy, "sell": sell}
        return {"retCode": 0, "result": {}}

    async def fake_transfer(direction, amount, quote_asset, client_txn_id=None):
        captured["transfer"] = {
            "direction": direction, "amount": amount,
            "quote_asset": quote_asset, "client_txn_id": client_txn_id,
        }
        return {"success": True, "status": "COMPLETED"}

    monkeypatch.setattr(dma_client, "create_order", fake_create_order)
    monkeypatch.setattr(dma_client, "set_leverage", fake_set_leverage)
    monkeypatch.setattr(dma_client, "transfer_funds", fake_transfer)

    fake_admin = {"u": "adm", "r": "admin", "sid": "test-sid"}
    main_mod.app.dependency_overrides[main_mod.require_trade_token] = lambda: fake_admin
    main_mod.app.dependency_overrides[main_mod.require_admin] = lambda: fake_admin
    main_mod.app.dependency_overrides[main_mod.current_user] = lambda: fake_admin

    client = TestClient(main_mod.app)
    client.captured = captured
    yield client
    main_mod.app.dependency_overrides.clear()
