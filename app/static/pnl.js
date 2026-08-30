// ===========================================================================
// UNREALISED PNL — the "PnL" tab: the account's TOTAL unrealised PnL over
// time, sampled server-side every ~5s (app/upnl.py) and persisted in Redis.
//
// ARCHITECTURE
// ------------
// • Loaded BEFORE app.js: this file only DEFINES consts + functions at the
//   top level; app.js's boot calls wirePnl(), its tab switcher calls
//   onPnlActive() / clears _pnTimer, and renderDashboard feeds every live
//   snapshot through pnlIngest(d). Shared helpers (esc, fmtMoneySigned,
//   pnlClass, api, cvtNum, rate, curUnit, …) resolve at call time.
// • DATA HONESTY: the series is exactly what the backend sampled — a Redis
//   or sampler outage leaves a GAP (surfaced via the status line), never an
//   interpolated point. Window max/min come from FULL-resolution data
//   server-side (downsampling only thins the drawing). The live "current"
//   value rides the same WS snapshot the tables render — no extra requests.
// • READ-ONLY BY CONSTRUCTION: nothing here can reach a write endpoint.
// ===========================================================================

// ---------------------------------------------------------------------------
// Pure core — one-line consts + DOM-free helpers (extractable by test_snap.mjs).
// ---------------------------------------------------------------------------
const PN_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"];
const PN_RANGE_LABELS = { "1h": "1H", "6h": "6H", "24h": "1D", "7d": "7D", "30d": "30D", "all": "ALL" };
const PN_RANGE_KEY = "dma.pnl.range.v1";
const PN_REFRESH_MS = 15000;
const PN_CHART_H = 300;

function pnNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function pnSanitizeRange(v) {
  return PN_RANGES.includes(v) ? v : "6h";
}

// Nice axis ticks covering [min,max]: steps of 1/2/2.5/5 × 10^k, always ≥ 2
// ticks, 0 emitted exactly (so the zero gridline pairs with the zero split).
function pnNiceTicks(min, max, count) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / Math.max(1, count || 5);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = mag * 10;
  for (const m of [1, 2, 2.5, 5, 10]) { if (mag * m >= step0) { step = mag * m; break; } }
  const ticks = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

function pnTickDecimals(step) {
  if (!isFinite(step) || step <= 0) return 2;
  if (step >= 10) return 0;
  if (step >= 1) return 1;
  return 2;
}

function pnFmtTick(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs <= 48 * 3600e3) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 6 * 86400e3) {
    // multi-day spans repeat the bare date across ticks — add the hour
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs <= 120 * 86400e3) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function pnFmtFull(ms) {
  const n = pnNum(ms);
  if (n == null) return "—";
  return new Date(n).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function pnAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// DOM manager
// ---------------------------------------------------------------------------
let _pnTimer = null;          // visible-tab refresh interval (cleared by app.js's show())
let _pnRange = "6h";
let _pnData = null;           // last /api/upnl payload for the selected range
let _pnLive = null;           // {v, ts} from the latest WS snapshot
let _pnGeom = null;           // chart geometry for the hover crosshair
let _pnWired = false;
let _pnLoading = false;

function wirePnl() {
  if (_pnWired) return;
  _pnWired = true;
  try { _pnRange = pnSanitizeRange(localStorage.getItem(PN_RANGE_KEY)); } catch (e) {}
  const seg = document.getElementById("pn-ranges");
  seg?.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.range === _pnRange) return;
      _pnRange = pnSanitizeRange(b.dataset.range);
      try { localStorage.setItem(PN_RANGE_KEY, _pnRange); } catch (e) {}
      pnPaintRangeButtons();
      pnLoad();
    });
  });
  pnPaintRangeButtons();
  const box = document.getElementById("pn-chart");
  box?.addEventListener("pointermove", pnHover);
  box?.addEventListener("pointerleave", pnHideTip);
  // Redraw on resize (throttled to a frame) — the SVG is sized in real pixels.
  let tick = false;
  window.addEventListener("resize", () => {
    if (tick) return;
    tick = true;
    requestAnimationFrame(() => {
      tick = false;
      const pane = document.querySelector('[data-pane="pnl"]');
      if (pane && !pane.hidden && _pnData) pnRenderChart();
    });
  });
}

function onPnlActive() {
  pnLoad();
  clearInterval(_pnTimer);
  _pnTimer = setInterval(pnLoad, PN_REFRESH_MS);
}

function pnPaintRangeButtons() {
  document.querySelectorAll("#pn-ranges button").forEach((b) => {
    const on = b.dataset.range === _pnRange;
    b.classList.toggle("active", on);
    b.classList.toggle("seg-neutral", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

async function pnLoad() {
  if (_pnLoading) return;
  _pnLoading = true;
  const status = document.getElementById("pn-status");
  try {
    _pnData = await api(`/api/upnl?range=${encodeURIComponent(_pnRange)}`);
  } catch (err) {
    if (status) status.textContent = err.message || "Failed to load PnL history";
    _pnLoading = false;
    return;
  }
  _pnLoading = false;
  pnRenderStats();
  pnRenderChart();
}

// Live WS snapshot: keep the "current" card and the chart tail moving between
// the 15s Redis refetches. Same summation the backend samples.
function pnlIngest(d) {
  const v = pnNum(d && d.summary && d.summary.totalUnrealisedPnl);
  if (v == null) return;
  _pnLive = { v, ts: Date.now() };
  const pane = document.querySelector('[data-pane="pnl"]');
  if (!pane || pane.hidden || !_pnData) return;
  // Extend the visible window extremes live (the next fetch re-derives them
  // from stored full-resolution data — this only avoids a 15s display lag).
  if (_pnData.window) {
    if (v > _pnData.window.max) { _pnData.window.max = v; _pnData.window.maxTs = _pnLive.ts; }
    if (v < _pnData.window.min) { _pnData.window.min = v; _pnData.window.minTs = _pnLive.ts; }
  }
  // Raw-backed ranges get a live tail point (rollup ranges already reach
  // "now" via the server's in-progress bucket). Guard against re-feeds of the
  // same snapshot (e.g. the currency toggle re-runs renderDashboard).
  const s = _pnData.series;
  if ((_pnRange === "1h" || _pnRange === "6h") && Array.isArray(s) && s.length &&
      _pnLive.ts - s[s.length - 1][0] >= 1000) {
    s.push([_pnLive.ts, v, v, v]);
    if (s.length > 1600) s.shift();
  }
  pnRenderStats();
  pnRenderChart();
}

function pnSet(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined) el.className = cls;
}

function pnRenderStats() {
  const d = _pnData;
  if (!d) return;
  const label = PN_RANGE_LABELS[_pnRange] || _pnRange.toUpperCase();
  const cur = _pnLive || (d.current ? { v: d.current.v, ts: d.current.ts } : null);

  if (cur) {
    pnSet("pn-cur", `${fmtMoneySigned(cur.v)} ${curUnit()}`, `stat-value priv ${pnlClass(cur.v)}`);
    const n = d.current && d.current.n != null ? `${d.current.n} open position${d.current.n === 1 ? "" : "s"} · ` : "";
    pnSet("pn-cur-sub", `${n}${pnAgo(cur.ts)}`);
  } else {
    pnSet("pn-cur", "—", "stat-value priv");
    pnSet("pn-cur-sub", d.enabled ? "waiting for the first sample…" : "tracker not configured");
  }

  const maxLabel = document.getElementById("pn-max-label");
  if (maxLabel) maxLabel.textContent = `Max unrealised PnL · ${label}`;
  const minLabel = document.getElementById("pn-min-label");
  if (minLabel) minLabel.textContent = `Max unrealised loss · ${label}`;
  if (d.window) {
    pnSet("pn-max", `${fmtMoneySigned(d.window.max)} ${curUnit()}`, `stat-value priv ${pnlClass(d.window.max)}`);
    pnSet("pn-max-sub", pnFmtFull(d.window.maxTs));
    pnSet("pn-min", `${fmtMoneySigned(d.window.min)} ${curUnit()}`, `stat-value priv ${pnlClass(d.window.min)}`);
    pnSet("pn-min-sub", pnFmtFull(d.window.minTs));
  } else {
    pnSet("pn-max", "—", "stat-value priv");
    pnSet("pn-max-sub", "no data in this window");
    pnSet("pn-min", "—", "stat-value priv");
    pnSet("pn-min-sub", "no data in this window");
  }

  if (d.allTime) {
    pnSet("pn-ext", `${fmtMoneySigned(d.allTime.max)} / ${fmtMoneySigned(d.allTime.min)}`, "stat-value priv");
    pnSet("pn-ext-sub", `${pnFmtFull(d.allTime.maxTs)} / ${pnFmtFull(d.allTime.minTs)}`);
  } else {
    pnSet("pn-ext", "—", "stat-value priv");
    pnSet("pn-ext-sub", "records begin with the first sample");
  }

  // Status line: freshness + sampler/Redis problems, never silent.
  const status = document.getElementById("pn-status");
  if (status) {
    let txt = "";
    if (d.error) txt = `⚠ ${d.error}`;
    else if (d.lastSampleMs) txt = `sampled ${pnAgo(d.lastSampleMs)} · every ${Math.round(d.intervalMs / 1000)}s`;
    status.textContent = txt;
  }

  // Honesty footer: retention + Redis budget + window coverage.
  const note = document.getElementById("pn-note");
  if (note) {
    const parts = [];
    parts.push("Server-side sampler → Redis · retention: raw 7d · 1-min 60d · 1-hour 2y");
    if (isFinite(d.redisUsedBytes)) {
      parts.push(`Redis memory: ${(d.redisUsedBytes / 1048576).toFixed(1)} MB of 500 MB`);
    }
    const winMs = { "1h": 36e5, "6h": 216e5, "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[_pnRange];
    if (d.window && winMs && Date.now() - d.window.firstTs < winMs * 0.9) {
      parts.push(`history covers ${pnFmtFull(d.window.firstTs)} onward (window still filling)`);
    }
    note.textContent = parts.join(" · ");
  }
}

// ---------------------------------------------------------------------------
// Chart: real-pixel SVG — zero-split green/red line + area, hi/lo band, axis
// gridlines, crosshair tooltip. Series rows are [ts, lo, hi, close].
// ---------------------------------------------------------------------------
function pnRenderChart() {
  const box = document.getElementById("pn-chart");
  if (!box || !_pnData) return;
  const rows = (_pnData.series || []).filter((r) => pnNum(r[0]) != null && pnNum(r[3]) != null);
  if (rows.length < 2) {
    _pnGeom = null;
    box.innerHTML = `<p class="muted center" style="padding:40px 0">${
      _pnData.enabled
        ? "Not enough history yet — the sampler records a point every " + Math.round((_pnData.intervalMs || 5000) / 1000) + "s."
        : esc(_pnData.error || "PnL tracking is not configured.")
    }</p>`;
    return;
  }
  const w = Math.max(320, box.clientWidth || 800);
  const h = PN_CHART_H;
  const padL = 10, padR = 66, padT = 12, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;

  const t0 = rows[0][0], t1 = rows[rows.length - 1][0];
  const tSpan = Math.max(1, t1 - t0);
  let yMin = Infinity, yMax = -Infinity;
  rows.forEach((r) => {
    const lo = pnNum(r[1]), hi = pnNum(r[2]);
    if (lo != null && lo < yMin) yMin = lo;
    if (hi != null && hi > yMax) yMax = hi;
  });
  if (!isFinite(yMin) || !isFinite(yMax)) return;
  if (yMax === yMin) { yMax += 1; yMin -= 1; }
  const yPad = (yMax - yMin) * 0.07;
  yMin -= yPad; yMax += yPad;

  const X = (ts) => padL + ((ts - t0) / tSpan) * iw;
  const Y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * ih;

  // Axis ticks are computed in DISPLAY currency (USDT or the INR lens) so the
  // labels are round numbers, then mapped back to raw values for placement.
  const dispTicks = pnNiceTicks(cvtNum(yMin), cvtNum(yMax), 5);
  const dec = pnTickDecimals(dispTicks.length > 1 ? dispTicks[1] - dispTicks[0] : 1);
  let grid = "";
  dispTicks.forEach((tv) => {
    const y = Y(tv / rate());
    if (y < padT - 1 || y > padT + ih + 1) return;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + iw}" y2="${y.toFixed(1)}" class="pn-grid"/>` +
      `<text x="${padL + iw + 6}" y="${(y + 3.5).toFixed(1)}" class="pn-axis">${fmtNum(tv, dec)}</text>`;
  });
  const nx = Math.min(6, Math.max(2, Math.floor(iw / 130)));
  for (let k = 0; k <= nx; k++) {
    const ts = t0 + (tSpan * k) / nx;
    const x = X(ts);
    grid += `<text x="${x.toFixed(1)}" y="${h - 7}" class="pn-axis" text-anchor="${k === 0 ? "start" : k === nx ? "end" : "middle"}">${esc(pnFmtTick(ts, tSpan))}</text>`;
  }

  const pts = rows.map((r) => `${X(r[0]).toFixed(1)},${Y(r[3]).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const zeroInRange = yMin <= 0 && yMax >= 0;
  const zeroY = zeroInRange ? Y(0) : (yMin > 0 ? padT + ih : padT);
  const area = `M${X(t0).toFixed(1)},${zeroY.toFixed(1)} L${pts.join(" L")} L${X(t1).toFixed(1)},${zeroY.toFixed(1)} Z`;

  // hi/lo band (the per-bucket range the downsampling preserved) — only when
  // it actually differs from the close line.
  let band = "";
  if (rows.some((r) => r[2] - r[1] > (yMax - yMin) * 0.001)) {
    const top = rows.map((r) => `${X(r[0]).toFixed(1)},${Y(r[2]).toFixed(1)}`);
    const bot = rows.slice().reverse().map((r) => `${X(r[0]).toFixed(1)},${Y(r[1]).toFixed(1)}`);
    band = `<path d="M${top.join(" L")} L${bot.join(" L")} Z" class="pn-band"/>`;
  }

  const zeroLine = zeroInRange
    ? `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${padL + iw}" y2="${zeroY.toFixed(1)}" class="pn-zero"/>`
    : "";
  const last = rows[rows.length - 1];
  const endCol = last[3] >= 0 ? "var(--pos)" : "var(--neg)";

  box.innerHTML =
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Unrealised PnL over time">` +
    `<defs>` +
    `<clipPath id="pn-clip-above"><rect x="0" y="0" width="${w}" height="${Math.max(0, zeroY).toFixed(1)}"/></clipPath>` +
    `<clipPath id="pn-clip-below"><rect x="0" y="${zeroY.toFixed(1)}" width="${w}" height="${Math.max(0, h - zeroY).toFixed(1)}"/></clipPath>` +
    `</defs>` +
    grid + band + zeroLine +
    `<path d="${area}" clip-path="url(#pn-clip-above)" style="fill:var(--pos);fill-opacity:0.13"/>` +
    `<path d="${area}" clip-path="url(#pn-clip-below)" style="fill:var(--neg);fill-opacity:0.13"/>` +
    `<path d="${line}" clip-path="url(#pn-clip-above)" style="fill:none;stroke:var(--pos);stroke-width:1.6"/>` +
    `<path d="${line}" clip-path="url(#pn-clip-below)" style="fill:none;stroke:var(--neg);stroke-width:1.6"/>` +
    `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[3]).toFixed(1)}" r="3" style="fill:${endCol}"/>` +
    `<g id="pn-hover" style="display:none"><line y1="${padT}" y2="${padT + ih}" class="pn-cross"/><circle r="3.5" class="pn-cross-dot"/></g>` +
    `</svg>`;

  _pnGeom = { rows, X, Y, w, h, padL, padR };
}

function pnHover(e) {
  if (!_pnGeom) return;
  const box = document.getElementById("pn-chart");
  const tip = document.getElementById("pn-tip");
  const svg = box?.querySelector("svg");
  if (!box || !tip || !svg) return;
  const rect = svg.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const { rows, X, Y } = _pnGeom;
  // Nearest point by pixel x (rows are time-ordered → binary search).
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (X(rows[mid][0]) < px) lo = mid; else hi = mid;
  }
  const r = Math.abs(X(rows[lo][0]) - px) <= Math.abs(X(rows[hi][0]) - px) ? rows[lo] : rows[hi];
  const x = X(r[0]), y = Y(r[3]);

  const g = svg.querySelector("#pn-hover");
  if (g) {
    g.style.display = "";
    const line = g.querySelector("line");
    line.setAttribute("x1", x.toFixed(1));
    line.setAttribute("x2", x.toFixed(1));
    const dot = g.querySelector("circle");
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
    dot.style.fill = r[3] >= 0 ? "var(--pos)" : "var(--neg)";
  }
  const range = r[2] - r[1] > 1e-9
    ? `<span class="muted">range</span> <span class="priv">${fmtMoneySigned(r[1])} … ${fmtMoneySigned(r[2])}</span>`
    : "";
  tip.innerHTML = `<b>${esc(pnFmtFull(r[0]))}</b>` +
    `<span class="${pnlClass(r[3])} priv">${fmtMoneySigned(r[3])} ${esc(curUnit())}</span>` + range;
  tip.hidden = false;
  const bw = box.clientWidth, tw = tip.offsetWidth;
  tip.style.left = `${Math.max(4, Math.min(bw - tw - 4, x - tw / 2))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 14)}px`;
}

function pnHideTip() {
  const tip = document.getElementById("pn-tip");
  if (tip) tip.hidden = true;
  document.querySelector("#pn-chart #pn-hover")?.style.setProperty("display", "none");
}
