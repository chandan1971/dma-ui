// ===========================================================================
// RISK MANAGEMENT SYSTEM — the "Risk" tab (a portfolio risk command center)
// plus the compact Risk Overview panel on the Trade dashboard.
//
// ARCHITECTURE
// ------------
// • Loaded BEFORE app.js: this file only DEFINES consts + functions at the
//   top level; app.js's boot calls wireRisk() and renderDashboard() feeds
//   every live snapshot through rkIngest(d). Shared helpers (esc, fmtMoney,
//   fmtPct, pnlClass, toast, api, svgAreaChart, …) resolve at call time.
// • Pure, DOM-free core first (RK_* one-line consts + rkComputeMetrics /
//   rkRiskScore / rkEvalAlerts / rkDiffEvents / rkSanitizeViewState — all
//   extractable by tests/test_snap.mjs), then the DOM manager.
// • DATA HONESTY: every figure is either (a) an ACTUAL exchange value from
//   the live snapshot (equity, IM, MM, liq price, leverage, account MM
//   rate), (b) a DERIVED value computed only from actual values with the
//   derivation shown (margin utilization, exposure, liq distance, risk
//   score), or (c) SESSION-LOCAL context (equity peak, drawdown, history
//   sparklines) — labeled as such. Nothing is ever fabricated: a missing
//   input renders "—" and drops out of the risk score's weighting.
// • READ-ONLY BY CONSTRUCTION: nothing here can reach a write endpoint.
//   Alerts are toasts + notification-center entries only.
// • PERFORMANCE: metrics are O(positions) per 5s snapshot; each panel
//   re-renders only when its HTML actually changed (string dirty-check,
//   same as the tables); history series are bounded ring buffers.
// ===========================================================================

// ---------------------------------------------------------------------------
// Pure core — one-line consts so tests/test_snap.mjs can extract them.
// ---------------------------------------------------------------------------
const RK_BANDS = ["safe", "moderate", "high", "critical"];
const RK_BAND_LABELS = { safe: "Safe", moderate: "Moderate", high: "High", critical: "Critical" };
const RK_ALLOC_VIEWS = ["donut", "bars", "map"];
const RK_HIST_METRICS = ["score", "util", "gross", "lev", "equity"];
const RK_SORTS = ["symbol", "value", "share", "lev", "im", "liq", "upl", "fees"];
const RK_SERIES_MAX = 720;
const RK_SERIES_GAP_MS = 20000;
const RK_EVENTS_MAX = 100;
const RK_ALERT_COOLDOWN_MS = 15 * 60_000;
const RK_ALERTS_KEY = "dma.risk.alerts.v1";

// Coerce an exchange string/number into a finite number or null (never NaN —
// a null draws "—" and is excluded from derived math).
function rkNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Compute every risk metric from ONE dashboard snapshot (the same object the
// tables render — no extra requests). Returns a plain data object; rendering
// and alerting read from it. All derivations from actual fields only:
//   exposure       = Σ positionValue (exchange) split by side
//   margin util    = totalInitialMargin / totalMarginBalance   (both exchange)
//   account health = accountMMRate (exchange's own maintenance ratio)
//   liq distance   = |mark − liq| / mark (both exchange, per position)
//   portfolio lev  = gross exposure / equity                    (derived)
//   concentration  = largest / top-3 share of gross, HHI        (derived)
function rkComputeMetrics(d) {
  const rows = ((d && d.positions) || []).filter((p) => Number(p.size));
  const acct = (typeof walletAccount === "function" ? walletAccount(d && d.balance) : null) || {};
  const equity = rkNum(acct.totalEquity);
  const avail = rkNum(acct.totalAvailableBalance);
  const im = rkNum(acct.totalInitialMargin);
  const mm = rkNum(acct.totalMaintenanceMargin);
  const marginBal = rkNum(acct.totalMarginBalance);
  const upl = rkNum(acct.totalPerpUPL);
  const mmRate = rkNum(acct.accountMMRate); // exchange's own account maintenance ratio (0..1)

  let long = 0, short = 0;
  const positions = rows.map((p) => {
    const value = rkNum(p.positionValue) || 0;
    const side = String(p.side || "").toLowerCase() === "sell" ? "short" : "long";
    if (side === "long") long += value; else short += value;
    const mark = rkNum(p.markPrice), liq = rkNum(p.liqPrice);
    const liqDist = mark && mark > 0 && liq && liq > 0 ? (Math.abs(mark - liq) / mark) * 100 : null;
    const lev = rkNum(p.leverage);
    // positionIM is the exchange's own figure when present; otherwise the
    // standard estimate value/leverage (flagged so the UI can mark it "est.").
    const imActual = rkNum(p.positionIM);
    const posIm = imActual != null ? imActual : (lev && lev > 0 ? value / lev : null);
    const pUpl = rkNum(p.unrealisedPnl);
    return {
      symbol: String(p.symbol || "?"),
      side,
      size: rkNum(p.size),
      value,
      lev,
      im: posIm,
      imIsEstimate: imActual == null && posIm != null,
      upl: pUpl,
      uplPctIm: pUpl != null && posIm && posIm > 0 ? (pUpl / posIm) * 100 : null,
      liqDist,
      entry: rkNum(p.avgPrice),
      mark,
      liq,
    };
  });

  const gross = long + short;
  const net = long - short;
  positions.forEach((p) => { p.share = gross > 0 ? (p.value / gross) * 100 : null; });

  // Concentration (derived): largest / top-3 share + Herfindahl index.
  const shares = positions.map((p) => p.share || 0).sort((a, b) => b - a);
  const largest = positions.reduce((best, p) => (!best || p.value > best.value ? p : best), null);
  const top3Share = shares.slice(0, 3).reduce((a, b) => a + b, 0);
  const hhi = shares.reduce((a, s) => a + s * s, 0) / 100; // 0..100

  // Liquidation profile (derived from exchange mark/liq only).
  const dists = positions.filter((p) => p.liqDist != null);
  let nearest = null, farthest = null;
  dists.forEach((p) => {
    if (!nearest || p.liqDist < nearest.liqDist) nearest = p;
    if (!farthest || p.liqDist > farthest.liqDist) farthest = p;
  });
  const avgLiq = dists.length ? dists.reduce((a, p) => a + p.liqDist, 0) / dists.length : null;

  const util = im != null && marginBal && marginBal > 0 ? (im / marginBal) * 100 : null;
  const mmPct = mmRate != null ? mmRate * 100
    : (mm != null && marginBal && marginBal > 0 ? (mm / marginBal) * 100 : null);
  const portLev = equity && equity > 0 ? gross / equity : null;
  const uplPctEquity = upl != null && equity && equity > 0 ? (upl / equity) * 100 : null;

  return {
    ok: !(d && d.errors && (d.errors.positions || d.errors.balance)),
    partialPositions: !!(d && d.errors && d.errors.positions),
    count: positions.length,
    positions,
    wallet: { equity, avail, im, mm, marginBal, upl, mmRate },
    exposure: { gross, net, long, short, longPct: gross > 0 ? (long / gross) * 100 : null },
    concentration: {
      largestSymbol: largest ? largest.symbol : null,
      largestShare: largest && largest.share != null ? largest.share : null,
      top3Share: positions.length ? Math.min(100, top3Share) : null,
      hhi: positions.length ? hhi : null,
    },
    liq: {
      nearest: nearest ? { symbol: nearest.symbol, dist: nearest.liqDist } : null,
      farthest: farthest ? { symbol: farthest.symbol, dist: farthest.liqDist } : null,
      avg: avgLiq,
      covered: dists.length, // how many positions actually expose a liq price
    },
    margin: { util, mmPct, free: avail },
    leverage: { portfolio: portLev, uplPctEquity },
  };
}

// Overall risk score 0..100 from weighted factors. Each factor only counts
// when its inputs exist (weights re-normalize over available factors), so a
// missing exchange field can never fabricate risk. Flat positions → 0/Safe.
// Bands: <25 Safe · <50 Moderate · <75 High · ≥75 Critical.
function rkRiskScore(m) {
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const factors = [];
  const add = (key, label, weight, value, detail) => {
    if (value == null) { factors.push({ key, label, weight, score: null, detail: "unavailable" }); return; }
    factors.push({ key, label, weight, score: Math.round(clamp(value)), detail });
  };
  if (!m || !m.count) {
    return { score: 0, band: "safe", label: RK_BAND_LABELS.safe, factors: [], note: "No open positions — no market exposure." };
  }
  // Margin utilization: 0% → 0, 100% → 100 (linear; it IS the % used).
  add("util", "Margin utilization", 30,
    m.margin.util != null ? m.margin.util : null,
    m.margin.util != null ? `${m.margin.util.toFixed(1)}% of margin balance in use` : null);
  // Liquidation proximity: 25%+ away → 0; each 1% closer adds 4.
  add("liq", "Liquidation proximity", 25,
    m.liq.nearest ? 100 - m.liq.nearest.dist * 4 : null,
    m.liq.nearest ? `nearest ${m.liq.nearest.symbol} at ${m.liq.nearest.dist.toFixed(1)}% from mark` : null);
  // Portfolio leverage: gross/equity; 12.5x → 100.
  add("lev", "Portfolio leverage", 20,
    m.leverage.portfolio != null ? m.leverage.portfolio * 8 : null,
    m.leverage.portfolio != null ? `${m.leverage.portfolio.toFixed(2)}x gross exposure vs equity` : null);
  // Concentration: ≤30% largest-position share → 0, 100% → 100.
  add("conc", "Concentration", 15,
    m.concentration.largestShare != null ? (m.concentration.largestShare - 30) * (100 / 70) : null,
    m.concentration.largestShare != null
      ? `${m.concentration.largestSymbol} is ${m.concentration.largestShare.toFixed(0)}% of gross exposure` : null);
  // Unrealized pain: −10% of equity → 100 (profit contributes 0).
  add("pain", "Unrealized loss", 10,
    m.leverage.uplPctEquity != null ? -m.leverage.uplPctEquity * 10 : null,
    m.leverage.uplPctEquity != null ? `unrealized PnL is ${m.leverage.uplPctEquity.toFixed(1)}% of equity` : null);

  const usable = factors.filter((f) => f.score != null);
  const wSum = usable.reduce((a, f) => a + f.weight, 0);
  const score = wSum > 0 ? Math.round(usable.reduce((a, f) => a + f.score * f.weight, 0) / wSum) : 0;
  const band = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "moderate" : "safe";
  return { score, band, label: RK_BAND_LABELS[band], factors, note: null };
}

// Alert rules: value extractor + ON/OFF thresholds (hysteresis so a value
// hovering at a threshold cannot re-fire on every snapshot). `dir: "lte"`
// fires when the value drops TO/below `on` (liquidation distance).
// NOTIFY-ONLY: firing produces a toast + notification entry, never an action.
const RK_ALERT_DEFS = [
  { id: "util-high", level: "warn", dir: "gte", on: 70, off: 65,
    value: (m) => m.margin.util,
    msg: (v) => `Risk: margin utilization ${v.toFixed(1)}% (≥70%)` },
  { id: "util-critical", level: "neg", dir: "gte", on: 90, off: 85,
    value: (m) => m.margin.util,
    msg: (v) => `Risk: margin utilization CRITICAL ${v.toFixed(1)}% (≥90%)` },
  { id: "liq-near", level: "warn", dir: "lte", on: 10, off: 12,
    value: (m) => (m.liq.nearest ? m.liq.nearest.dist : null),
    msg: (v, m) => `Risk: ${m.liq.nearest.symbol} is ${v.toFixed(1)}% from liquidation (<10%)` },
  { id: "liq-critical", level: "neg", dir: "lte", on: 5, off: 6,
    value: (m) => (m.liq.nearest ? m.liq.nearest.dist : null),
    msg: (v, m) => `Risk: ${m.liq.nearest.symbol} is ${v.toFixed(1)}% from LIQUIDATION (<5%)` },
  { id: "score-critical", level: "neg", dir: "gte", on: 75, off: 70,
    value: (m, s) => (s ? s.score : null),
    msg: (v) => `Risk score CRITICAL (${Math.round(v)}/100)` },
  { id: "concentration", level: "warn", dir: "gte", on: 70, off: 65,
    value: (m) => (m.count >= 2 ? m.concentration.largestShare : null),
    msg: (v, m) => `Risk: ${m.concentration.largestSymbol} is ${v.toFixed(0)}% of gross exposure` },
  { id: "large-loss", level: "warn", dir: "lte", on: -5, off: -4,
    value: (m) => m.leverage.uplPctEquity,
    msg: (v) => `Risk: unrealized loss is ${Math.abs(v).toFixed(1)}% of equity` },
  { id: "high-leverage", level: "warn", dir: "gte", on: 10, off: 9,
    value: (m) => m.leverage.portfolio,
    msg: (v) => `Risk: portfolio leverage ${v.toFixed(1)}x (≥10x)` },
];

// Evaluate the alert rules against one metrics object. Pure: consumes and
// returns `state` ({active:{}, lastFired:{}}); the caller owns delivery.
// Fires only on a RISING edge (inactive → active) outside the cooldown.
function rkEvalAlerts(m, score, state, nowMs, defs) {
  const st = {
    active: Object.assign({}, state && state.active),
    lastFired: Object.assign({}, state && state.lastFired),
  };
  const fired = [];
  (defs || RK_ALERT_DEFS).forEach((def) => {
    const v = def.value(m, score);
    if (v == null) { delete st.active[def.id]; return; }
    const wasActive = !!st.active[def.id];
    const active = def.dir === "lte"
      ? (wasActive ? v <= def.off : v <= def.on)
      : (wasActive ? v >= def.off : v >= def.on);
    if (active && !wasActive) {
      // A rule that has NEVER fired always may (lastFired is absent, not 0 —
      // the cooldown compares only against a real previous firing).
      const last = st.lastFired[def.id];
      if (last == null || nowMs - last >= RK_ALERT_COOLDOWN_MS) {
        fired.push({ id: def.id, level: def.level, msg: def.msg(v, m) });
        st.lastFired[def.id] = nowMs;
      }
    }
    if (active) st.active[def.id] = true; else delete st.active[def.id];
  });
  return { fired, state: st };
}

// Diff two consecutive metrics objects into human-readable timeline events.
// Pure; the caller stamps timestamps and owns the ring buffer.
function rkDiffEvents(prev, cur, prevScore, curScore) {
  const out = [];
  if (!prev || !cur || !cur.ok || !prev.ok) return out;
  const pPos = {}, cPos = {};
  prev.positions.forEach((p) => { pPos[`${p.symbol}/${p.side}`] = p; });
  cur.positions.forEach((p) => { cPos[`${p.symbol}/${p.side}`] = p; });
  Object.keys(cPos).forEach((k) => {
    const c = cPos[k], p = pPos[k];
    if (!p) { out.push({ level: "info", msg: `Position opened: ${c.symbol} ${c.side}` }); return; }
    if (c.size != null && p.size != null && c.size !== p.size) {
      const grew = Math.abs(c.size) > Math.abs(p.size);
      out.push({
        level: grew ? "warn" : "info",
        msg: `Position ${grew ? "increased" : "reduced"}: ${c.symbol} ${c.side} (${p.size} → ${c.size})`,
      });
    }
  });
  Object.keys(pPos).forEach((k) => {
    if (!cPos[k]) out.push({ level: "info", msg: `Position closed: ${pPos[k].symbol} ${pPos[k].side}` });
  });
  const bandCross = (pv, cv, marks, up, down) => {
    if (pv == null || cv == null) return;
    marks.forEach((mk) => {
      if (pv < mk && cv >= mk) out.push(up(mk));
      else if (pv >= mk && cv < mk) out.push(down(mk));
    });
  };
  bandCross(prev.margin.util, cur.margin.util, [50, 70, 90],
    (mk) => ({ level: mk >= 90 ? "neg" : "warn", msg: `Margin utilization rose above ${mk}% (${cur.margin.util.toFixed(1)}%)` }),
    (mk) => ({ level: "pos", msg: `Margin utilization fell below ${mk}% (${cur.margin.util.toFixed(1)}%)` }));
  const pLiq = prev.liq.nearest ? prev.liq.nearest.dist : null;
  const cLiq = cur.liq.nearest ? cur.liq.nearest.dist : null;
  // For distance, RISING past a mark is the SAFE direction, falling is danger.
  bandCross(pLiq, cLiq, [5, 10, 20],
    (mk) => ({ level: "pos", msg: `Nearest liquidation moved beyond ${mk}% away` }),
    (mk) => ({ level: mk <= 5 ? "neg" : "warn", msg: `Nearest liquidation closer than ${mk}% (${cur.liq.nearest ? cur.liq.nearest.symbol : ""} ${cLiq != null ? cLiq.toFixed(1) : "?"}%)` }));
  if (prevScore && curScore && prevScore.band !== curScore.band) {
    const worse = RK_BANDS.indexOf(curScore.band) > RK_BANDS.indexOf(prevScore.band);
    out.push({
      level: worse ? (curScore.band === "critical" ? "neg" : "warn") : "pos",
      msg: `Risk score → ${curScore.label} (${curScore.score}/100)`,
    });
  }
  return out;
}

// Per-workspace VIEW state (what §Workspaces persists for the Risk tab).
// The alert-armed switch is deliberately NOT here: alerting is account-level,
// not a per-layout preference.
function rkSanitizeViewState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    alloc: RK_ALLOC_VIEWS.includes(src.alloc) ? src.alloc : "donut",
    sort: RK_SORTS.includes(src.sort) ? src.sort : "value",
    dir: src.dir === "asc" ? "asc" : "desc",
    hist: RK_HIST_METRICS.includes(src.hist) ? src.hist : "score",
  };
}

// ===========================================================================
// Engine state (session-local; bounded)
// ===========================================================================

let _rkMetrics = null;      // last computed metrics
let _rkScore = null;        // last risk score
let _rkPrevMetrics = null;  // previous COMPLETE metrics (for diffs)
let _rkPrevScore = null;
const _rkSeries = [];       // ring: {t, equity, util, score, gross, lev}
const _rkEvents = [];       // ring: {t, level, msg} (session timeline)
let _rkAlertState = { active: {}, lastFired: {} };
let _rkArmed = true;        // alerts armed (persisted globally, NOT per workspace)
let _rkView = rkSanitizeViewState(null);
let _rkDaily = null;        // { closed: rows[], exec: rows[], at: ms, error }
let _rkDailyTimer = null;
let _rkDailyFetching = false;
let _rkSessionPeak = null;  // session equity peak {t, equity}
let _rkWired = false;
const _rkPaneCache = {};    // section id -> last rendered HTML (dirty-check)

function rkPaneVisible() {
  const pane = document.querySelector('[data-pane="risk"]');
  return !!pane && !pane.hidden && !document.hidden;
}

// ---- helpers ---------------------------------------------------------------

function rkMoney(v, cls) {
  if (v == null) return `<span class="muted">—</span>`;
  return `<span class="priv ${cls || ""}">${fmtMoney(v)} ${esc(curUnit())}</span>`;
}
function rkMoneySigned(v) {
  if (v == null) return `<span class="muted">—</span>`;
  return `<span class="priv ${pnlClass(v)}">${fmtMoneySigned(v)} ${esc(curUnit())}</span>`;
}
function rkPct(v, digits = 1) {
  return v == null ? "—" : `${v.toFixed(digits)}%`;
}
function rkAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}
function rkUtilClass(util) {
  return util == null ? "flat" : util >= 90 ? "neg" : util >= 70 ? "warn" : util >= 50 ? "mid" : "pos";
}
function rkLiqClass(dist) {
  return dist == null ? "flat" : dist < 5 ? "neg" : dist < 10 ? "warn" : dist < 20 ? "mid" : "pos";
}

// ===========================================================================
// Ingest — called by renderDashboard() with EVERY live snapshot (WS + GET).
// ===========================================================================

function rkIngest(d) {
  if (!d) return;
  const m = rkComputeMetrics(d);
  const score = rkRiskScore(m);

  if (m.ok) {
    // Timeline diff + alert evaluation only across COMPLETE snapshots — a
    // failed positions read must never read as "everything closed".
    const now = Date.now();
    const events = rkDiffEvents(_rkPrevMetrics, m, _rkPrevScore, score);
    events.forEach((ev) => {
      _rkEvents.unshift({ t: now, level: ev.level, msg: ev.msg });
    });
    if (_rkEvents.length > RK_EVENTS_MAX) _rkEvents.length = RK_EVENTS_MAX;

    if (_rkArmed) {
      const res = rkEvalAlerts(m, score, _rkAlertState, now);
      _rkAlertState = res.state;
      res.fired.forEach((a) => {
        if (typeof toast === "function") toast(a.msg, a.level === "neg" ? "neg" : "warn", 8000);
        _rkEvents.unshift({ t: now, level: a.level, msg: a.msg });
      });
      if (_rkEvents.length > RK_EVENTS_MAX) _rkEvents.length = RK_EVENTS_MAX;
    }

    // Session history sample (throttled ring buffer).
    const last = _rkSeries[_rkSeries.length - 1];
    if (!last || now - last.t >= RK_SERIES_GAP_MS) {
      if (m.wallet.equity != null) {
        _rkSeries.push({
          t: now,
          equity: m.wallet.equity,
          util: m.margin.util,
          score: score.score,
          gross: m.exposure.gross,
          lev: m.leverage.portfolio,
        });
        if (_rkSeries.length > RK_SERIES_MAX) _rkSeries.shift();
        if (!_rkSessionPeak || m.wallet.equity > _rkSessionPeak.equity) {
          _rkSessionPeak = { t: now, equity: m.wallet.equity };
        }
      }
    }
    _rkPrevMetrics = m;
    _rkPrevScore = score;
  }

  _rkMetrics = m;
  _rkScore = score;
  rkRenderOverview();      // compact panel on the Trade dashboard
  if (rkPaneVisible()) rkRenderPane();
}

// ===========================================================================
// Daily context (exchange history via the MongoDB mirror; refreshed while
// the Risk tab is visible — one pair of reads per minute, nothing new).
// ===========================================================================

async function rkFetchDaily() {
  // Single-flight that RETURNS the in-flight promise, so a concurrent caller
  // (the execution workspace shares this day window) awaiting rkFetchDaily()
  // resumes with fresh data instead of racing ahead with the stale copy.
  if (_rkDailyFetching) return _rkDailyFetching;
  _rkDailyFetching = (async () => {
    try {
      const [closed, exec] = await Promise.allSettled([
        api("/api/closed-pnl?days=1"),
        api("/api/executions?days=1"),
      ]);
      _rkDaily = {
        closed: closed.status === "fulfilled" ? listOf(closed.value) : null,
        exec: exec.status === "fulfilled" ? listOf(exec.value) : null,
        error: closed.status === "rejected" && exec.status === "rejected",
        at: Date.now(),
      };
    } finally {
      _rkDailyFetching = false;
    }
    if (rkPaneVisible()) rkRenderPane();
  })();
  return _rkDailyFetching;
}

// Aggregate today's (local midnight) realized results from the mirror rows.
function rkDailyStats() {
  if (!_rkDaily || (!_rkDaily.closed && !_rkDaily.exec)) return null;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const out = {
    realized: null, trades: 0, wins: 0, best: null, worst: null,
    fees: null, funding: null, feesBySymbol: {}, at: _rkDaily.at,
  };
  (_rkDaily.closed || []).forEach((r) => {
    const t = Number(r.updatedTime ?? r.createdTime);
    if (!isFinite(t) || t < t0) return;
    const v = Number(r.closedPnl);
    if (!isFinite(v)) return;
    out.realized = (out.realized || 0) + v;
    out.trades += 1;
    if (v > 0) out.wins += 1;
    if (!out.best || v > out.best.pnl) out.best = { symbol: String(r.symbol || "?"), pnl: v };
    if (!out.worst || v < out.worst.pnl) out.worst = { symbol: String(r.symbol || "?"), pnl: v };
  });
  (_rkDaily.exec || []).forEach((r) => {
    const t = Number(r.execTime ?? r.updatedTime ?? r.createdTime);
    if (!isFinite(t) || t < t0) return;
    const fee = Number(r.execFee);
    if (!isFinite(fee)) return;
    const sym = String(r.symbol || "?");
    if (String(r.execType || "") === "Funding") {
      out.funding = (out.funding || 0) + fee;
    } else {
      out.fees = (out.fees || 0) + fee;
    }
    out.feesBySymbol[sym] = (out.feesBySymbol[sym] || 0) + fee;
  });
  return out;
}

// Session drawdown from the equity ring buffer (labeled session-local).
function rkDrawdown() {
  if (_rkSeries.length < 2) return null;
  let peak = -Infinity, peakT = 0, maxDD = 0, trough = Infinity;
  let curPeak = -Infinity, curPeakT = 0;
  _rkSeries.forEach((s) => {
    if (s.equity > curPeak) { curPeak = s.equity; curPeakT = s.t; }
    const dd = curPeak > 0 ? ((s.equity - curPeak) / curPeak) * 100 : 0;
    if (dd < maxDD) maxDD = dd;
    if (s.equity > peak) { peak = s.equity; peakT = s.t; trough = s.equity; }
    if (s.equity < trough) trough = s.equity;
  });
  const last = _rkSeries[_rkSeries.length - 1];
  const current = peak > 0 ? ((last.equity - peak) / peak) * 100 : 0;
  const recovery = peak > trough && last.equity > trough
    ? ((last.equity - trough) / (peak - trough)) * 100 : null;
  return {
    current: Math.min(0, current),
    max: maxDD,
    peak, peakT, trough,
    recovery: current < 0 && recovery != null ? Math.min(100, recovery) : null,
    sincePeakMs: Date.now() - peakT,
    samples: _rkSeries.length,
  };
}

// ===========================================================================
// Rendering — every section paints into its own container with a string
// dirty-check, so an unchanged panel costs one string compare per snapshot.
// ===========================================================================

function rkSet(id, html) {
  if (_rkPaneCache[id] === html) return;
  const el = document.getElementById(id);
  if (!el) return;
  _rkPaneCache[id] = html;
  el.innerHTML = html;
}

// ---- compact Risk Overview panel on the Trade dashboard --------------------

function rkRenderOverview() {
  const body = document.getElementById("risk-body");
  if (!body) return;
  const m = _rkMetrics, score = _rkScore;
  if (!m || m.partialPositions) return; // keep last good view over live risk
  let html;
  if (!m.count) {
    html = `<p class="muted center" style="padding:20px 12px">No open positions — no market exposure.</p>`;
  } else {
    const liqCls = m.liq.nearest ? rkLiqClass(m.liq.nearest.dist) : "flat";
    const utilCls = rkUtilClass(m.margin.util);
    const longPct = m.exposure.longPct != null ? m.exposure.longPct : 50;
    html =
      `<div class="risk-grid">` +
        jTile("Risk score", `<span class="rk-band-chip ${esc(score.band)}">${score.score} · ${esc(score.label)}</span>`, "") +
        jTile("Gross exposure", `${fmtMoney(m.exposure.gross)} ${esc(curUnit())}`, "flat") +
        jTile("Net exposure", `${fmtMoneySigned(m.exposure.net)}`, pnlClass(m.exposure.net)) +
        jTile("Margin utilization", m.margin.util != null ? fmtPct(m.margin.util, false) : "—", utilCls === "mid" ? "warn" : utilCls) +
        jTile("Nearest liquidation",
          m.liq.nearest ? `${esc(m.liq.nearest.symbol)} · ${m.liq.nearest.dist.toFixed(1)}%` : "—", liqCls === "mid" ? "warn" : liqCls) +
        jTile("Largest position",
          m.concentration.largestSymbol
            ? `${esc(m.concentration.largestSymbol)} · ${rkPct(m.concentration.largestShare, 0)}` : "—", "flat") +
      `</div>` +
      `<div class="risk-split" role="img" aria-label="Long ${longPct.toFixed(0)} percent of gross exposure">` +
        `<span class="rs-long" style="width:${longPct.toFixed(1)}%"></span>` +
        `<span class="rs-short" style="width:${(100 - longPct).toFixed(1)}%"></span>` +
      `</div>` +
      `<div class="risk-split-labels">` +
        `<span class="pos priv">Long ${fmtMoney(m.exposure.long)}</span>` +
        `<span class="neg priv">Short ${fmtMoney(m.exposure.short)}</span>` +
      `</div>`;
  }
  rkSet("risk-body", html);
}

// ---- score gauge (SVG semicircle; CSP-safe, no external assets) -------------

function rkGaugeSVG(score) {
  const W = 220, H = 130, cx = 110, cy = 116, r = 92;
  const arc = (a0, a1, color, width) => {
    const p = (a) => {
      const rad = (Math.PI * (180 - a)) / 180;
      return `${(cx + r * Math.cos(rad)).toFixed(1)} ${(cy - r * Math.sin(rad)).toFixed(1)}`;
    };
    return `<path d="M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  };
  // Band arc: 0-45° safe, 45-90 moderate, 90-135 high, 135-180 critical.
  const bands = [
    [0, 45, "var(--pos)"], [45, 90, "#e3c04a"], [90, 135, "#f08c3d"], [135, 180, "var(--neg)"],
  ];
  const angle = (Math.max(0, Math.min(100, score.score)) / 100) * 180;
  const rad = (Math.PI * (180 - angle)) / 180;
  const nx = cx + (r - 16) * Math.cos(rad), ny = cy - (r - 16) * Math.sin(rad);
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="rk-gauge-svg" role="img" aria-label="Risk score ${score.score} of 100, ${esc(score.label)}">` +
      bands.map(([a0, a1, c]) => arc(a0 + 1.5, a1 - 1.5, c, 7)).join("") +
      `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="rk-needle"/>` +
      `<circle cx="${cx}" cy="${cy}" r="5" class="rk-needle-hub"/>` +
    `</svg>`
  );
}

// ---- Risk pane sections ------------------------------------------------------

function rkRenderHead() {
  const m = _rkMetrics, score = _rkScore;
  if (!m) return;
  const w = m.wallet;
  const daily = rkDailyStats();
  const factorChips = score.factors
    .filter((f) => f.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((f) =>
      `<span class="rk-chip ${f.score >= 75 ? "neg" : f.score >= 50 ? "warn" : "flat"}" title="${esc(f.detail || "")}">${esc(f.label)} ${f.score}</span>`
    ).join("");
  const explain = score.note
    ? `<p class="rk-why muted">${esc(score.note)}</p>`
    : `<p class="rk-why muted">Weighted from ${score.factors.filter((f) => f.score != null).length} live factors — hover a chip for the derivation. Derived client-side from exchange values.</p>`;
  const kpi = (label, value, sub, cls) =>
    `<div class="rk-kpi"><div class="k">${esc(label)}</div><div class="v ${cls || ""}">${value}</div>${sub ? `<div class="s muted">${sub}</div>` : ""}</div>`;
  const utilCls = rkUtilClass(m.margin.util);
  const html =
    `<div class="rk-head-grid">` +
      `<div class="rk-gauge">` +
        rkGaugeSVG(score) +
        `<div class="rk-gauge-val"><b class="rk-band-txt ${esc(score.band)}">${score.score}</b><span class="rk-band-chip ${esc(score.band)}">${esc(score.label)}</span></div>` +
        `<div class="rk-chips">${factorChips}</div>` +
        explain +
      `</div>` +
      `<div class="rk-kpis">` +
        kpi("Portfolio value", rkMoney(w.equity), "equity · exchange") +
        kpi("Available margin", rkMoney(w.avail), "exchange") +
        kpi("Unrealized PnL", rkMoneySigned(w.upl),
          m.leverage.uplPctEquity != null ? `${fmtPct(m.leverage.uplPctEquity)} of equity` : "exchange", "") +
        kpi("Realized today", daily && daily.realized != null ? rkMoneySigned(daily.realized) : `<span class="muted">—</span>`,
          daily ? `${daily.trades} closes · history mirror` : "opens with history") +
        kpi("Used margin (IM)", rkMoney(w.im), "initial margin · exchange") +
        kpi("Margin utilization", `<span class="${utilCls === "mid" ? "warn" : utilCls}">${rkPct(m.margin.util)}</span>`,
          "IM ÷ margin balance · derived") +
        kpi("Portfolio leverage", m.leverage.portfolio != null ? `${m.leverage.portfolio.toFixed(2)}x` : "—",
          "gross ÷ equity · derived") +
        kpi("Account health", m.wallet.mmRate != null
          ? `<span class="${m.margin.mmPct >= 80 ? "neg" : m.margin.mmPct >= 50 ? "warn" : "pos"}">${rkPct(m.margin.mmPct, 2)}</span>`
          : (m.margin.mmPct != null ? `<span class="muted">~${rkPct(m.margin.mmPct, 2)}</span>` : "—"),
          m.wallet.mmRate != null ? "account MM rate · exchange" : "MM ÷ margin balance · derived") +
      `</div>` +
    `</div>`;
  rkSet("rk-head-body", html);
}

function rkAllocRows(m) {
  const sorted = m.positions.slice().sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7);
  const rows = top.map((p) => ({ symbol: p.symbol, value: p.value, share: p.share || 0, side: p.side, upl: p.upl }));
  if (rest.length) {
    rows.push({
      symbol: `Others (${rest.length})`,
      value: rest.reduce((a, p) => a + p.value, 0),
      share: rest.reduce((a, p) => a + (p.share || 0), 0),
      side: "mixed",
      upl: rest.reduce((a, p) => a + (p.upl || 0), 0),
    });
  }
  return rows;
}

const RK_ALLOC_COLORS = ["#8f97ff", "#00c98d", "#f08c3d", "#e3c04a", "#ff4d67", "#4fc3f7", "#b784f2", "#6e7891"];

function rkRenderExposure() {
  const m = _rkMetrics;
  if (!m) return;
  let html;
  if (!m.count) {
    html = `<p class="muted center" style="padding:26px 12px">No open positions.</p>`;
  } else {
    const longPct = m.exposure.longPct != null ? m.exposure.longPct : 50;
    const tiles =
      `<div class="rk-tiles">` +
        jTile("Gross", `${fmtMoney(m.exposure.gross)} ${esc(curUnit())}`, "flat") +
        jTile("Net", fmtMoneySigned(m.exposure.net), pnlClass(m.exposure.net)) +
        jTile("Long", fmtMoney(m.exposure.long), "pos") +
        jTile("Short", fmtMoney(m.exposure.short), "neg") +
      `</div>` +
      `<div class="risk-split" role="img" aria-label="Long ${longPct.toFixed(0)}% of gross exposure">` +
        `<span class="rs-long" style="width:${longPct.toFixed(1)}%"></span>` +
        `<span class="rs-short" style="width:${(100 - longPct).toFixed(1)}%"></span>` +
      `</div>` +
      `<div class="risk-split-labels"><span class="pos">Long ${rkPct(longPct, 0)}</span><span class="neg">Short ${rkPct(100 - longPct, 0)}</span></div>`;

    const rows = rkAllocRows(m);
    const seg = `<div class="segment rk-allocseg" role="group" aria-label="Allocation view">` +
      RK_ALLOC_VIEWS.map((v) =>
        `<button type="button" class="seg-neutral${_rkView.alloc === v ? " active" : ""}" data-rkalloc="${v}" aria-pressed="${_rkView.alloc === v}">${v === "donut" ? "Donut" : v === "bars" ? "Bars" : "Map"}</button>`
      ).join("") + `</div>`;

    let alloc = "";
    if (_rkView.alloc === "donut") {
      const C = 2 * Math.PI * 40;
      let off = 0;
      const segs = rows.map((r, i) => {
        const frac = Math.max(0, r.share) / 100;
        const s = `<circle r="40" cx="55" cy="55" fill="none" stroke="${RK_ALLOC_COLORS[i % RK_ALLOC_COLORS.length]}" stroke-width="14" stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}" stroke-dashoffset="${(-off * C).toFixed(2)}"/>`;
        off += frac;
        return s;
      }).join("");
      alloc =
        `<div class="rk-donut-wrap">` +
          `<svg viewBox="0 0 110 110" class="rk-donut" role="img" aria-label="Allocation by symbol">${segs}` +
            `<text x="55" y="52" text-anchor="middle" class="rk-donut-n">${m.count}</text>` +
            `<text x="55" y="66" text-anchor="middle" class="rk-donut-l">positions</text>` +
          `</svg>` +
          `<div class="rk-legend">` +
            rows.map((r, i) =>
              `<div class="rk-leg-row"><i style="background:${RK_ALLOC_COLORS[i % RK_ALLOC_COLORS.length]}"></i>` +
              `<span class="sym mono">${esc(r.symbol)}</span><span class="mono">${rkPct(r.share, 1)}</span>` +
              `<span class="mono priv muted">${fmtMoney(r.value)}</span></div>`
            ).join("") +
          `</div>` +
        `</div>`;
    } else if (_rkView.alloc === "bars") {
      const max = rows.reduce((a, r) => Math.max(a, r.share), 0) || 1;
      alloc = `<div class="rk-allocbars">` + rows.map((r, i) =>
        `<div class="rk-abar-row"><span class="sym mono">${esc(r.symbol)}</span>` +
        `<div class="rk-abar"><span style="width:${((r.share / max) * 100).toFixed(1)}%;background:${RK_ALLOC_COLORS[i % RK_ALLOC_COLORS.length]}"></span></div>` +
        `<span class="mono">${rkPct(r.share, 1)}</span></div>`
      ).join("") + `</div>`;
    } else {
      // "Map": share-sized tiles, tinted by position PnL (green/red heat).
      alloc = `<div class="rk-map">` + rows.map((r) => {
        const uplPct = r.value > 0 && r.upl != null ? (r.upl / r.value) * 100 : null;
        const heat = uplPct == null ? "flat" : uplPct >= 0 ? "pos" : "neg";
        const alpha = uplPct == null ? 0.1 : Math.min(0.42, 0.1 + Math.abs(uplPct) * 0.05);
        // The neutral tile uses the theme's veil channel (a hardcoded white
        // wash disappears on the light theme); pos/neg keep the brand hues,
        // which read on both backgrounds.
        const bg = heat === "pos" ? `rgba(0,201,141,${alpha.toFixed(2)})` : heat === "neg" ? `rgba(255,77,103,${alpha.toFixed(2)})` : "rgba(var(--veil-rgb),0.06)";
        return `<div class="rk-map-tile" style="flex-basis:${Math.max(9, r.share).toFixed(1)}%;background:${bg}" title="${esc(r.symbol)} · ${rkPct(r.share, 1)} of gross">` +
          `<span class="sym mono">${esc(r.symbol)}</span>` +
          `<span class="mono">${rkPct(r.share, 0)}</span>` +
          `<span class="mono priv ${uplPct == null ? "muted" : uplPct >= 0 ? "pos" : "neg"}">${r.upl != null ? fmtMoneySigned(r.upl) : ""}</span>` +
        `</div>`;
      }).join("") + `</div>`;
    }
    html = tiles + `<div class="rk-alloc-head"><h3>Allocation</h3>${seg}</div>` + alloc;
  }
  rkSet("rk-exposure-body", html);
}

function rkRenderConcentration() {
  const m = _rkMetrics;
  if (!m) return;
  let html;
  if (!m.count) {
    html = `<p class="muted center" style="padding:20px 12px">No open positions.</p>`;
  } else {
    const c = m.concentration;
    const warnLevel = c.largestShare != null && m.count >= 2 && c.largestShare >= 70 ? "neg"
      : c.largestShare != null && m.count >= 2 && c.largestShare >= 50 ? "warn" : null;
    const meter = (label, val, cls) =>
      `<div class="rk-meter-row"><span class="k">${esc(label)}</span>` +
      `<div class="rk-meter"><span class="${cls || ""}" style="width:${Math.min(100, val || 0).toFixed(1)}%"></span></div>` +
      `<span class="mono">${rkPct(val, 0)}</span></div>`;
    html =
      (warnLevel
        ? `<div class="rk-warnstrip ${warnLevel}">⚠ ${esc(c.largestSymbol)} dominates the portfolio at ${rkPct(c.largestShare, 0)} of gross exposure.</div>`
        : m.count === 1
          ? `<div class="rk-warnstrip flat">Single-position portfolio — concentration is structural (100% in ${esc(c.largestSymbol)}).</div>`
          : "") +
      meter(`Largest · ${c.largestSymbol || "—"}`, c.largestShare, c.largestShare >= 70 ? "neg" : c.largestShare >= 50 ? "warn" : "pos") +
      meter("Top 3 positions", c.top3Share, c.top3Share >= 90 ? "warn" : "pos") +
      meter("HHI (diversification)", c.hhi, c.hhi >= 60 ? "warn" : "pos") +
      `<p class="rk-src muted">Herfindahl index of exposure shares: 100 = everything in one market, lower = more diversified. Derived.</p>`;
  }
  rkSet("rk-conc-body", html);
}

function rkRenderLiq() {
  const m = _rkMetrics;
  if (!m) return;
  let html;
  if (!m.count) {
    html = `<p class="muted center" style="padding:20px 12px">No open positions.</p>`;
  } else if (!m.liq.covered) {
    html = `<p class="muted center" style="padding:20px 12px">The exchange reports no liquidation price for the open positions (cross-margin without a liq level, or data unavailable).</p>`;
  } else {
    const tiles =
      `<div class="rk-tiles">` +
        jTile("Nearest", m.liq.nearest ? `${esc(m.liq.nearest.symbol)} · ${m.liq.nearest.dist.toFixed(1)}%` : "—",
          m.liq.nearest ? (rkLiqClass(m.liq.nearest.dist) === "mid" ? "warn" : rkLiqClass(m.liq.nearest.dist)) : "flat") +
        jTile("Farthest", m.liq.farthest ? `${esc(m.liq.farthest.symbol)} · ${m.liq.farthest.dist.toFixed(1)}%` : "—", "flat") +
        jTile("Average distance", rkPct(m.liq.avg), "flat") +
        jTile("With liq price", `${m.liq.covered}/${m.count}`, "flat") +
      `</div>`;
    const rows = m.positions.filter((p) => p.liqDist != null).sort((a, b) => a.liqDist - b.liqDist);
    const bars = `<div class="rk-liqbars">` + rows.map((p) => {
      const cls = rkLiqClass(p.liqDist);
      const w = Math.min(100, (p.liqDist / 50) * 100);
      return `<div class="rk-liq-row" title="mark ${p.mark != null ? p.mark : "?"} → liq ${p.liq != null ? p.liq : "?"}">` +
        `<span class="sym mono">${esc(p.symbol)}</span><span class="side ${p.side === "long" ? "pos" : "neg"}">${p.side === "long" ? "L" : "S"}</span>` +
        `<div class="rk-liqtrack"><span class="${cls}" style="width:${w.toFixed(1)}%"></span></div>` +
        `<span class="mono ${cls === "mid" ? "" : cls}">${p.liqDist.toFixed(1)}%</span></div>`;
    }).join("") + `</div>`;
    html = tiles + bars +
      `<p class="rk-src muted">Distance = |mark − liq| ÷ mark, from the exchange's own mark & liquidation prices. Bar scale caps at 50%.</p>`;
  }
  rkSet("rk-liq-body", html);
}

function rkRenderMargin() {
  const m = _rkMetrics;
  if (!m) return;
  const w = m.wallet;
  const utilCls = rkUtilClass(m.margin.util);
  const meter =
    `<div class="rk-utilmeter" role="img" aria-label="Margin utilization ${rkPct(m.margin.util)}">` +
      `<div class="rk-utiltrack">` +
        `<span class="fill ${utilCls}" style="width:${Math.min(100, m.margin.util || 0).toFixed(1)}%"></span>` +
        `<i class="tick" style="left:70%" title="alert at 70%"></i><i class="tick" style="left:90%" title="critical at 90%"></i>` +
      `</div>` +
      `<div class="rk-utillabels"><span>0%</span><span class="${utilCls === "mid" ? "warn" : utilCls}">${rkPct(m.margin.util)}</span><span>100%</span></div>` +
    `</div>`;
  const spark = rkSparkline("util");
  const html =
    meter +
    `<div class="rk-tiles">` +
      jTile("Available", rkMoney(w.avail), "") +
      jTile("Used (IM)", rkMoney(w.im), "") +
      jTile("Maintenance (MM)", rkMoney(w.mm), "") +
      jTile("Margin balance", rkMoney(w.marginBal), "") +
      jTile("Account MM rate", w.mmRate != null ? rkPct(m.margin.mmPct, 2) : "—",
        m.margin.mmPct != null && m.margin.mmPct >= 50 ? "warn" : "flat") +
      jTile("Free margin (est.)", rkMoney(w.avail), "") +
    `</div>` +
    (m.margin.util != null && m.margin.util >= 70
      ? `<div class="rk-warnstrip ${m.margin.util >= 90 ? "neg" : "warn"}">⚠ Margin utilization ${rkPct(m.margin.util)} — ${m.margin.util >= 90 ? "critical: new positions or adverse moves may trigger liquidations." : "high: consider reducing exposure or adding margin."}</div>`
      : "") +
    `<div class="rk-trend"><h3>Utilization trend <span class="muted">(this session)</span></h3>${spark}</div>` +
    `<p class="rk-src muted">Balance figures are exchange values; utilization = IM ÷ margin balance (derived). Free margin = the exchange's available balance.</p>`;
  rkSet("rk-margin-body", html);
}

// ---- position risk table -----------------------------------------------------

const RK_COLS = [
  { key: "symbol", label: "Symbol", num: false },
  { key: "side", label: "Side", num: false },
  { key: "value", label: "Exposure", num: true },
  { key: "share", label: "Share", num: true },
  { key: "lev", label: "Lev", num: true },
  { key: "im", label: "Margin", num: true },
  { key: "liq", label: "Liq dist", num: true },
  { key: "upl", label: "Unrealized", num: true },
  { key: "fees", label: "Fees today", num: true },
];

function rkRenderPositions() {
  const m = _rkMetrics;
  if (!m) return;
  let html;
  if (!m.count) {
    html = `<p class="muted center" style="padding:22px 12px">No open positions.</p>`;
  } else {
    const daily = rkDailyStats();
    const totalUpl = m.wallet.upl;
    const rows = m.positions.map((p) => ({
      ...p,
      fees: daily ? (daily.feesBySymbol[p.symbol] != null ? daily.feesBySymbol[p.symbol] : null) : null,
      liqKey: p.liqDist == null ? Infinity : p.liqDist,
      uplShare: totalUpl && p.upl != null && Math.abs(totalUpl) > 1e-9 ? (p.upl / totalUpl) * 100 : null,
    }));
    const key = _rkView.sort, dir = _rkView.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = key === "liq" ? a.liqKey : a[key], bv = key === "liq" ? b.liqKey : b[key];
      if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir;
      return (((av == null ? -Infinity : av) - (bv == null ? -Infinity : bv)) || 0) * dir;
    });
    const head = RK_COLS.map((c) =>
      `<th data-rksort="${c.key}" class="${c.num ? "num" : ""}${_rkView.sort === c.key ? " sorted" : ""}" role="button" tabindex="0" aria-sort="${_rkView.sort === c.key ? (_rkView.dir === "asc" ? "ascending" : "descending") : "none"}">${esc(c.label)}${_rkView.sort === c.key ? (_rkView.dir === "asc" ? " ▲" : " ▼") : ""}</th>`
    ).join("");
    const body = rows.map((p) => {
      const liqCls = rkLiqClass(p.liqDist);
      return `<tr>` +
        `<td class="mono">${esc(p.symbol)}</td>` +
        `<td><span class="${p.side === "long" ? "pos" : "neg"}">${p.side === "long" ? "Long" : "Short"}</span></td>` +
        `<td class="num mono priv">${fmtMoney(p.value)}</td>` +
        `<td class="num"><div class="rk-cellbar"><span style="width:${Math.min(100, p.share || 0).toFixed(1)}%"></span></div><span class="mono">${rkPct(p.share, 1)}</span></td>` +
        `<td class="num mono">${p.lev != null ? p.lev + "x" : "—"}</td>` +
        `<td class="num mono priv" title="${p.imIsEstimate ? "estimated: value ÷ leverage" : "exchange positionIM"}">${p.im != null ? (p.imIsEstimate ? "~" : "") + fmtMoney(p.im) : "—"}</td>` +
        `<td class="num mono rk-heat-${liqCls}">${p.liqDist != null ? p.liqDist.toFixed(1) + "%" : "—"}</td>` +
        `<td class="num mono priv ${pnlClass(p.upl)}">${p.upl != null ? fmtMoneySigned(p.upl) : "—"}` +
          `${p.uplShare != null ? `<span class="rk-sub muted">${p.uplShare.toFixed(0)}% of UPL</span>` : ""}</td>` +
        `<td class="num mono priv">${p.fees != null ? fmtMoney(p.fees, 4) : "—"}</td>` +
      `</tr>`;
    }).join("");
    html =
      `<div class="table-wrap"><table class="rk-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      `<p class="rk-src muted">Margin "~" = estimated (exposure ÷ leverage) where the exchange doesn't report per-position IM. Fees today from the history mirror (trading fees; funding shown in Daily risk).</p>`;
  }
  rkSet("rk-positions-body", html);
}

// ---- daily risk + drawdown -----------------------------------------------------

function rkRenderDaily() {
  const m = _rkMetrics;
  const daily = rkDailyStats();
  const dd = rkDrawdown();
  let best = null, worst = null;
  if (m && m.count) {
    m.positions.forEach((p) => {
      if (p.upl == null) return;
      if (!best || p.upl > best.upl) best = p;
      if (!worst || p.upl < worst.upl) worst = p;
    });
  }
  const maxGross = _rkSeries.reduce((a, s) => Math.max(a, s.gross || 0), 0);
  const fmtDur = (ms) => {
    const min = Math.floor(ms / 60000);
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
  };
  const html =
    `<h3>Today <span class="muted">(exchange history · local midnight)</span></h3>` +
    `<div class="rk-tiles">` +
      jTile("Realized PnL", daily && daily.realized != null ? fmtMoneySigned(daily.realized) : "—",
        daily && daily.realized != null ? pnlClass(daily.realized) : "flat") +
      jTile("Closes · wins", daily ? `${daily.trades} · ${daily.wins}` : "—", "flat") +
      jTile("Best close", daily && daily.best ? `${esc(daily.best.symbol)} ${fmtMoneySigned(daily.best.pnl)}` : "—", daily && daily.best ? pnlClass(daily.best.pnl) : "flat") +
      jTile("Worst close", daily && daily.worst ? `${esc(daily.worst.symbol)} ${fmtMoneySigned(daily.worst.pnl)}` : "—", daily && daily.worst ? pnlClass(daily.worst.pnl) : "flat") +
      jTile("Trading fees", daily && daily.fees != null ? fmtMoney(daily.fees, 4) : "—", "flat") +
      jTile("Funding", daily && daily.funding != null ? fmtMoneySigned(-daily.funding, 4) : "—", "flat") +
    `</div>` +
    `<h3>Open book <span class="muted">(live)</span></h3>` +
    `<div class="rk-tiles">` +
      jTile("Best position", best ? `${esc(best.symbol)} ${fmtMoneySigned(best.upl)}` : "—", best ? pnlClass(best.upl) : "flat") +
      jTile("Worst position", worst ? `${esc(worst.symbol)} ${fmtMoneySigned(worst.upl)}` : "—", worst ? pnlClass(worst.upl) : "flat") +
    `</div>` +
    `<h3>Drawdown <span class="muted">(this session)</span></h3>` +
    (dd
      ? `<div class="rk-tiles">` +
          jTile("Current drawdown", `${dd.current.toFixed(2)}%`, dd.current < -5 ? "neg" : dd.current < -2 ? "warn" : "flat") +
          jTile("Max drawdown", `${dd.max.toFixed(2)}%`, dd.max < -5 ? "neg" : "flat") +
          jTile("Recovery", dd.recovery != null ? `${dd.recovery.toFixed(0)}%` : "—", "flat") +
          jTile("Since equity peak", fmtDur(dd.sincePeakMs), "flat") +
          jTile("Session peak", fmtMoney(dd.peak), "flat") +
          jTile("Max exposure", fmtMoney(maxGross), "flat") +
        `</div>` +
        `<div class="rk-trend">${rkSparkline("equity")}</div>`
      : `<p class="muted" style="padding:8px 0 2px">Collecting session samples… (updates every ${Math.round(RK_SERIES_GAP_MS / 1000)}s)</p>`) +
    `<p class="rk-src muted">"Today" figures come from the exchange history mirror; drawdown/exposure peaks are measured over THIS browser session only.</p>`;
  rkSet("rk-daily-body", html);
}

// ---- timeline -------------------------------------------------------------------

function rkRenderTimeline() {
  const html = _rkEvents.length
    ? `<div class="rk-timeline">` + _rkEvents.slice(0, 40).map((ev) =>
        `<div class="rk-ev"><span class="dot ${esc(ev.level)}"></span>` +
        `<div class="body"><span class="msg priv">${esc(ev.msg)}</span>` +
        `<span class="t muted">${new Date(ev.t).toLocaleTimeString()} · ${rkAgo(ev.t)}</span></div></div>`
      ).join("") + `</div>`
    : `<p class="muted center" style="padding:22px 12px">No risk events this session yet — position changes, margin moves and score changes will appear here.</p>`;
  rkSet("rk-timeline-body", html);
}

// ---- history charts ---------------------------------------------------------------

const RK_HIST_LABELS = {
  score: "Risk score", util: "Margin utilization %", gross: "Gross exposure",
  lev: "Portfolio leverage", equity: "Equity",
};

function rkSparkline(metric) {
  const vals = _rkSeries.map((s) => s[metric]).filter((v) => v != null);
  if (vals.length < 2) return `<p class="muted" style="font-size:11px;padding:4px 0">Collecting samples…</p>`;
  return svgAreaChart(vals, { w: 460, h: 84 });
}

function rkRenderHistory() {
  const seg = `<div class="segment rk-histseg" role="group" aria-label="History metric">` +
    RK_HIST_METRICS.map((k) =>
      `<button type="button" class="seg-neutral${_rkView.hist === k ? " active" : ""}" data-rkhist="${k}" aria-pressed="${_rkView.hist === k}">${esc(RK_HIST_LABELS[k].split(" ")[0] === "Margin" ? "Margin" : RK_HIST_LABELS[k].split(" ")[0])}</button>`
    ).join("") + `</div>`;
  const cur = _rkSeries.length ? _rkSeries[_rkSeries.length - 1][_rkView.hist] : null;
  const span = _rkSeries.length >= 2
    ? `${rkAgo(_rkSeries[0].t).replace(" ago", "")} of samples · every ${Math.round(RK_SERIES_GAP_MS / 1000)}s`
    : "";
  const html =
    `<div class="rk-hist-head">${seg}<span class="muted">${esc(span)}</span></div>` +
    `<div class="rk-hist-chart">${rkSparkline(_rkView.hist)}</div>` +
    `<div class="rk-hist-cur muted">${esc(RK_HIST_LABELS[_rkView.hist])}: <b class="priv">${cur != null ? (typeof cur === "number" ? (_rkView.hist === "gross" || _rkView.hist === "equity" ? fmtMoney(cur) : cur.toFixed(_rkView.hist === "lev" ? 2 : 1)) : cur) : "—"}</b> · session-local series, resets on reload</div>`;
  rkSet("rk-history-body", html);
}

function rkRenderPane() {
  if (!_rkMetrics) return;
  rkRenderHead();
  rkRenderExposure();
  rkRenderConcentration();
  rkRenderLiq();
  rkRenderMargin();
  rkRenderPositions();
  rkRenderDaily();
  rkRenderTimeline();
  rkRenderHistory();
  const upd = document.getElementById("rk-updated");
  if (upd) upd.textContent = "updated " + new Date().toLocaleTimeString();
}

// ===========================================================================
// Workspace integration + wiring
// ===========================================================================

function rkCaptureViewState() { return rkSanitizeViewState(_rkView); }
function rkApplyViewState(raw) {
  _rkView = rkSanitizeViewState(raw);
  // Repaint with the restored view the next time the pane is visible.
  Object.keys(_rkPaneCache).forEach((k) => delete _rkPaneCache[k]);
  if (rkPaneVisible()) rkRenderPane();
}

function rkPersistAlertPrefs() {
  try { localStorage.setItem(RK_ALERTS_KEY, JSON.stringify({ armed: _rkArmed })); } catch (e) { /* quota */ }
}

function rkPaintArmed() {
  const btn = document.getElementById("rk-alerts-toggle");
  if (!btn) return;
  btn.classList.toggle("active", _rkArmed);
  btn.setAttribute("aria-pressed", String(_rkArmed));
  btn.textContent = _rkArmed ? "🔔 Alerts armed" : "🔕 Alerts off";
  btn.title = _rkArmed
    ? "Risk alerts fire as notifications (never a trading action). Click to disarm."
    : "Risk alerts are off. Click to arm.";
}

function onRiskActive() {
  // Fresh daily context on entry, then once a minute while the pane is open.
  if (!_rkDaily || Date.now() - _rkDaily.at > 55_000) rkFetchDaily();
  clearInterval(_rkDailyTimer);
  _rkDailyTimer = setInterval(() => {
    if (!rkPaneVisible()) { clearInterval(_rkDailyTimer); return; }
    rkFetchDaily();
  }, 60_000);
  rkRenderPane();
}

function wireRisk() {
  if (_rkWired) return;
  _rkWired = true;
  try {
    const saved = JSON.parse(localStorage.getItem(RK_ALERTS_KEY) || "{}");
    if (typeof saved.armed === "boolean") _rkArmed = saved.armed;
  } catch (e) { /* defaults */ }
  rkPaintArmed();

  const toggle = document.getElementById("rk-alerts-toggle");
  if (toggle) toggle.addEventListener("click", () => {
    _rkArmed = !_rkArmed;
    rkPaintArmed();
    rkPersistAlertPrefs();
    toast(`Risk alerts ${_rkArmed ? "armed" : "disarmed"} (notify-only — alerts never trade)`, "info", 2600);
  });

  const pane = document.querySelector('[data-pane="risk"]');
  if (pane) {
    // One delegated click handler: allocation view, history metric, table sort.
    pane.addEventListener("click", (e) => {
      const alloc = e.target.closest("[data-rkalloc]");
      if (alloc) {
        _rkView.alloc = alloc.dataset.rkalloc;
        delete _rkPaneCache["rk-exposure-body"];
        rkRenderExposure();
        if (typeof wsAutoSave === "function") wsAutoSave();
        return;
      }
      const hist = e.target.closest("[data-rkhist]");
      if (hist) {
        _rkView.hist = hist.dataset.rkhist;
        delete _rkPaneCache["rk-history-body"];
        rkRenderHistory();
        if (typeof wsAutoSave === "function") wsAutoSave();
        return;
      }
      const th = e.target.closest("[data-rksort]");
      if (th) {
        const key = th.dataset.rksort;
        if (_rkView.sort === key) _rkView.dir = _rkView.dir === "asc" ? "desc" : "asc";
        else { _rkView.sort = key; _rkView.dir = key === "symbol" ? "asc" : "desc"; }
        delete _rkPaneCache["rk-positions-body"];
        rkRenderPositions();
        if (typeof wsAutoSave === "function") wsAutoSave();
      }
    });
    // Keyboard sort parity for the table headers (role=button tabindex=0).
    pane.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest && e.target.closest("[data-rksort]");
      if (th) { e.preventDefault(); th.click(); }
    });
  }

  // "Full dashboard →" link on the compact Trade-tab panel.
  const open = document.getElementById("rk-open");
  if (open) open.addEventListener("click", () => {
    const tab = document.querySelector('#tabs .tab[data-tab="risk"]');
    if (tab) tab.click();
  });
}
