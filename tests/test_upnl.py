"""Unrealised-PnL tracker (app/upnl.py): bucket rolling, downsampling, the
Redis persistence layer (against an in-memory fake) and /api/upnl."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod, upnl
from app.config import settings


# ---------------------------------------------------------------------------
# In-memory Redis stand-in: just the five commands the module uses, with real
# stream semantics (monotonic auto IDs, MAXLEN trim, min/max range reads).
# ---------------------------------------------------------------------------
class FakeRedis:
    def __init__(self):
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.hashes: dict[str, dict] = {}
        self.now_ms = 1_700_000_000_000  # tests advance this explicitly
        self._seq = 0

    # -- commands ------------------------------------------------------------
    async def xadd(self, key, fields, maxlen=None, approximate=True):
        self._seq += 1
        entry_id = f"{self.now_ms}-{self._seq}"
        entries = self.streams.setdefault(key, [])
        entries.append((entry_id, {k: str(v) for k, v in fields.items()}))
        if maxlen is not None and len(entries) > maxlen:
            del entries[: len(entries) - maxlen]
        return entry_id

    async def xrange(self, key, min="-", max="+"):
        def _ms(bound, default):
            if bound in ("-", "+"):
                return default
            return int(str(bound).split("-")[0])
        lo = _ms(min, float("-inf"))
        hi = _ms(max, float("inf"))
        return [
            (eid, dict(fields))
            for eid, fields in self.streams.get(key, [])
            if lo <= int(eid.split("-")[0]) <= hi
        ]

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    async def hset(self, key, mapping=None):
        self.hashes.setdefault(key, {}).update({k: str(v) for k, v in (mapping or {}).items()})

    async def info(self, section=None):
        return {"used_memory": 4096, "maxmemory": 0}

    async def aclose(self):
        pass

    # -- pipeline (the module only queues xadd/hset) ---------------------------
    def pipeline(self, transaction=False):
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, r):
        self._r = r
        self._ops = []

    def xadd(self, *a, **kw):
        self._ops.append(("xadd", a, kw))
        return self

    def hset(self, *a, **kw):
        self._ops.append(("hset", a, kw))
        return self

    async def execute(self):
        return [await getattr(self._r, name)(*a, **kw) for name, a, kw in self._ops]


@pytest.fixture
def fake_redis(monkeypatch):
    """Enable the tracker against a FakeRedis and reset ALL module state so
    tests stay order-independent."""
    r = FakeRedis()
    monkeypatch.setattr(settings, "REDIS_URL", "redis://unit-test:6379/0")
    monkeypatch.setattr(settings, "UPNL_ENABLED", True)
    monkeypatch.setattr(upnl, "_redis", r)
    monkeypatch.setattr(upnl, "_m1_bucket", None)
    monkeypatch.setattr(upnl, "_h1_bucket", None)
    monkeypatch.setattr(upnl, "_extremes", None)
    monkeypatch.setattr(upnl, "_last_sample_ms", None)
    monkeypatch.setattr(upnl, "_last_value", None)
    monkeypatch.setattr(upnl, "_last_count", None)
    monkeypatch.setattr(upnl, "_last_error", None)
    monkeypatch.setattr(upnl, "_mem_cache", None)
    return r


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Pure core
# ---------------------------------------------------------------------------
def test_roll_bucket_folds_and_completes_on_boundary():
    done, b = upnl.roll_bucket(None, 61_000, 5.0, 60_000)
    assert done is None and b == {"t": 60_000, "o": 5.0, "h": 5.0, "l": 5.0, "c": 5.0}
    done, b = upnl.roll_bucket(b, 70_000, -2.0, 60_000)          # same minute
    assert done is None and (b["h"], b["l"], b["c"]) == (5.0, -2.0, -2.0)
    done, b = upnl.roll_bucket(b, 121_000, 1.0, 60_000)          # next minute
    assert done == {"t": 60_000, "o": 5.0, "h": 5.0, "l": -2.0, "c": -2.0}
    assert b["t"] == 120_000 and b["o"] == 1.0


def test_downsample_bounds_and_extreme_preservation():
    rows = [(i * 1000, float(i), float(i), float(i)) for i in range(5000)]
    rows[1234] = (1_234_000, -999.0, 1234.0, 1234.0)  # a spike inside a bucket
    rows[4321] = (4_321_000, 4321.0, 9999.0, 4321.0)
    out = upnl.downsample(rows, 720)
    assert len(out) == 720
    assert min(r[1] for r in out) == -999.0   # lo spike survives
    assert max(r[2] for r in out) == 9999.0   # hi spike survives
    assert out[-1][3] == rows[-1][3]          # end value unchanged
    short = [(1, 0.0, 0.0, 0.0), (2, 1.0, 1.0, 1.0)]
    assert upnl.downsample(short, 720) == short


def test_sampler_backs_off_on_upstream_rate_limit_ban(monkeypatch):
    """The gateway's ban shape verbatim from the Sep '26 incidents (HTTP 403,
    'Access too frequent…') must land in the rate-limit branch: an extra
    cooldown instead of another poke 5s later — hammering a banned gateway is
    exactly what keeps the ban alive."""
    from app import dma_client

    async def banned():
        raise dma_client.DMAError(
            403, {"error": "Access too frequent. Please try again in 5 minutes."})
    monkeypatch.setattr(upnl.dma_client, "get_positions", banned)

    cooldown = run(upnl._sample_once())
    assert cooldown == settings.UPNL_SAMPLE_INTERVAL * upnl._RATE_LIMIT_EXTRA_CYCLES
    assert cooldown > 0


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
def test_record_sample_writes_raw_rollups_and_extremes(fake_redis):
    async def scenario():
        # 25 hours of samples, one per minute, value = a simple ramp then dip.
        base = 1_700_000_000_000 - (1_700_000_000_000 % upnl.H1_MS)
        for i in range(25 * 60):
            v = float(i if i < 1000 else 2000 - i)
            fake_redis.now_ms = base + i * 60_000
            await upnl.record_sample(v, 2, base + i * 60_000)
        return base

    base = run(scenario())
    assert len(fake_redis.streams[upnl.RAW_KEY]) == 25 * 60
    # Each sample lands in its own minute: every rolled minute is complete.
    assert len(fake_redis.streams[upnl.M1_KEY]) == 25 * 60 - 1
    assert len(fake_redis.streams[upnl.H1_KEY]) == 24
    first_hour = fake_redis.streams[upnl.H1_KEY][0][1]
    assert first_hour["t"] == str(base)
    assert first_hour["o"] == "0.0000" and first_hour["h"] == "59.0000"
    # All-time extremes: peak 1000 at the ramp/dip turn, trough at the start.
    ext = fake_redis.hashes[upnl.EXT_KEY]
    assert ext["maxV"] == "1000.0000"
    assert ext["minV"] == "0.0000"


def test_raw_stream_is_capped_by_maxlen(fake_redis, monkeypatch):
    monkeypatch.setattr(upnl, "_raw_maxlen", lambda: 10)
    async def scenario():
        for i in range(50):
            fake_redis.now_ms = 1_700_000_000_000 + i * 5000
            await upnl.record_sample(1.0, 1, fake_redis.now_ms)
    run(scenario())
    assert len(fake_redis.streams[upnl.RAW_KEY]) == 10


# ---------------------------------------------------------------------------
# Range responses
# ---------------------------------------------------------------------------
def test_range_response_disabled_without_redis_url(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    resp = run(upnl.range_response("6h"))
    assert resp["enabled"] is False
    assert resp["series"] == [] and "not configured" in resp["error"]


def test_range_response_serves_series_window_and_alltime(fake_redis, monkeypatch):
    import time as time_mod
    now_ms = 1_700_000_000_000

    async def scenario():
        # 2h of 5s samples ending "now"; values sweep -50 .. +50.
        n = 1440
        for i in range(n):
            ts = now_ms - (n - 1 - i) * 5000
            fake_redis.now_ms = ts
            await upnl.record_sample(float(i % 101 - 50), 3, ts)
    run(scenario())
    monkeypatch.setattr(time_mod, "time", lambda: now_ms / 1000)

    resp = run(upnl.range_response("1h"))
    assert resp["enabled"] is True and resp["error"] is None
    assert 0 < len(resp["series"]) <= upnl.MAX_POINTS
    assert resp["window"]["max"] == 50.0 and resp["window"]["min"] == -50.0
    assert resp["allTime"]["max"] == 50.0 and resp["allTime"]["min"] == -50.0
    assert resp["current"]["n"] == 3
    assert resp["redisUsedBytes"] == 4096
    # Series timestamps stay inside the requested window (1h + the live tail).
    assert all(pt[0] >= now_ms - 3_600_000 for pt in resp["series"])
    # Rollup-backed range includes the in-progress minute (reaches "now").
    day = run(upnl.range_response("24h"))
    assert day["series"] and day["series"][-1][0] >= now_ms - upnl.M1_MS


def test_range_response_survives_redis_outage(fake_redis, monkeypatch):
    async def boom(*a, **kw):
        raise upnl.RedisError("down")
    monkeypatch.setattr(fake_redis, "xrange", boom)
    resp = run(upnl.range_response("6h"))
    assert resp["enabled"] is True
    assert resp["series"] == [] and resp["error"] == "redis unavailable"


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
def test_api_upnl_requires_auth():
    r = TestClient(main_mod.app).get("/api/upnl")
    assert r.status_code == 401


def test_api_upnl_rejects_unknown_range(fake_redis):
    fake_user = {"u": "vwr", "r": "viewer", "sid": "test-sid"}
    main_mod.app.dependency_overrides[main_mod.current_user] = lambda: fake_user
    try:
        client = TestClient(main_mod.app)
        assert client.get("/api/upnl?range=2h").status_code == 400
        ok = client.get("/api/upnl?range=all")
        assert ok.status_code == 200
        body = ok.json()
        assert body["type"] == "upnl" and body["range"] == "all"
    finally:
        main_mod.app.dependency_overrides.clear()


def test_healthz_reports_upnl_age(monkeypatch):
    monkeypatch.setattr(upnl, "_last_sample_ms", None)
    r = TestClient(main_mod.app).get("/healthz")
    assert r.json()["upnlAgeSeconds"] is None
    import time as _t
    monkeypatch.setattr(upnl, "_last_sample_ms", int(_t.time() * 1000) - 30_000)
    r = TestClient(main_mod.app).get("/healthz")
    assert 25 <= r.json()["upnlAgeSeconds"] <= 35
