// ===========================================================================
// MULTI-CHART WORKSPACE — the "Live Charts" panel as a professional
// multi-market chart grid (TradingView-style layouts, per-chart symbol /
// interval / zoom, opt-in linking, drag-to-swap, per-chart fullscreen).
//
// ARCHITECTURE
// ------------
// • Loaded BEFORE app.js: this file only DEFINES consts + functions at the
//   top level — nothing here touches the DOM or network until app.js's boot
//   calls wireCharts(). Shared helpers (esc, fmtNum, api, toast, wsAutoSave,
//   loadSymbolIntoTicket, listOf, _tickerIndex …) are resolved at call time.
// • Pure, DOM-free core first (MC_* one-line consts + mcSanitizeCharts and
//   friends, extractable by tests/test_snap.mjs), then the shared data layer,
//   then the DOM manager.
// • DATA IS SHARED, RENDERING IS INDEPENDENT: candles live in ONE store keyed
//   by "SYMBOL|INTERVAL". Nine charts on the same pair cost one request per
//   poll tick; the backend kline cache coalesces across tabs on top of that.
//   Each chart renders only its own window and only when its data changed.
// • DISPLAY-ONLY BY CONSTRUCTION: nothing in this file can reach a write
//   endpoint. The only trading-adjacent affordance is the ticket button,
//   which routes through the existing data-trade → loadSymbolIntoTicket
//   prefill path (form state only; nothing is ever submitted from here).
// ===========================================================================

// ---------------------------------------------------------------------------
// Pure core: layout / interval / slot vocabulary + the state sanitizer.
// One-line consts so tests/test_snap.mjs can extract them by source.
// ---------------------------------------------------------------------------
const MC_LAYOUT_IDS = ["1", "2h", "2v", "3", "4", "6", "8", "9"];
const MC_LAYOUT_SLOTS = { "1": 1, "2h": 2, "2v": 2, "3": 3, "4": 4, "6": 6, "8": 8, "9": 9 };
const MC_LAYOUT_GRID = { "1": [1, 1], "2h": [2, 1], "2v": [1, 2], "3": [2, 2], "4": [2, 2], "6": [3, 2], "8": [4, 2], "9": [3, 3] };
const MC_INTERVAL_CODES = ["1", "3", "5", "15", "30", "60", "240", "D"];
const MC_SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const MC_MIN_SPAN = 20;
const MC_MAX_SPAN = 400;
const MC_DEFAULT_SPAN = 140;
const MC_LINK_KINDS = ["symbol", "interval", "crosshair", "zoom"];
const MC_DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT"];

// Non-extracted vocabulary (multi-line is fine below this point).
const MC_IV_LABELS = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m",
  "30": "30m", "60": "1H", "240": "4H", "D": "1D",
};
// Poll cadence per candle interval — matching the request rate to how fast
// the candle can actually change keeps load on the region-fragile public
// kline proxy proportional to what is on screen (same principle as v1).
const MC_POLL_MS = {
  "1": 2000, "3": 3000, "5": 3000, "15": 5000,
  "30": 8000, "60": 10000, "240": 15000, "D": 20000,
};
const MC_LAYOUT_TITLES = {
  "1": "Single chart", "2h": "2 charts · side by side", "2v": "2 charts · stacked",
  "3": "3 charts · focus + 2", "4": "4 charts · 2×2", "6": "6 charts · 3×2",
  "8": "8 charts · 4×2", "9": "9 charts · 3×3",
};
// Slot-index spans per layout ("3" = one full-height focus chart + 2 stacked).
const MC_LAYOUT_DEFS = { "3": { spans: { 0: { r: 2 } } } };
const MC_FETCH_LIMIT = 400;     // candles fetched per pair (pan/zoom headroom)
const MC_STORE_TTL_MS = 5 * 60_000; // evict pairs no chart has used for 5 min
const MC_RECENTS_KEY = "dma.chart.recents.v1";
const MC_RECENTS_MAX = 12;

function mcIvLabel(code) { return MC_IV_LABELS[code] || code; }

function mcSlotId() {
  return "c" + Math.random().toString(36).slice(2, 9);
}

// Build one valid slot. `symbol`/`interval` are trusted here — callers go
// through mcSanitizeCharts / the picker (both sanitize) before reaching this.
function mcNewSlot(symbol, interval, span) {
  return {
    id: mcSlotId(),
    symbol: symbol || "BTCUSDT",
    interval: interval || "15",
    span: span || MC_DEFAULT_SPAN,
    linked: true,
  };
}

// Coerce ANY value into a valid multi-chart state (unknown fields dropped,
// invalid values replaced by defaults). Single trust boundary for storage and
// workspace imports — everything rendered later is from these allowlists or
// additionally escaped at render time. `legacy` accepts the pre-multi-chart
// workspace shape ({view:"grid"|"single", interval, single}) so existing
// saved workspaces migrate losslessly.
function mcSanitizeCharts(raw, legacy) {
  const src = raw && typeof raw === "object" ? raw : null;
  const leg = legacy && typeof legacy === "object" ? legacy : null;
  const symOf = (v, dflt) => {
    const s = String(v == null ? "" : v).trim().toUpperCase();
    return MC_SYMBOL_RE.test(s) ? s : dflt;
  };
  const ivOf = (v, dflt) => (MC_INTERVAL_CODES.includes(String(v)) ? String(v) : dflt);
  const spanOf = (v) => {
    const n = Math.round(Number(v));
    return isFinite(n) ? Math.max(MC_MIN_SPAN, Math.min(MC_MAX_SPAN, n)) : MC_DEFAULT_SPAN;
  };
  const out = {
    layout: "3",
    slots: [],
    links: { symbol: false, interval: false, crosshair: true, zoom: false },
    focus: 0,
    fs: "",
    panelFull: false,
    tracks: {},
  };
  if (src) {
    out.layout = MC_LAYOUT_IDS.includes(src.layout) ? src.layout : "3";
    const cap = MC_LAYOUT_SLOTS[out.layout];
    const seen = {};
    (Array.isArray(src.slots) ? src.slots.slice(0, cap) : []).forEach((s, k) => {
      const o = s && typeof s === "object" ? s : {};
      let id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(o.id) ? o.id : mcSlotId();
      if (seen[id]) id = mcSlotId();
      seen[id] = 1;
      out.slots.push({
        id,
        symbol: symOf(o.symbol, MC_DEFAULT_SYMBOLS[k % MC_DEFAULT_SYMBOLS.length]),
        interval: ivOf(o.interval, "15"),
        span: spanOf(o.span),
        linked: o.linked !== false,
      });
    });
    if (src.links && typeof src.links === "object") {
      MC_LINK_KINDS.forEach((k) => { if (k in src.links) out.links[k] = !!src.links[k]; });
    }
    out.panelFull = !!src.panelFull;
    if (typeof src.fs === "string" && out.slots.some((s) => s.id === src.fs)) out.fs = src.fs;
    const f = Math.floor(Number(src.focus));
    if (isFinite(f) && f >= 0 && f < out.slots.length) out.focus = f;
    if (src.tracks && typeof src.tracks === "object") {
      MC_LAYOUT_IDS.forEach((lid) => {
        const t = src.tracks[lid];
        if (!t || typeof t !== "object") return;
        const dims = MC_LAYOUT_GRID[lid];
        const frs = (arr, n) => {
          if (!Array.isArray(arr) || arr.length !== n) return null;
          const v = arr.map((x) => Number(x));
          return v.every((x) => isFinite(x) && x >= 0.3 && x <= 4) ? v : null;
        };
        const c = frs(t.c, dims[0]);
        const r = frs(t.r, dims[1]);
        if (c || r) out.tracks[lid] = { c: c || new Array(dims[0]).fill(1), r: r || new Array(dims[1]).fill(1) };
      });
    }
  } else if (leg) {
    // v2 workspace migration: the old single/grid chart panel becomes an
    // equivalent multi-chart layout — nothing a user saved is lost.
    const interval = ivOf(leg.interval, "15");
    if (leg.view === "single") {
      out.layout = "1";
      out.slots = [mcNewSlot(symOf(leg.single, "BTCUSDT"), interval)];
    } else {
      out.layout = "3";
      out.slots = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((s) => mcNewSlot(s, interval));
    }
  }
  if (!out.slots.length) {
    const n = Math.min(3, MC_LAYOUT_SLOTS[out.layout]);
    for (let k = 0; k < n; k++) out.slots.push(mcNewSlot(MC_DEFAULT_SYMBOLS[k], "15"));
  }
  if (out.focus >= out.slots.length) out.focus = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Candle parsing + shared plot geometry (unchanged from the v1 chart panel —
// the rendering contract, XSS posture and dirty-check are preserved).
// ---------------------------------------------------------------------------

// Compact HH:MM for the candle time axis (a candle's `t` is epoch-ms).
function fmtClock(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// Date-aware label for slow intervals (a 4H/1D axis of HH:MM is meaningless).
function fmtClockFor(ms, interval) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (interval === "D") return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (interval === "240") return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}h`;
  return fmtClock(n);
}

// Parse a Bybit kline payload into ascending {t,o,h,l,c,v} numbers. Bybit
// returns result.list as [start, open, high, low, close, volume, turnover]
// strings, NEWEST first — iterate in reverse to get chronological order.
function parseKline(data) {
  const list = (data && data.result && data.result.list) || [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = list[i];
    if (!Array.isArray(k) || k.length < 5) continue;
    const t = Number(k[0]);
    const o = Number(k[1]), h = Number(k[2]), l = Number(k[3]), c = Number(k[4]), v = Number(k[5]);
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    out.push({ t: isFinite(t) ? t : 0, o, h, l, c, v: isFinite(v) ? v : 0 });
  }
  return out;
}

// Horizontal plot geometry shared by renderCandles AND the crosshair
// hit-testing — one source so hover→candle mapping can never drift from
// what is actually drawn.
const CC_GEOM = { W: 600, L: 6, R: 6 };

// Price decimal places for an arbitrary symbol: prefer the instrument's real
// tick size when the ticket has already fetched it; otherwise a magnitude
// heuristic that matches the old hand-tuned values (BTC→1, ETH→2, SOL→2).
function mcDp(symbol, px) {
  try {
    const spec = typeof state === "object" && state && state.specs ? state.specs[symbol] : null;
    if (spec && spec.tickSize) {
      const d = decimalsOf(spec.tickSize);
      if (d != null) return Math.min(8, d);
    }
  } catch (e) { /* specs are a bonus, never a dependency */ }
  const p = Math.abs(Number(px));
  if (!isFinite(p) || p === 0) return 2;
  if (p >= 10000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  if (p >= 0.01) return 5;
  return 7;
}

// Hand-drawn candlestick SVG + right-hand price scale. Inputs are coerced
// NUMBERS only — no exchange string ever reaches innerHTML here, so this is
// XSS-safe by construction (the price-scale labels go through fmtNum).
// Returns the vertical geometry so the caller's crosshair can map y→price.
// opts.key participates in the dirty-check signature (pan/zoom/symbol moves
// repaint even when the window LENGTH and last candle happen to match);
// opts.lastLine suppresses the dashed last-price line while panning history.
function renderCandles(svg, axisEl, timeEl, candles, dp, opts = {}) {
  if (!svg) return null;
  if (!candles || !candles.length) {
    svg.innerHTML = "";
    if (axisEl) axisEl.innerHTML = "";
    if (timeEl) timeEl.innerHTML = "";
    svg.dataset.sig = ""; // reset so a later non-empty set always repaints
    return null;
  }
  // Dirty-check: at a poll cadence of seconds the candles are usually
  // identical between ticks. Tearing down + reparsing the whole SVG subtree
  // each time is the hottest cost in the app; skip it when nothing changed.
  const lastC = candles[candles.length - 1];
  const sig = `${opts.key || ""}|${dp}|${candles.length}|${lastC.t}|${lastC.o}|${lastC.h}|${lastC.l}|${lastC.c}|${opts.lastLine === false ? 0 : 1}`;
  const H = 210, T = 10, B = 6, volH = 34, gap = 8;
  const priceBottom = H - B - volH - gap;
  let min = Infinity, max = -Infinity, maxV = 0;
  candles.forEach((c) => {
    if (c.l < min) min = c.l;
    if (c.h > max) max = c.h;
    if (c.v > maxV) maxV = c.v;
  });
  // 8% vertical headroom so wicks aren't flush to the edges; fall back to a
  // tiny band for a (near-)flat series, then to 1 so the span is never 0.
  const padR = (max - min) * 0.08 || Math.abs(max) * 0.001 || 1;
  min -= padR; max += padR;
  const span = (max - min) || 1;
  const geom = { min, max, span, T, priceBottom, H };
  if (svg.dataset.sig === sig) return geom;
  svg.dataset.sig = sig;
  const { W, L, R } = CC_GEOM;
  if (!(maxV > 0)) maxV = 1;
  // body = 62% of each candle's horizontal slot (leaves the inter-candle gap); ≥1.4px.
  const n = candles.length, plotW = W - L - R, step = plotW / n, bodyW = Math.max(1.4, step * 0.62);
  const y = (p) => T + (priceBottom - T) * (1 - (p - min) / span);
  const parts = [];
  for (let g = 1; g <= 3; g++) {
    const gy = (T + (priceBottom - T) * g / 4).toFixed(1);
    parts.push(`<line class="cs-grid" x1="0" y1="${gy}" x2="${W}" y2="${gy}"/>`);
  }
  candles.forEach((cd, i) => {
    const xc = L + (i + 0.5) * step;
    const cls = cd.c >= cd.o ? "cs-up" : "cs-down";
    parts.push(`<line class="${cls}" x1="${xc.toFixed(1)}" y1="${y(cd.h).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${y(cd.l).toFixed(1)}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    const yo = y(cd.o), yc = y(cd.c), top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yo - yc));
    parts.push(`<rect class="${cls}" x="${(xc - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${hgt.toFixed(1)}"/>`);
    const bh = (cd.v / maxV) * volH;
    parts.push(`<rect class="${cls}" x="${(xc - bodyW / 2).toFixed(1)}" y="${(H - B - bh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill-opacity="0.28"/>`);
  });
  const last = candles[candles.length - 1];
  if (opts.lastLine !== false) {
    const lastCls = last.c >= last.o ? "cs-up" : "cs-down";
    parts.push(`<line class="${lastCls}" x1="0" y1="${y(last.c).toFixed(1)}" x2="${W}" y2="${y(last.c).toFixed(1)}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55" vector-effect="non-scaling-stroke"/>`);
  }
  svg.innerHTML = parts.join("");
  if (axisEl) {
    const a = [];
    const levels = 5;
    for (let k = 0; k < levels; k++) {
      const f = k / (levels - 1);
      const price = max - f * span;
      const topPct = ((T + f * (priceBottom - T)) / H * 100).toFixed(2);
      a.push(`<span class="cc-ax-lbl" style="top:${topPct}%">${fmtNum(price, dp)}</span>`);
    }
    if (opts.lastLine !== false) {
      const fLast = (max - last.c) / span;
      const ltop = ((T + fLast * (priceBottom - T)) / H * 100).toFixed(2);
      a.push(`<span class="cc-ax-last ${last.c >= last.o ? "pos" : "neg"}" style="top:${ltop}%">${fmtNum(last.c, dp)}</span>`);
    }
    axisEl.innerHTML = a.join("");
  }
  if (timeEl) {
    // Time axis: a few labels under the plot, HTML (not SVG text) so they stay
    // crisp under the stretched viewBox. First/last pinned to the row edges.
    const t = [], seen = {};
    [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].forEach((i) => {
      if (i < 0 || i >= n || seen[i]) return;
      seen[i] = 1;
      let style;
      if (i === 0) style = "left:0";
      else if (i === n - 1) style = "right:0";
      else style = `left:${(((L + (i + 0.5) * step) / W) * 100).toFixed(1)}%;transform:translateX(-50%)`;
      t.push(`<span class="cc-t" style="${style}">${fmtClockFor(candles[i].t, opts.interval)}</span>`);
    });
    timeEl.innerHTML = t.join("");
  }
  return geom;
}

// ===========================================================================
// Shared kline data layer — ONE store for every chart, keyed "SYMBOL|IV".
// ===========================================================================

const mcStore = {}; // key -> { candles, at, fails, inflight, used }
let _mcTimer = null;

function mcPairKey(slot) { return `${slot.symbol}|${slot.interval}`; }

async function mcFetchPair(key) {
  const ent = mcStore[key] || (mcStore[key] = { candles: null, at: 0, fails: 0, inflight: false, used: Date.now() });
  if (ent.inflight) return; // single-flight per pair; the 1s tick retries
  const sep = key.indexOf("|");
  const symbol = key.slice(0, sep), interval = key.slice(sep + 1);
  ent.inflight = true;
  try {
    const data = await api(
      `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${MC_FETCH_LIMIT}`
    );
    ent.candles = parseKline(data);
    ent.at = Date.now();
    ent.fails = 0;
  } catch (e) {
    // Keep the previous candles on a transient error — never blank a chart —
    // but count the failure so a never-loaded card can say WHY it is empty.
    ent.fails += 1;
    ent.at = Date.now(); // failures respect the poll cadence too (no hot loop)
  } finally {
    ent.inflight = false;
  }
  mcState.slots.forEach((s, i) => { if (mcPairKey(s) === key) mcRenderSlot(i); });
}

// One scheduler tick: fetch every stale pair the CURRENT slots need, evict
// pairs nothing has used for a while. Runs at 1s; the per-interval cadence
// (MC_POLL_MS) decides whether a pair is actually stale.
function mcTick() {
  const now = Date.now();
  const needed = {};
  mcState.slots.forEach((s) => { needed[mcPairKey(s)] = true; });
  Object.keys(needed).forEach((key) => {
    const iv = key.slice(key.indexOf("|") + 1);
    const ent = mcStore[key];
    if (ent) ent.used = now;
    if (!ent || (now - ent.at) >= (MC_POLL_MS[iv] || 5000)) mcFetchPair(key);
  });
  Object.keys(mcStore).forEach((key) => {
    if (!needed[key] && (now - mcStore[key].used) > MC_STORE_TTL_MS) delete mcStore[key];
  });
}

function chartsVisible() {
  const pane = document.querySelector('[data-pane="dashboard"]');
  const panel = document.getElementById("charts-panel");
  const collapsed = panel && panel.classList.contains("collapsed");
  return !!pane && !pane.hidden && !document.hidden && !collapsed;
}

// Kept names (startChartPolling/stopChartPolling): the tab switcher, the
// panel-collapse control and the visibility handler in app.js call these.
function startChartPolling() {
  stopChartPolling();
  if (!chartsVisible()) return;
  mcState.slots.forEach((s, i) => mcRenderSlot(i)); // paint from cache instantly
  mcTick();
  _mcTimer = setInterval(() => {
    if (!chartsVisible()) { stopChartPolling(); return; }
    mcTick();
  }, 1000);
}
function stopChartPolling() {
  if (_mcTimer) { clearInterval(_mcTimer); _mcTimer = null; }
}

// ===========================================================================
// DOM manager
// ===========================================================================

// The live multi-chart state (a sanitized document; workspaces persist it).
let mcState = mcSanitizeCharts(null);
// Per-slot runtime (never persisted): pan offset, last rendered window+geom.
let _mcRt = [];
let _mcNarrowCols = 0;     // >0 when the responsive reflow overrides the layout
let _mcWired = false;
let _mcUniverse = null;    // [{symbol,last,pct}] for the picker (lazy, cached)
let _mcUniverseAt = 0;
let _mcPicker = null;      // { el, idx, rows, sel } while the symbol picker is open
let _mcIvMenu = null;      // { el, idx } while the interval menu is open
let _mcDragIdx = -1;       // toolbar-grip drag in progress

function mcEl() { return document.getElementById("mc-grid"); }
function mcPanel() { return document.getElementById("charts-panel"); }
function mcRtOf(i) { return _mcRt[i] || (_mcRt[i] = { off: 0, vis: null, geom: null, dp: 2 }); }

function mcAutoSave() {
  if (typeof wsAutoSave === "function") wsAutoSave();
}

// ---- workspace integration -------------------------------------------------

function mcCaptureState() {
  return mcSanitizeCharts(mcState);
}

function mcApplyState(raw) {
  mcState = mcSanitizeCharts(raw);
  _mcRt = [];
  mcCloseDropdowns();
  mcRenderControls();
  mcRenderGrid();
  mcApplyFullscreen();
  startChartPolling();
}

// ---- layout geometry -------------------------------------------------------

// Cell placement per slot INDEX for a layout (occupancy fill, honoring spans).
function mcPlaceIndices(layoutId) {
  const dims = MC_LAYOUT_GRID[layoutId] || [2, 2];
  const cols = dims[0], rows = dims[1];
  const spans = (MC_LAYOUT_DEFS[layoutId] || {}).spans || {};
  const occ = [];
  for (let r = 0; r < rows; r++) occ.push(new Array(cols).fill(false));
  const out = [];
  const cap = MC_LAYOUT_SLOTS[layoutId] || 4;
  for (let i = 0; i < cap; i++) {
    const sp = spans[i] || {};
    const cs = Math.min(cols, sp.c || 1), rs = Math.min(rows, sp.r || 1);
    let placed = false;
    for (let r = 0; r < rows && !placed; r++) {
      for (let c = 0; c < cols && !placed; c++) {
        let ok = c + cs <= cols && r + rs <= rows;
        for (let rr = r; ok && rr < r + rs; rr++) {
          for (let cc = c; ok && cc < c + cs; cc++) if (occ[rr][cc]) ok = false;
        }
        if (!ok) continue;
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) occ[rr][cc] = true;
        out.push({ c, r, cs, rs });
        placed = true;
      }
    }
    if (!placed) out.push({ c: 0, r: 0, cs: 1, rs: 1 });
  }
  return out;
}

function mcTracksFor(layoutId) {
  const dims = MC_LAYOUT_GRID[layoutId];
  const t = mcState.tracks[layoutId];
  return {
    c: (t && t.c) || new Array(dims[0]).fill(1),
    r: (t && t.r) || new Array(dims[1]).fill(1),
  };
}

// Apply the grid template (or the responsive narrow reflow) + dividers.
function mcApplyGridTemplate() {
  const grid = mcEl();
  if (!grid) return;
  const dims = MC_LAYOUT_GRID[mcState.layout];
  const cols = dims[0], rows = dims[1];
  const width = grid.clientWidth || 1200;
  const eff = Math.max(1, Math.min(cols, Math.floor(width / 300) || 1));
  const cards = Array.from(grid.querySelectorAll(":scope > .mc-card"));
  if (eff < cols) {
    // Narrow reflow: honest stacked grid instead of unreadable slivers.
    _mcNarrowCols = eff;
    grid.style.gridTemplateColumns = `repeat(${eff}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = "";
    grid.style.gridAutoRows = "clamp(220px, 32vh, 330px)";
    grid.style.height = "";
    cards.forEach((el) => { el.style.gridArea = "auto"; });
  } else {
    _mcNarrowCols = 0;
    const tr = mcTracksFor(mcState.layout);
    grid.style.gridTemplateColumns = tr.c.map((f) => `${f}fr`).join(" ");
    grid.style.gridTemplateRows = tr.r.map((f) => `${f}fr`).join(" ");
    grid.style.gridAutoRows = "";
    grid.style.height = mcState.panelFull
      ? "" // the fullscreen panel flexes the grid via CSS
      : rows === 1 ? "clamp(280px, 46vh, 560px)"
        : rows === 2 ? "clamp(460px, 62vh, 780px)"
          : "clamp(560px, 74vh, 920px)";
    const places = mcPlaceIndices(mcState.layout);
    cards.forEach((el) => {
      const p = places[Number(el.dataset.idx)];
      if (p) el.style.gridArea = `${p.r + 1} / ${p.c + 1} / span ${p.rs} / span ${p.cs}`;
    });
  }
  mcBuildDividers();
}

// ---- resizable tracks (drag the seams between charts) ----------------------

function mcBuildDividers() {
  const grid = mcEl();
  if (!grid) return;
  grid.querySelectorAll(":scope > .mc-div").forEach((el) => el.remove());
  if (_mcNarrowCols) return; // no fine-grained resizing in the stacked reflow
  const dims = MC_LAYOUT_GRID[mcState.layout];
  const tr = mcTracksFor(mcState.layout);
  const place = (kind, k, frs) => {
    const el = document.createElement("div");
    el.className = `mc-div mc-div-${kind}`;
    el.dataset.kind = kind;
    el.dataset.k = String(k);
    el.title = "Drag to resize · double-click to reset";
    const total = frs.reduce((a, b) => a + b, 0) || 1;
    const pct = (frs.slice(0, k + 1).reduce((a, b) => a + b, 0) / total) * 100;
    if (kind === "c") el.style.left = `calc(${pct.toFixed(3)}% - 4px)`;
    else el.style.top = `calc(${pct.toFixed(3)}% - 4px)`;
    grid.appendChild(el);
  };
  for (let k = 0; k < dims[0] - 1; k++) place("c", k, tr.c);
  for (let k = 0; k < dims[1] - 1; k++) place("r", k, tr.r);
}

function mcWireDividerDrag(grid) {
  let drag = null;
  grid.addEventListener("pointerdown", (e) => {
    const div = e.target.closest(".mc-div");
    if (!div) return;
    e.preventDefault();
    const kind = div.dataset.kind, k = Number(div.dataset.k);
    const tr = mcTracksFor(mcState.layout);
    const frs = (kind === "c" ? tr.c : tr.r).slice();
    const rect = grid.getBoundingClientRect();
    drag = { kind, k, start: kind === "c" ? e.clientX : e.clientY, frs, size: kind === "c" ? rect.width : rect.height };
    div.setPointerCapture(e.pointerId);
    grid.classList.add("mc-resizing");
  });
  grid.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const delta = ((drag.kind === "c" ? e.clientX : e.clientY) - drag.start) / drag.size
      * drag.frs.reduce((a, b) => a + b, 0);
    const frs = drag.frs.slice();
    const a = frs[drag.k] + delta, b = frs[drag.k + 1] - delta;
    if (a < 0.3 || b < 0.3 || a > 4 || b > 4) return;
    frs[drag.k] = a; frs[drag.k + 1] = b;
    const tr = mcTracksFor(mcState.layout);
    mcState.tracks[mcState.layout] = drag.kind === "c" ? { c: frs, r: tr.r } : { c: tr.c, r: frs };
    mcApplyGridTemplate();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    grid.classList.remove("mc-resizing");
    mcAutoSave();
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
  grid.addEventListener("dblclick", (e) => {
    const div = e.target.closest(".mc-div");
    if (!div) return;
    delete mcState.tracks[mcState.layout];
    mcApplyGridTemplate();
    mcAutoSave();
  });
}

// ---- FLIP animation (layout switches, swaps, reorders) ----------------------

function mcFlip(mutate) {
  const grid = mcEl();
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!grid || reduced) { mutate(); return; }
  const before = {};
  grid.querySelectorAll(":scope > .mc-card[data-cid]").forEach((el) => {
    before[el.dataset.cid] = el.getBoundingClientRect();
  });
  mutate();
  grid.querySelectorAll(":scope > .mc-card[data-cid]").forEach((el) => {
    const b = before[el.dataset.cid];
    if (!b) { el.classList.add("mc-enter"); return; }
    const a = el.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const dx = b.left - a.left, dy = b.top - a.top;
    const sx = b.width / a.width, sy = b.height / a.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    el.style.transition = "none";
    el.style.transformOrigin = "top left";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void el.offsetWidth; // commit the inverted position before playing
    el.style.transition = "transform 260ms cubic-bezier(0.16, 1, 0.3, 1)";
    el.style.transform = "";
    el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
  });
}

// ---- card DOM ---------------------------------------------------------------

const MC_ICONS = {
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2-9.4L23 10"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  dup: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trade: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  fs: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

// Static card shell (rebuilt on structural changes; per-tick updates patch
// text nodes only). All dynamic strings are sanitized symbols/labels, still
// escaped at render time.
function mcCardHTML(i, slot) {
  const closable = mcState.slots.length > 1;
  return (
    `<div class="mc-bar">` +
      `<button type="button" class="mc-tbtn mc-drag" draggable="true" title="Drag to swap charts" aria-label="Move chart ${i + 1}">⠿</button>` +
      `<button type="button" class="mc-symbtn mono" data-mc="sym" title="Change symbol" aria-haspopup="listbox">${esc(slot.symbol)}<span class="mc-caret" aria-hidden="true">▾</span></button>` +
      `<button type="button" class="mc-tbtn mc-ivbtn mono" data-mc="iv" title="Change interval" aria-haspopup="menu">${esc(mcIvLabel(slot.interval))}</button>` +
      `<span class="mc-px mono" data-mc="px">—</span>` +
      `<span class="mc-chg mono flat" data-mc="chg"></span>` +
      `<span class="mc-flex"></span>` +
      `<button type="button" class="mc-tbtn mc-link${slot.linked ? " on" : ""}" data-mc="link" title="Link chart" aria-label="Include this chart in linking (symbol / interval / crosshair / zoom sync)" aria-pressed="${slot.linked}">${MC_ICONS.link}</button>` +
      `<span class="mc-more">` +
        `<button type="button" class="mc-tbtn" data-mc="refresh" title="Refresh data" aria-label="Refresh chart">${MC_ICONS.refresh}</button>` +
        `<button type="button" class="mc-tbtn" data-mc="shot" title="Save chart as PNG" aria-label="Save chart image">${MC_ICONS.camera}</button>` +
        `<button type="button" class="mc-tbtn" data-mc="dup" title="Duplicate chart" aria-label="Duplicate chart">${MC_ICONS.dup}</button>` +
        `<button type="button" class="mc-tbtn" data-trade="${esc(slot.symbol)}" title="Load ${esc(slot.symbol)} into the order ticket" aria-label="Load ${esc(slot.symbol)} into the order ticket">${MC_ICONS.trade}</button>` +
      `</span>` +
      `<button type="button" class="mc-tbtn" data-mc="fs" title="Fullscreen (F · Esc exits)" aria-label="Fullscreen chart">${MC_ICONS.fs}</button>` +
      (closable ? `<button type="button" class="mc-tbtn mc-closebtn" data-mc="close" title="Close chart" aria-label="Close chart">${MC_ICONS.close}</button>` : "") +
    `</div>` +
    `<div class="mc-body">` +
      `<div class="cc-chart mc-plot">` +
        `<svg class="cs" viewBox="0 0 600 210" preserveAspectRatio="none" role="img" aria-label="${esc(slot.symbol)} candlesticks"></svg>` +
        `<div class="cc-axis"></div>` +
        `<div class="cc-cross" hidden></div>` +
        `<div class="mc-yline" hidden></div>` +
        `<span class="mc-ytag mono" hidden></span>` +
        `<button type="button" class="mc-livebtn mono" data-mc="live" hidden title="Jump back to the latest candle">LIVE ⇥</button>` +
        `<div class="mc-skel" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>` +
        `<div class="mc-err" hidden><p class="mc-err-msg"></p><button type="button" class="btn-ghost sm" data-mc="retry">Retry</button></div>` +
      `</div>` +
      `<div class="cc-times"></div>` +
      `<div class="cc-foot"><span data-mc="foot">—</span><span class="muted" data-mc="meta"></span></div>` +
    `</div>`
  );
}

function mcCardEl(i) {
  const grid = mcEl();
  return grid ? grid.querySelector(`:scope > .mc-card[data-idx="${i}"]`) : null;
}

// Rebuild every card (structural change: layout / add / close / swap / apply).
function mcRenderGrid() {
  const grid = mcEl();
  if (!grid) return;
  mcCloseDropdowns();
  const cap = MC_LAYOUT_SLOTS[mcState.layout];
  const parts = [];
  mcState.slots.forEach((slot, i) => {
    parts.push(
      `<div class="mc-card${i === mcState.focus ? " focused" : ""}" data-idx="${i}" data-cid="${esc(slot.id)}" tabindex="0" role="group" aria-label="Chart ${i + 1}: ${esc(slot.symbol)} ${esc(mcIvLabel(slot.interval))}">${mcCardHTML(i, slot)}</div>`
    );
  });
  for (let i = mcState.slots.length; i < cap; i++) {
    parts.push(
      `<div class="mc-card mc-emptycell" data-empty="${i}">` +
        `<button type="button" class="mc-addbtn" data-mc="fill" title="Add a chart here"><span aria-hidden="true">＋</span> Add chart</button>` +
      `</div>`
    );
  }
  grid.innerHTML = parts.join("");
  mcApplyGridTemplate();
  _mcRt = _mcRt.slice(0, mcState.slots.length);
  mcState.slots.forEach((s, i) => mcRenderSlot(i));
}

// Patch one chart card from the shared store (data change, pan/zoom, retry).
function mcRenderSlot(i) {
  const slot = mcState.slots[i];
  const card = mcCardEl(i);
  if (!slot || !card) return;
  const rt = mcRtOf(i);
  const ent = mcStore[mcPairKey(slot)];
  const candles = ent && ent.candles;
  const skel = card.querySelector(".mc-skel");
  const err = card.querySelector(".mc-err");
  const has = !!(candles && candles.length);
  if (skel) skel.hidden = has || (ent && ent.fails >= 2);
  if (err) {
    const showErr = !has && ent && ent.fails >= 2;
    err.hidden = !showErr;
    if (showErr) {
      err.querySelector(".mc-err-msg").textContent =
        `${slot.symbol} ${mcIvLabel(slot.interval)} — data unavailable (kline source unreachable or symbol not served)`;
    }
  }
  const svg = card.querySelector("svg.cs");
  const axis = card.querySelector(".cc-axis");
  const times = card.querySelector(".cc-times");
  if (!has) {
    rt.vis = null; rt.geom = null;
    if (svg) renderCandles(svg, axis, times, null, 2);
    mcUpdateSlotHeader(i);
    return;
  }
  const n = candles.length;
  const span = Math.min(slot.span, n);
  rt.off = Math.max(0, Math.min(rt.off, n - span));
  const vis = candles.slice(n - span - rt.off, n - rt.off);
  rt.vis = vis;
  rt.dp = mcDp(slot.symbol, candles[n - 1].c);
  rt.geom = renderCandles(svg, axis, times, vis, rt.dp, {
    key: `${mcPairKey(slot)}|${rt.off}`,
    lastLine: rt.off === 0,
    interval: slot.interval,
  });
  const live = card.querySelector('[data-mc="live"]');
  if (live) live.hidden = rt.off === 0;
  mcUpdateSlotHeader(i);
}

// Header price/% + footer H/L + meta. The footer defers to the crosshair
// while the pointer is inspecting a candle (dataset.hover contract from v1).
function mcUpdateSlotHeader(i) {
  const slot = mcState.slots[i];
  const card = mcCardEl(i);
  if (!slot || !card) return;
  const rt = mcRtOf(i);
  const ent = mcStore[mcPairKey(slot)];
  const candles = ent && ent.candles;
  const px = card.querySelector('[data-mc="px"]');
  const chg = card.querySelector('[data-mc="chg"]');
  const foot = card.querySelector('[data-mc="foot"]');
  const meta = card.querySelector('[data-mc="meta"]');
  if (!candles || !candles.length || !rt.vis || !rt.vis.length) {
    if (px) px.textContent = "—";
    if (chg) { chg.textContent = ""; chg.className = "mc-chg mono flat"; }
    if (foot && foot.dataset.hover !== "1") foot.textContent = "—";
    if (meta) meta.textContent = "";
    return;
  }
  const last = candles[candles.length - 1];
  if (px) px.textContent = fmtNum(last.c, rt.dp);
  const first = rt.vis[0];
  const pctChg = first.o ? (rt.vis[rt.vis.length - 1].c / first.o - 1) * 100 : 0;
  if (chg) {
    chg.textContent = `${pctChg > 0 ? "▲ +" : pctChg < 0 ? "▼ " : ""}${pctChg.toFixed(2)}%`;
    chg.className = "mc-chg mono " + (pctChg > 0 ? "pos" : pctChg < 0 ? "neg" : "flat");
  }
  let hi = -Infinity, lo = Infinity;
  rt.vis.forEach((c) => { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; });
  if (foot && foot.dataset.hover !== "1") {
    foot.textContent = `H ${fmtNum(hi, rt.dp)}  L ${fmtNum(lo, rt.dp)}`;
  }
  if (meta) {
    meta.textContent = `${mcIvLabel(slot.interval)} · ${rt.vis.length}${rt.off > 0 ? ` · −${rt.off}` : ""}`;
  }
}

// ---- focus / fullscreen ------------------------------------------------------

function mcSetFocus(i, opts = {}) {
  if (i < 0 || i >= mcState.slots.length) return;
  const prev = mcCardEl(mcState.focus);
  if (prev) prev.classList.remove("focused");
  mcState.focus = i;
  const card = mcCardEl(i);
  if (card) {
    card.classList.add("focused");
    if (opts.focusDom !== false) card.focus({ preventScroll: true });
  }
  mcAutoSave();
}

function mcApplyFullscreen() {
  const panel = mcPanel();
  if (panel) {
    panel.classList.toggle("chart-full", !!mcState.panelFull);
    const btn = document.getElementById("chart-expand");
    if (btn) btn.setAttribute("aria-pressed", String(!!mcState.panelFull));
  }
  const grid = mcEl();
  if (grid) {
    grid.querySelectorAll(":scope > .mc-card[data-cid]").forEach((el) => {
      el.classList.toggle("mc-full", !!mcState.fs && el.dataset.cid === mcState.fs);
    });
  }
  mcApplyGridTemplate();
}

function mcToggleChartFullscreen(i) {
  const slot = mcState.slots[i];
  if (!slot) return;
  mcState.fs = mcState.fs === slot.id ? "" : slot.id;
  mcApplyFullscreen();
  mcAutoSave();
}

function mcTogglePanelFullscreen() {
  mcState.panelFull = !mcState.panelFull;
  mcApplyFullscreen();
  mcAutoSave();
}

// ---- mutations (layout / symbol / interval / links / slots) -----------------

function mcSetLayout(id) {
  if (!MC_LAYOUT_IDS.includes(id) || id === mcState.layout) return;
  const cap = MC_LAYOUT_SLOTS[id];
  mcFlip(() => {
    mcState.layout = id;
    if (mcState.slots.length > cap) mcState.slots = mcState.slots.slice(0, cap);
    if (mcState.focus >= mcState.slots.length) mcState.focus = 0;
    if (mcState.fs && !mcState.slots.some((s) => s.id === mcState.fs)) mcState.fs = "";
    mcRenderGrid();
  });
  mcRenderControls();
  mcAutoSave();
}

// Linked-set membership: charts with slot.linked participate in whichever
// sync toggles (mcState.links) are ON. Sync fans out DISPLAY state only.
function mcLinkedPeers(i) {
  const out = [];
  if (!mcState.slots[i] || !mcState.slots[i].linked) return out;
  mcState.slots.forEach((s, k) => { if (k !== i && s.linked) out.push(k); });
  return out;
}

function mcSetSymbol(i, sym, opts = {}) {
  const clean = String(sym || "").trim().toUpperCase();
  if (!MC_SYMBOL_RE.test(clean)) return;
  const targets = [i];
  if (mcState.links.symbol && !opts.solo) targets.push(...mcLinkedPeers(i));
  let changed = false;
  targets.forEach((k) => {
    const slot = mcState.slots[k];
    if (!slot || slot.symbol === clean) return;
    slot.symbol = clean;
    mcRtOf(k).off = 0; // a new market always opens at the live edge
    changed = true;
  });
  if (!changed) return;
  mcRememberRecent(clean);
  mcRenderGrid(); // symbol appears in several static places on the card
  mcTick();
  mcAutoSave();
}

function mcSetInterval(i, code, opts = {}) {
  if (!MC_INTERVAL_CODES.includes(code)) return;
  const targets = [i];
  if (mcState.links.interval && !opts.solo) targets.push(...mcLinkedPeers(i));
  let changed = false;
  targets.forEach((k) => {
    const slot = mcState.slots[k];
    if (!slot || slot.interval === code) return;
    slot.interval = code;
    mcRtOf(k).off = 0;
    changed = true;
  });
  if (!changed) return;
  mcRenderGrid();
  mcTick();
  mcAutoSave();
}

function mcToggleLink(kind) {
  if (!MC_LINK_KINDS.includes(kind)) return;
  mcState.links[kind] = !mcState.links[kind];
  mcRenderControls();
  mcAutoSave();
  if (typeof toast === "function") {
    toast(`Chart ${kind} sync ${mcState.links[kind] ? "ON" : "off"}`, "info", 1600);
  }
}

function mcToggleSlotLinked(i) {
  const slot = mcState.slots[i];
  if (!slot) return;
  slot.linked = !slot.linked;
  const btn = mcCardEl(i) && mcCardEl(i).querySelector('[data-mc="link"]');
  if (btn) {
    btn.classList.toggle("on", slot.linked);
    btn.setAttribute("aria-pressed", String(slot.linked));
  }
  mcAutoSave();
}

// Grow into the next layout that fits `count` charts (for add/duplicate).
function mcLayoutFor(count) {
  const order = ["1", "2h", "3", "4", "6", "8", "9"];
  for (const id of order) if (MC_LAYOUT_SLOTS[id] >= count) return id;
  return "9";
}

function mcAddChart(atIdx) {
  if (mcState.slots.length >= MC_LAYOUT_SLOTS["9"]) {
    if (typeof toast === "function") toast("Chart limit reached (9)", "warn");
    return;
  }
  // Pick the first default symbol not already on screen (falls back to BTC).
  const onScreen = new Set(mcState.slots.map((s) => s.symbol));
  const sym = MC_DEFAULT_SYMBOLS.find((s) => !onScreen.has(s)) || "BTCUSDT";
  const ref = mcState.slots[mcState.focus] || mcState.slots[0];
  const slot = mcNewSlot(sym, ref ? ref.interval : "15", ref ? ref.span : MC_DEFAULT_SPAN);
  mcFlip(() => {
    mcState.slots.push(slot);
    if (mcState.slots.length > MC_LAYOUT_SLOTS[mcState.layout]) {
      mcState.layout = mcLayoutFor(mcState.slots.length);
    }
    mcRenderGrid();
  });
  mcRenderControls();
  mcSetFocus(mcState.slots.length - 1, { focusDom: false });
  mcTick();
  mcAutoSave();
  // atIdx (a placeholder cell) is only a visual hint — slots stay dense.
  void atIdx;
}

function mcDuplicateChart(i) {
  const src = mcState.slots[i];
  if (!src) return;
  if (mcState.slots.length >= MC_LAYOUT_SLOTS["9"]) {
    if (typeof toast === "function") toast("Chart limit reached (9)", "warn");
    return;
  }
  const copy = mcNewSlot(src.symbol, src.interval, src.span);
  copy.linked = src.linked;
  mcFlip(() => {
    mcState.slots.splice(i + 1, 0, copy);
    if (mcState.slots.length > MC_LAYOUT_SLOTS[mcState.layout]) {
      mcState.layout = mcLayoutFor(mcState.slots.length);
    }
    mcRenderGrid();
  });
  mcRenderControls();
  mcSetFocus(i + 1, { focusDom: false });
  mcAutoSave();
}

function mcCloseChart(i) {
  if (mcState.slots.length <= 1) return; // the last chart is unclosable
  const slot = mcState.slots[i];
  mcFlip(() => {
    mcState.slots.splice(i, 1);
    _mcRt.splice(i, 1);
    if (mcState.fs === slot.id) mcState.fs = "";
    if (mcState.focus >= mcState.slots.length) mcState.focus = mcState.slots.length - 1;
    mcRenderGrid();
  });
  mcApplyFullscreen();
  mcAutoSave();
}

function mcSwapSlots(a, b) {
  if (a === b || !mcState.slots[a] || !mcState.slots[b]) return;
  mcFlip(() => {
    const t = mcState.slots[a];
    mcState.slots[a] = mcState.slots[b];
    mcState.slots[b] = t;
    const rt = _mcRt[a]; _mcRt[a] = _mcRt[b]; _mcRt[b] = rt;
    mcState.focus = b;
    mcRenderGrid();
  });
  mcAutoSave();
}

function mcMoveSlotToEnd(a) {
  if (!mcState.slots[a]) return;
  mcFlip(() => {
    mcState.slots.push(mcState.slots.splice(a, 1)[0]);
    _mcRt.push(_mcRt.splice(a, 1)[0]);
    mcState.focus = mcState.slots.length - 1;
    mcRenderGrid();
  });
  mcAutoSave();
}

// ---- zoom / pan --------------------------------------------------------------

function mcZoom(i, factor, opts = {}) {
  const slot = mcState.slots[i];
  if (!slot) return;
  const next = Math.max(MC_MIN_SPAN, Math.min(MC_MAX_SPAN, Math.round(slot.span * factor)));
  if (next === slot.span) return;
  slot.span = next;
  mcRenderSlot(i);
  if (mcState.links.zoom && !opts.solo) {
    mcLinkedPeers(i).forEach((k) => {
      if (mcState.slots[k].span !== next) { mcState.slots[k].span = next; mcRenderSlot(k); }
    });
  }
  mcAutoSave();
}

function mcPanTo(i, off, opts = {}) {
  const slot = mcState.slots[i];
  const rt = mcRtOf(i);
  const ent = mcStore[mcPairKey(slot)];
  const n = ent && ent.candles ? ent.candles.length : 0;
  const clamped = Math.max(0, Math.min(Math.max(0, n - Math.min(slot.span, n)), Math.round(off)));
  if (clamped === rt.off) return;
  rt.off = clamped;
  mcRenderSlot(i);
  if (mcState.links.zoom && !opts.solo) {
    mcLinkedPeers(i).forEach((k) => mcPanTo(k, clamped, { solo: true }));
  }
}

function mcResetZoom(i) {
  const slot = mcState.slots[i];
  if (!slot) return;
  slot.span = MC_DEFAULT_SPAN;
  mcPanTo(i, 0, { solo: true });
  mcRenderSlot(i);
  if (mcState.links.zoom) {
    mcLinkedPeers(i).forEach((k) => {
      mcState.slots[k].span = MC_DEFAULT_SPAN;
      mcPanTo(k, 0, { solo: true });
      mcRenderSlot(k);
    });
  }
  mcAutoSave();
}

function mcResetZoomAll() {
  mcState.slots.forEach((s, i) => {
    s.span = MC_DEFAULT_SPAN;
    mcRtOf(i).off = 0;
    mcRenderSlot(i);
  });
  mcAutoSave();
}

// ---- crosshair (with optional cross-chart time sync) -------------------------

function mcCrossShow(i, idxInVis, clientY) {
  const card = mcCardEl(i);
  const rt = mcRtOf(i);
  if (!card || !rt.vis || !rt.vis.length) return;
  const svg = card.querySelector("svg.cs");
  const plot = card.querySelector(".mc-plot");
  const cross = card.querySelector(".cc-cross");
  const foot = card.querySelector('[data-mc="foot"]');
  if (!svg || !plot || !cross || !foot) return;
  const rect = svg.getBoundingClientRect();
  const boxRect = plot.getBoundingClientRect();
  if (rect.width <= 0) return;
  const n = rt.vis.length;
  const step = (CC_GEOM.W - CC_GEOM.L - CC_GEOM.R) / n;
  const idx = Math.max(0, Math.min(n - 1, idxInVis));
  const c = rt.vis[idx];
  const xc = CC_GEOM.L + (idx + 0.5) * step;
  cross.style.left = ((rect.left - boxRect.left) + (xc / CC_GEOM.W) * rect.width).toFixed(1) + "px";
  cross.hidden = false;
  foot.dataset.hover = "1"; // freeze the periodic H/L repaint while inspecting
  foot.textContent =
    `${fmtClockFor(c.t, mcState.slots[i].interval)}  O ${fmtNum(c.o, rt.dp)}  H ${fmtNum(c.h, rt.dp)}  L ${fmtNum(c.l, rt.dp)}  C ${fmtNum(c.c, rt.dp)}`;
  // Horizontal hairline + price tag only on the chart actually under the
  // pointer (clientY != null) — peer charts have different price scales.
  const yline = card.querySelector(".mc-yline");
  const ytag = card.querySelector(".mc-ytag");
  if (yline && ytag && rt.geom) {
    if (clientY == null) { yline.hidden = true; ytag.hidden = true; return; }
    const yUser = ((clientY - rect.top) / rect.height) * rt.geom.H;
    if (yUser < rt.geom.T || yUser > rt.geom.priceBottom) { yline.hidden = true; ytag.hidden = true; return; }
    const price = rt.geom.min + rt.geom.span * (1 - (yUser - rt.geom.T) / (rt.geom.priceBottom - rt.geom.T));
    const topPx = (clientY - boxRect.top);
    yline.style.top = topPx.toFixed(1) + "px";
    yline.hidden = false;
    ytag.style.top = ((yUser / rt.geom.H) * 100).toFixed(2) + "%";
    ytag.textContent = fmtNum(price, rt.dp);
    ytag.hidden = false;
  }
}

function mcCrossHide(i) {
  const card = mcCardEl(i);
  if (!card) return;
  const cross = card.querySelector(".cc-cross");
  const yline = card.querySelector(".mc-yline");
  const ytag = card.querySelector(".mc-ytag");
  const foot = card.querySelector('[data-mc="foot"]');
  if (cross) cross.hidden = true;
  if (yline) yline.hidden = true;
  if (ytag) ytag.hidden = true;
  if (foot) delete foot.dataset.hover;
  mcUpdateSlotHeader(i); // restore the H/L line
}

// Fan a hover timestamp out to linked peers: each shows its own candle at
// (or just before) that time if it falls inside its visible window.
function mcCrossBroadcast(srcIdx, t) {
  mcState.slots.forEach((s, k) => {
    if (k === srcIdx) return;
    const linked = mcState.links.crosshair && mcState.slots[srcIdx].linked && s.linked;
    if (!linked || t == null) { mcCrossHide(k); return; }
    const rt = mcRtOf(k);
    if (!rt.vis || !rt.vis.length) { mcCrossHide(k); return; }
    let idx = -1;
    for (let j = rt.vis.length - 1; j >= 0; j--) {
      if (rt.vis[j].t <= t) { idx = j; break; }
    }
    if (idx < 0) { mcCrossHide(k); return; }
    mcCrossShow(k, idx, null);
  });
}

// ---- symbol picker ------------------------------------------------------------

function mcRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(MC_RECENTS_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.map((s) => String(s).toUpperCase()).filter((s) => MC_SYMBOL_RE.test(s)).slice(0, MC_RECENTS_MAX)
      : [];
  } catch (e) { return []; }
}

function mcRememberRecent(sym) {
  const next = [sym, ...mcRecents().filter((s) => s !== sym)].slice(0, MC_RECENTS_MAX);
  try { localStorage.setItem(MC_RECENTS_KEY, JSON.stringify(next)); } catch (e) { /* quota */ }
}

// The picker's market universe: reuse the watchlist's live ticker index when
// its poll has populated it; otherwise fetch /api/tickers ONCE and cache for
// a minute. No new endpoint, no recurring polling.
async function mcUniverse() {
  const fromIndex = () => Object.keys(_tickerIndex).map((s) => {
    const t = _tickerIndex[s] || {};
    return { symbol: s, last: Number(t.lastPrice), pct: Number(t.price24hPcnt) };
  });
  try {
    if (typeof _tickerIndex === "object" && _tickerIndex && Object.keys(_tickerIndex).length) {
      return fromIndex();
    }
  } catch (e) { /* app.js not booted yet */ }
  const now = Date.now();
  if (_mcUniverse && (now - _mcUniverseAt) < 60_000) return _mcUniverse;
  try {
    const data = await api("/api/tickers");
    const rows = (typeof listOf === "function" ? listOf(data) : []) || [];
    _mcUniverse = rows
      .map((t) => ({
        symbol: String(t.symbol || "").toUpperCase(),
        last: Number(t.lastPrice),
        pct: Number(t.price24hPcnt),
      }))
      .filter((r) => MC_SYMBOL_RE.test(r.symbol));
    _mcUniverseAt = now;
  } catch (e) {
    _mcUniverse = _mcUniverse || [];
  }
  return _mcUniverse;
}

function mcWatchSymbolsForPicker() {
  try {
    if (typeof _wlDoc === "object" && _wlDoc && typeof wlFindList === "function") {
      const list = _wlDoc.lists.find((l) => l.id === _wlDoc.activeId) || _wlDoc.lists[0];
      if (list) {
        const favs = new Set(list.favs || []);
        return list.symbols.slice().sort((a, b) => (favs.has(b) ? 1 : 0) - (favs.has(a) ? 1 : 0));
      }
    }
  } catch (e) { /* watchlist optional */ }
  return [];
}

function mcPickerEl() {
  let el = document.getElementById("mc-picker");
  if (el) return el;
  el = document.createElement("div");
  el.id = "mc-picker";
  el.className = "mc-picker";
  el.hidden = true;
  el.innerHTML =
    `<input id="mc-picker-input" type="text" placeholder="Search markets… (Enter opens, Esc closes)" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="mc-picker-list" aria-label="Search markets" />` +
    `<div id="mc-picker-list" class="mc-picker-list" role="listbox" aria-label="Markets"></div>`;
  document.body.appendChild(el);
  const input = el.querySelector("#mc-picker-input");
  input.addEventListener("input", () => { if (_mcPicker) { _mcPicker.sel = 0; mcPickerPaint(); } });
  input.addEventListener("keydown", (e) => {
    if (!_mcPicker) return;
    if (e.key === "Escape") { e.preventDefault(); mcCloseDropdowns(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); _mcPicker.sel = Math.min(_mcPicker.sel + 1, _mcPicker.rows.length - 1); mcPickerPaint(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _mcPicker.sel = Math.max(_mcPicker.sel - 1, 0); mcPickerPaint(true); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const row = _mcPicker.rows[_mcPicker.sel];
      const typed = input.value.trim().toUpperCase();
      const sym = row ? row.symbol : (MC_SYMBOL_RE.test(typed) ? typed : null);
      if (sym) { mcSetSymbol(_mcPicker.idx, sym); mcCloseDropdowns(); }
    }
  });
  el.addEventListener("click", (e) => {
    const row = e.target.closest(".mc-pick-row[data-sym]");
    if (row && _mcPicker) {
      mcSetSymbol(_mcPicker.idx, row.dataset.sym);
      mcCloseDropdowns();
    }
  });
  return el;
}

function mcPickerRows(universe, query) {
  const q = String(query || "").trim().toUpperCase();
  const uniIdx = {};
  universe.forEach((r) => { uniIdx[r.symbol] = r; });
  const mk = (symbol, group) => ({ symbol, group, ...(uniIdx[symbol] || {}) });
  const seen = new Set();
  const out = [];
  const push = (symbol, group) => {
    if (!symbol || seen.has(symbol)) return;
    if (q && !symbol.includes(q)) return;
    seen.add(symbol);
    out.push(mk(symbol, group));
  };
  if (!q) {
    mcRecents().forEach((s) => push(s, "Recent"));
    mcWatchSymbolsForPicker().forEach((s) => push(s, "Watchlist"));
    universe.slice(0, 400).forEach((r) => { if (out.length < 60) push(r.symbol, "Markets"); });
  } else {
    // startsWith beats includes; exact match first (same ranking as the
    // watchlist search).
    const starts = [], contains = [];
    universe.forEach((r) => {
      if (r.symbol === q) starts.unshift(r.symbol);
      else if (r.symbol.startsWith(q)) starts.push(r.symbol);
      else if (r.symbol.includes(q)) contains.push(r.symbol);
    });
    mcRecents().forEach((s) => push(s, "Recent"));
    mcWatchSymbolsForPicker().forEach((s) => push(s, "Watchlist"));
    starts.concat(contains).forEach((s) => { if (out.length < 40) push(s, "Markets"); });
  }
  return out.slice(0, 40);
}

function mcPickerPaint(keepScroll) {
  if (!_mcPicker) return;
  const el = mcPickerEl();
  const input = el.querySelector("#mc-picker-input");
  const list = el.querySelector("#mc-picker-list");
  _mcPicker.rows = mcPickerRows(_mcPicker.universe || [], input.value);
  const q = input.value.trim().toUpperCase();
  let lastGroup = null;
  const parts = [];
  _mcPicker.rows.forEach((r, i) => {
    if (r.group !== lastGroup) {
      lastGroup = r.group;
      parts.push(`<div class="mc-pick-group">${esc(r.group)}</div>`);
    }
    const pctTxt = isFinite(r.pct) ? `${(r.pct * 100).toFixed(2)}%` : "";
    const pctCls = isFinite(r.pct) ? (r.pct > 0 ? "pos" : r.pct < 0 ? "neg" : "flat") : "flat";
    parts.push(
      `<div class="mc-pick-row${i === _mcPicker.sel ? " sel" : ""}" role="option" aria-selected="${i === _mcPicker.sel}" data-sym="${esc(r.symbol)}">` +
        `<span class="mono">${esc(r.symbol)}</span>` +
        `<span class="mono mc-pick-px">${isFinite(r.last) ? esc(fmtNum(r.last, mcDp(r.symbol, r.last))) : ""} <em class="${pctCls}">${esc(pctTxt)}</em></span>` +
      `</div>`
    );
  });
  if (!_mcPicker.rows.length) {
    parts.push(`<div class="mc-pick-empty muted">${q ? `No market matches “${esc(q)}”.` : "No markets loaded yet."}</div>`);
  }
  list.innerHTML = parts.join("");
  if (!keepScroll) list.scrollTop = 0;
  const selEl = list.querySelector(".mc-pick-row.sel");
  if (selEl && keepScroll) selEl.scrollIntoView({ block: "nearest" });
}

async function mcOpenPicker(i, anchor) {
  mcCloseDropdowns();
  const el = mcPickerEl();
  _mcPicker = { idx: i, rows: [], sel: 0, universe: [] };
  const rect = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(window.innerWidth - 288, rect.left)) + "px";
  el.style.top = Math.min(window.innerHeight - 340, rect.bottom + 6) + "px";
  el.hidden = false;
  const input = el.querySelector("#mc-picker-input");
  input.value = "";
  mcPickerPaint();
  input.focus();
  _mcPicker.universe = await mcUniverse();
  if (_mcPicker) mcPickerPaint(); // may have been closed while fetching
}

// ---- interval menu -------------------------------------------------------------

function mcIvMenuEl() {
  let el = document.getElementById("mc-ivmenu");
  if (el) return el;
  el = document.createElement("div");
  el.id = "mc-ivmenu";
  el.className = "mc-ivmenu";
  el.setAttribute("role", "menu");
  el.hidden = true;
  el.innerHTML = MC_INTERVAL_CODES.map(
    (c) => `<button type="button" role="menuitem" class="mono" data-iv="${esc(c)}">${esc(mcIvLabel(c))}</button>`
  ).join("");
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-iv]");
    if (b && _mcIvMenu) {
      mcSetInterval(_mcIvMenu.idx, b.dataset.iv);
      mcCloseDropdowns();
    }
  });
  return el;
}

function mcOpenIvMenu(i, anchor) {
  mcCloseDropdowns();
  const el = mcIvMenuEl();
  _mcIvMenu = { idx: i };
  const cur = mcState.slots[i] ? mcState.slots[i].interval : "15";
  el.querySelectorAll("button[data-iv]").forEach((b) => {
    b.classList.toggle("active", b.dataset.iv === cur);
  });
  const rect = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(window.innerWidth - 96, rect.left)) + "px";
  el.style.top = Math.min(window.innerHeight - 300, rect.bottom + 6) + "px";
  el.hidden = false;
  const active = el.querySelector("button.active") || el.querySelector("button");
  if (active) active.focus();
}

function mcCloseDropdowns() {
  const p = document.getElementById("mc-picker");
  if (p) p.hidden = true;
  const m = document.getElementById("mc-ivmenu");
  if (m) m.hidden = true;
  _mcPicker = null;
  _mcIvMenu = null;
}

// ---- screenshot (chart → PNG download; pure client-side) ----------------------

function mcScreenshot(i) {
  const slot = mcState.slots[i];
  const rt = mcRtOf(i);
  if (!slot || !rt.vis || !rt.vis.length) {
    if (typeof toast === "function") toast("Nothing to capture yet — chart still loading", "warn");
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const col = (name, fb) => (css.getPropertyValue(name) || "").trim() || fb;
  const C = {
    bg: col("--surface", "#10121a"), text: col("--text", "#eef1f8"),
    muted: col("--muted", "#6e7891"), up: col("--pos", "#00c98d"),
    // Gridlines come from the theme token: a hardcoded white wash is
    // invisible on the light theme's paper background.
    down: col("--neg", "#ff4d67"), grid: col("--grid", "rgba(255,255,255,0.07)"),
  };
  const vis = rt.vis, dp = rt.dp;
  const W = 1280, H = 640, padL = 20, padR = 110, padT = 64, padB = 46, volH = 90, gap = 12;
  const priceBottom = H - padB - volH - gap;
  let min = Infinity, max = -Infinity, maxV = 0;
  vis.forEach((c) => { if (c.l < min) min = c.l; if (c.h > max) max = c.h; if (c.v > maxV) maxV = c.v; });
  const padPx = (max - min) * 0.08 || 1;
  min -= padPx; max += padPx;
  const span = (max - min) || 1;
  if (!(maxV > 0)) maxV = 1;
  const n = vis.length, plotW = W - padL - padR, step = plotW / n, bodyW = Math.max(2, step * 0.62);
  const y = (p) => padT + (priceBottom - padT) * (1 - (p - min) / span);
  const parts = [
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}"/>`,
    `<text x="${padL}" y="30" fill="${C.text}" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700">${esc(slot.symbol)} · Perp</text>`,
    `<text x="${padL}" y="50" fill="${C.muted}" font-family="ui-monospace,Menlo,monospace" font-size="12">${esc(mcIvLabel(slot.interval))} · ${n} candles · ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC · DMA Terminal</text>`,
  ];
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (priceBottom - padT) * g / 4;
    const price = max - span * g / 4;
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="${C.grid}"/>`);
    parts.push(`<text x="${W - padR + 8}" y="${(gy + 4).toFixed(1)}" fill="${C.muted}" font-family="ui-monospace,Menlo,monospace" font-size="12">${esc(fmtNum(price, dp))}</text>`);
  }
  vis.forEach((cd, k) => {
    const xc = padL + (k + 0.5) * step;
    const color = cd.c >= cd.o ? C.up : C.down;
    parts.push(`<line x1="${xc.toFixed(1)}" y1="${y(cd.h).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${y(cd.l).toFixed(1)}" stroke="${color}"/>`);
    const yo = y(cd.o), yc = y(cd.c), top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yo - yc));
    parts.push(`<rect x="${(xc - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${color}"/>`);
    const bh = (cd.v / maxV) * volH;
    parts.push(`<rect x="${(xc - bodyW / 2).toFixed(1)}" y="${(H - padB - bh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" fill-opacity="0.28"/>`);
  });
  [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1].forEach((k) => {
    if (k < 0 || k >= n) return;
    const xc = padL + (k + 0.5) * step;
    parts.push(`<text x="${xc.toFixed(1)}" y="${H - 16}" fill="${C.muted}" font-family="ui-monospace,Menlo,monospace" font-size="12" text-anchor="middle">${esc(fmtClockFor(vis[k].t, slot.interval))}</text>`);
  });
  const svgTxt = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  const blob = new Blob([svgTxt], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = W * 2; canvas.height = H * 2; // 2x for crisp retina PNGs
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((png) => {
        if (!png) { if (typeof toast === "function") toast("Screenshot failed", "neg"); return; }
        const a = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
        a.href = URL.createObjectURL(png);
        a.download = `${slot.symbol}_${mcIvLabel(slot.interval)}_${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, "image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (typeof toast === "function") toast("Screenshot failed", "neg");
  };
  img.src = url;
}

// ---- header controls (layout picker + link toggles) ---------------------------

// Miniature layout glyph — a live diagram of the layout's cells.
function mcLayoutGlyph(id) {
  const dims = MC_LAYOUT_GRID[id];
  const places = mcPlaceIndices(id);
  const W = 18, H = 14, g = 1.6;
  const cw = (W - g * (dims[0] - 1)) / dims[0];
  const rh = (H - g * (dims[1] - 1)) / dims[1];
  const rects = places.map((p) =>
    `<rect x="${(p.c * (cw + g)).toFixed(1)}" y="${(p.r * (rh + g)).toFixed(1)}" width="${(p.cs * cw + (p.cs - 1) * g).toFixed(1)}" height="${(p.rs * rh + (p.rs - 1) * g).toFixed(1)}" rx="1.2"/>`
  ).join("");
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" class="mc-glyph">${rects}</svg>`;
}

function mcRenderControls() {
  const seg = document.getElementById("mc-layouts");
  if (seg) {
    if (!seg.children.length) {
      seg.innerHTML = MC_LAYOUT_IDS.map(
        (id) => `<button type="button" class="seg-neutral" data-layout="${esc(id)}" title="${esc(MC_LAYOUT_TITLES[id])}" aria-label="${esc(MC_LAYOUT_TITLES[id])}" aria-pressed="false">${mcLayoutGlyph(id)}</button>`
      ).join("");
    }
    seg.querySelectorAll("button[data-layout]").forEach((b) => {
      const on = b.dataset.layout === mcState.layout;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  const links = document.getElementById("mc-links");
  if (links) {
    if (!links.children.length) {
      const labels = { symbol: "Sym", interval: "Int", crosshair: "Cross", zoom: "Zoom" };
      links.innerHTML = MC_LINK_KINDS.map(
        (k) => `<button type="button" class="seg-neutral mc-linktgl" data-link="${esc(k)}" title="Sync ${esc(k)} across linked charts" aria-pressed="false">${MC_ICONS.link}${esc(labels[k])}</button>`
      ).join("");
    }
    links.querySelectorAll("button[data-link]").forEach((b) => {
      const on = !!mcState.links[b.dataset.link];
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
}

// ---- wiring -------------------------------------------------------------------

function wireCharts() {
  const panel = mcPanel();
  const grid = mcEl();
  if (!panel || !grid || _mcWired) return;
  _mcWired = true;

  mcRenderControls();
  mcRenderGrid();

  // Header: layout picker + link toggles + add + panel fullscreen.
  const seg = document.getElementById("mc-layouts");
  if (seg) seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-layout]");
    if (b) mcSetLayout(b.dataset.layout);
  });
  const links = document.getElementById("mc-links");
  if (links) links.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-link]");
    if (b) mcToggleLink(b.dataset.link);
  });
  const add = document.getElementById("mc-add");
  if (add) add.addEventListener("click", () => mcAddChart());
  const expand = document.getElementById("chart-expand");
  if (expand) expand.addEventListener("click", mcTogglePanelFullscreen);

  // One delegated click handler for every per-card control.
  grid.addEventListener("click", (e) => {
    const fill = e.target.closest('[data-mc="fill"]');
    if (fill) { mcAddChart(Number(fill.closest("[data-empty]").dataset.empty)); return; }
    const card = e.target.closest(".mc-card[data-idx]");
    if (!card) return;
    const i = Number(card.dataset.idx);
    if (mcState.focus !== i) mcSetFocus(i, { focusDom: false });
    const btn = e.target.closest("[data-mc]");
    if (!btn) return;
    const act = btn.dataset.mc;
    if (act === "sym") mcOpenPicker(i, btn);
    else if (act === "iv") mcOpenIvMenu(i, btn);
    else if (act === "link") mcToggleSlotLinked(i);
    else if (act === "refresh") { const ent = mcStore[mcPairKey(mcState.slots[i])]; if (ent) ent.at = 0; mcTick(); }
    else if (act === "shot") mcScreenshot(i);
    else if (act === "dup") mcDuplicateChart(i);
    else if (act === "fs") mcToggleChartFullscreen(i);
    else if (act === "close") mcCloseChart(i);
    else if (act === "live") mcPanTo(i, 0);
    else if (act === "retry") {
      const ent = mcStore[mcPairKey(mcState.slots[i])];
      if (ent) { ent.fails = 0; ent.at = 0; }
      mcRenderSlot(i);
      mcTick();
    }
  });

  // Crosshair + pan (pointer) + zoom (wheel), delegated per plot area.
  let pan = null;
  grid.addEventListener("pointerdown", (e) => {
    const plot = e.target.closest(".mc-plot");
    if (!plot || e.target.closest("button")) return;
    const card = plot.closest(".mc-card[data-idx]");
    if (!card) return;
    const i = Number(card.dataset.idx);
    const rt = mcRtOf(i);
    pan = { i, startX: e.clientX, startOff: rt.off, rect: plot.getBoundingClientRect(), moved: false };
    plot.setPointerCapture(e.pointerId);
  });
  grid.addEventListener("pointermove", (e) => {
    if (pan) {
      const slot = mcState.slots[pan.i];
      if (!slot) { pan = null; return; }
      const dx = e.clientX - pan.startX;
      if (Math.abs(dx) > 3) pan.moved = true;
      if (pan.moved) {
        const perPx = slot.span / Math.max(1, pan.rect.width);
        mcPanTo(pan.i, pan.startOff + dx * perPx);
      }
      return;
    }
    const plot = e.target.closest(".mc-plot");
    if (!plot) return;
    const card = plot.closest(".mc-card[data-idx]");
    if (!card) return;
    const i = Number(card.dataset.idx);
    const rt = mcRtOf(i);
    if (!rt.vis || !rt.vis.length) return;
    const svg = card.querySelector("svg.cs");
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    if (frac < 0 || frac > 1) { mcCrossHide(i); mcCrossBroadcast(i, null); return; }
    const step = (CC_GEOM.W - CC_GEOM.L - CC_GEOM.R) / rt.vis.length;
    let idx = Math.floor((frac * CC_GEOM.W - CC_GEOM.L) / step);
    idx = Math.max(0, Math.min(rt.vis.length - 1, idx));
    mcCrossShow(i, idx, e.clientY);
    mcCrossBroadcast(i, rt.vis[idx].t);
  });
  const endPan = (e) => {
    if (!pan) return;
    const wasDrag = pan.moved;
    pan = null;
    if (wasDrag) e.preventDefault();
  };
  grid.addEventListener("pointerup", endPan);
  grid.addEventListener("pointercancel", () => { pan = null; });
  grid.addEventListener("mouseleave", () => {
    mcState.slots.forEach((s, i) => mcCrossHide(i));
  });
  grid.addEventListener("mouseout", (e) => {
    const plot = e.target.closest && e.target.closest(".mc-plot");
    if (!plot) return;
    if (e.relatedTarget && plot.contains(e.relatedTarget)) return;
    const card = plot.closest(".mc-card[data-idx]");
    if (!card) return;
    mcCrossHide(Number(card.dataset.idx));
    mcCrossBroadcast(Number(card.dataset.idx), null);
  });
  // Wheel zoom must preventDefault (page must not scroll) → non-passive.
  grid.addEventListener("wheel", (e) => {
    const plot = e.target.closest(".mc-plot");
    if (!plot) return;
    const card = plot.closest(".mc-card[data-idx]");
    if (!card) return;
    e.preventDefault();
    const i = Number(card.dataset.idx);
    mcZoom(i, e.deltaY > 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });
  grid.addEventListener("dblclick", (e) => {
    const plot = e.target.closest(".mc-plot");
    if (!plot) return;
    const card = plot.closest(".mc-card[data-idx]");
    if (card) mcResetZoom(Number(card.dataset.idx));
  });

  // Drag-to-swap via the toolbar grip (HTML5 DnD, like the panel reorder).
  grid.addEventListener("dragstart", (e) => {
    const gripEl = e.target.closest(".mc-drag");
    const card = gripEl && gripEl.closest(".mc-card[data-idx]");
    if (!card) return;
    _mcDragIdx = Number(card.dataset.idx);
    e.dataTransfer.setData("text/plain", `mc:${_mcDragIdx}`);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("mc-dragging");
  });
  grid.addEventListener("dragend", () => {
    _mcDragIdx = -1;
    grid.querySelectorAll(".mc-dragging, .mc-dropover").forEach((el) =>
      el.classList.remove("mc-dragging", "mc-dropover"));
  });
  grid.addEventListener("dragover", (e) => {
    if (_mcDragIdx < 0) return;
    const over = e.target.closest(".mc-card");
    if (!over) return;
    e.preventDefault();
    grid.querySelectorAll(".mc-dropover").forEach((el) => el.classList.remove("mc-dropover"));
    if (Number(over.dataset.idx) !== _mcDragIdx) over.classList.add("mc-dropover");
  });
  grid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (_mcDragIdx < 0) return;
    const over = e.target.closest(".mc-card");
    if (!over) return;
    if (over.dataset.idx != null && Number(over.dataset.idx) !== _mcDragIdx) {
      mcSwapSlots(_mcDragIdx, Number(over.dataset.idx));
    } else if (over.dataset.empty != null) {
      mcMoveSlotToEnd(_mcDragIdx);
    }
    _mcDragIdx = -1;
  });

  // Keyboard, scoped to the chart grid (arrows/F/R/±/Delete). stopPropagation
  // keeps the app-level single-key shortcuts (B/S//) from double-firing while
  // a chart card is focused. NAVIGATION/DISPLAY ONLY — no trading action is
  // reachable from any of these keys.
  grid.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const card = t && t.closest && t.closest(".mc-card[data-idx]");
    if (!card) return;
    const i = Number(card.dataset.idx);
    const key = e.key.toLowerCase();
    const nav = (d) => {
      const n = mcState.slots.length;
      if (n) mcSetFocus(((i + d) % n + n) % n);
    };
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); nav(1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); nav(-1); }
    else if (key === "f") { e.preventDefault(); e.stopPropagation(); mcToggleChartFullscreen(i); }
    else if (key === "r") { e.preventDefault(); e.stopPropagation(); mcResetZoom(i); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); e.stopPropagation(); mcZoom(i, 1 / 1.18); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); mcZoom(i, 1.18); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); mcCloseChart(i); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const b = card.querySelector('[data-mc="sym"]'); if (b) mcOpenPicker(i, b); }
  });

  // Track resize dividers.
  mcWireDividerDrag(grid);

  // Alt+1..8 switches layouts globally (never conflicts with browser keys —
  // Ctrl/Cmd+digits are owned by browser tab switching). Inert while typing
  // (macOS Alt+digit composes special characters in text fields).
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    // e.code, not e.key: macOS Option+digit composes a symbol ("¡", "™", …)
    // in e.key; the physical-key code stays Digit1..Digit8 on every layout.
    const m = /^Digit([1-8])$/.exec(e.code || "");
    if (!m) return;
    const pane = document.querySelector('[data-pane="dashboard"]');
    if (!pane || pane.hidden) return;
    e.preventDefault();
    mcSetLayout(MC_LAYOUT_IDS[Number(m[1]) - 1]);
  });

  // Esc: dropdowns close first, then chart fullscreen, then panel fullscreen.
  // Inert while a modal/overlay or the workspace switcher owns the key —
  // Esc there must close THAT, not also drop the chart out of fullscreen.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (_mcPicker || _mcIvMenu) { mcCloseDropdowns(); return; }
    if (document.querySelector(".modal-overlay:not([hidden])")) return;
    const wsp = document.getElementById("ws-panel");
    if (wsp && !wsp.hidden) return;
    if (mcState.fs) { mcState.fs = ""; mcApplyFullscreen(); mcAutoSave(); }
    else if (mcState.panelFull) { mcState.panelFull = false; mcApplyFullscreen(); mcAutoSave(); }
  });
  document.addEventListener("click", (e) => {
    const p = document.getElementById("mc-picker");
    const m = document.getElementById("mc-ivmenu");
    const inDrop = (p && !p.hidden && p.contains(e.target)) || (m && !m.hidden && m.contains(e.target));
    if (!inDrop && !e.target.closest('[data-mc="sym"],[data-mc="iv"]')) mcCloseDropdowns();
  });

  // Reflow on container resize (splitters, window, rail collapse) — throttled
  // to one application per frame.
  if (typeof ResizeObserver === "function") {
    let tick = false;
    const ro = new ResizeObserver(() => {
      if (tick) return;
      tick = true;
      requestAnimationFrame(() => { tick = false; mcApplyGridTemplate(); });
    });
    ro.observe(grid);
  }

  // Pause polling when the browser tab is backgrounded; resume when visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopChartPolling();
    else startChartPolling();
  });

  startChartPolling();
}
