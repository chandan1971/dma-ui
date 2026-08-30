// Node regression test for the money-sizing math in app/static/app.js.
// app.js is a browser script (touches window/document), so we extract the two
// pure, DOM-free functions by source and evaluate them in isolation. This guards
// the snapToStep IEEE-754 floor fix (a wrong floor silently under-sizes orders).
import fs from "node:fs";
import assert from "node:assert/strict";

// app.js + charts.js + risk.js + journal.js + ai.js share one global scope in
// the browser (plain scripts); concatenating them here mirrors that, so
// cross-file references (e.g. wsSanitizeState → mcSanitizeCharts /
// rkSanitizeViewState / jnSanitizeViewState / aiSanitizeViewState) extract.
const src = fs.readFileSync(new URL("../app/static/charts.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/risk.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/pnl.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/journal.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/ai.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/exec.js", import.meta.url), "utf8") +
  "\n" + fs.readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8") +
  // theme.js ships as a separate <head> script (pre-paint), not part of the
  // deferred bundle — appended here only so its pure core extracts.
  "\n" + fs.readFileSync(new URL("../app/static/theme.js", import.meta.url), "utf8");

function extractFn(name) {
  const start = src.search(new RegExp(`function ${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  // The body brace is the first "{" AFTER the parameter list closes — the
  // params may themselves be a destructuring pattern containing braces
  // (e.g. projectedPnl({ side, entry, ... })), so match the parens first.
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const factory = new Function(
  extractFn("decimalsOf") + "\n" + extractFn("snapToStep") +
  "\nreturn { decimalsOf, snapToStep };"
);
const { snapToStep } = factory();

// The core M2 regression: 0.3 / 0.1 === 2.9999999999999996 must NOT floor to 0.2.
assert.equal(snapToStep("0.3", "0.1"), "0.3");
assert.equal(snapToStep("2.5", "0.1"), "2.5");
assert.equal(snapToStep("0.6", "0.1"), "0.6");
// The epsilon must not over-round a genuinely-below value up a step.
assert.equal(snapToStep("1.29", "0.1"), "1.2");
assert.equal(snapToStep("0.05", "0.1"), "0.0"); // below one lot step -> 0
assert.equal(snapToStep("100", "0.001"), "100.000");
// Guards.
assert.equal(snapToStep("-1", "0.1"), null);
assert.equal(snapToStep("1", "0"), null);

// ---------------------------------------------------------------------------
// projectedPnl — the figure shown before EVERY TP/SL commit and in the order
// ticket preview. Pure function; the fee constant is extracted from app.js so
// these tests track the deployed rate, not a copy.
// ---------------------------------------------------------------------------
const feeLine = src.match(/const TAKER_FEE_RATE = [0-9.]+;.*/);
if (!feeLine) throw new Error("TAKER_FEE_RATE constant not found in app.js");
const pnlFactory = new Function(
  feeLine[0] + "\n" + extractFn("projectedPnl") + "\nreturn { projectedPnl };"
);
const { projectedPnl } = pnlFactory();
const close = (a, b) => Math.abs(a - b) < 1e-9;

// Long take-profit: gross (110-100)×2 = 20; market exit pays taker on the way out.
let r = projectedPnl({ side: "Buy", entry: 100, exitPrice: 110, size: 2 });
assert.ok(close(r.gross, 20), `gross ${r.gross}`);
assert.ok(close(r.exitFee, 110 * 2 * 0.00035), `fee ${r.exitFee}`);
assert.ok(close(r.net, 20 - 110 * 2 * 0.00035), `net ${r.net}`);
assert.equal(r.roi, null, "no leverage -> no ROI (never shown against a guess)");

// Short profit with leverage: margin = entry×size÷lev; ROI = net/margin.
r = projectedPnl({ side: "Sell", entry: 100, exitPrice: 90, size: 1, leverage: 10 });
assert.ok(close(r.gross, 10));
assert.ok(close(r.net, 10 - 90 * 0.00035));
assert.ok(close(r.roi, ((10 - 90 * 0.00035) / 10) * 100), `roi ${r.roi}`);

// Long stop-loss: the loss is gross MINUS the fee (more negative, never less).
r = projectedPnl({ side: "Buy", entry: 100, exitPrice: 95, size: 1 });
assert.ok(close(r.gross, -5));
assert.ok(r.net < -5, "exit fee must deepen a loss, not offset it");

// Case-insensitive side; string inputs (the form supplies strings).
r = projectedPnl({ side: "buy", entry: "100", exitPrice: "101", size: "1" });
assert.ok(close(r.gross, 1));

// Incomplete/invalid inputs -> null, never a fabricated preview.
assert.equal(projectedPnl({ side: "Buy", entry: 0, exitPrice: 1, size: 1 }), null);
assert.equal(projectedPnl({ side: "Buy", entry: 1, exitPrice: NaN, size: 1 }), null);
assert.equal(projectedPnl({ side: "Buy", entry: 1, exitPrice: 2, size: -1 }), null);

// ---------------------------------------------------------------------------
// Workspace document operations — the PURE core of the workspace system
// (creation, rename, duplicate, delete, v1 migration, corrupt-storage
// recovery, import validation). Extracted from app.js and run DOM-free.
// ---------------------------------------------------------------------------
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*?;`, "m"));
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return m[0];
}
const wsConsts = ["WS_SCHEMA_VERSION", "WS_MAX", "WS_PANEL_IDS", "WS_TABS", "WS_SYMBOL_RE",
  // wsSanitizeState also references the watchlist view allowlists…
  "WL_FILTERS", "WL_SORTS",
  // …the scanner view sanitizer + its allowlists…
  "SC_SYMBOL_RE", "SC_METRICS", "SC_SORTS", "SC_PRESETS", "SC_SECTION_IDS",
  // …the multi-chart sanitizer's vocabulary (charts.js)…
  "MC_LAYOUT_IDS", "MC_LAYOUT_SLOTS", "MC_LAYOUT_GRID", "MC_INTERVAL_CODES",
  "MC_SYMBOL_RE", "MC_MIN_SPAN", "MC_MAX_SPAN", "MC_DEFAULT_SPAN",
  "MC_LINK_KINDS", "MC_DEFAULT_SYMBOLS",
  // …the risk view sanitizer's allowlists (risk.js)…
  "RK_ALLOC_VIEWS", "RK_HIST_METRICS", "RK_SORTS",
  // …the journal view sanitizer's allowlists (journal.js)…
  "JN_VIEWS", "JN_RANGES", "JN_RESULTS", "JN_SIDES", "JN_STATUS_FILTERS",
  "JN_SORTS", "JN_DATE_RE", "JN_MONTH_RE",
  // …the AI coach view sanitizer's allowlists (ai.js)…
  "AI_VIEWS", "AI_RANGES", "AI_PERIODS",
  // …and the execution-workspace sanitizer's allowlists (exec.js).
  "EX_GROUPINGS", "EX_ROWS_OPTIONS", "EX_ORDER_SORTS", "EX_ORDER_SIDES"].map(extractConst).join("\n");
const wsFns = ["wsId", "scSanitizeViewState", "mcSlotId", "mcNewSlot", "mcSanitizeCharts",
  "rkSanitizeViewState", "jnSanitizeViewState", "aiSanitizeViewState", "exSanitizeViewState",
  "wsSanitizeState", "wsMakeWorkspace", "wsSanitizeWorkspace",
  "wsNewDoc", "wsMigrateFromV1", "wsParseDoc", "wsValidateImport",
  "wsCreate", "wsDuplicate", "wsRename", "wsDelete"].map(extractFn).join("\n");
const WS = new Function(wsConsts + "\n" + wsFns +
  "\nreturn { wsSanitizeState, wsNewDoc, wsMigrateFromV1, wsParseDoc, wsValidateImport, wsCreate, wsDuplicate, wsRename, wsDelete, mcSanitizeCharts };")();

// New document: one Default workspace, active, schema v2.
let doc = WS.wsNewDoc();
assert.equal(doc.version, 2);
assert.equal(doc.workspaces.length, 1);
assert.equal(doc.workspaces[0].name, "Default");
assert.equal(doc.activeId, doc.workspaces[0].id);

// Create: adds + activates; the limit is enforced.
const created = WS.wsCreate(doc, "BTC Scalping", { density: "compact" });
assert.ok(created && doc.activeId === created.id);
assert.equal(created.state.density, "compact");
while (WS.wsCreate(doc, "x")) { /* fill to the cap */ }
assert.equal(doc.workspaces.length, 20, "WS_MAX enforced");
assert.equal(WS.wsCreate(doc, "over"), null);

// Rename: trims, caps at 40 chars, rejects empty.
assert.equal(WS.wsRename(doc, created.id, "  Swing Trading  "), true);
assert.equal(doc.workspaces.find((w) => w.id === created.id).name, "Swing Trading");
assert.equal(WS.wsRename(doc, created.id, "   "), false);
assert.equal(WS.wsRename(doc, created.id, "y".repeat(80)).valueOf(), true);
assert.equal(doc.workspaces.find((w) => w.id === created.id).name.length, 40);

// Duplicate: independent deep copy.
doc = WS.wsNewDoc();
const orig = doc.workspaces[0];
orig.state.collapsed = { charts: true };
const dup = WS.wsDuplicate(doc, orig.id);
assert.ok(dup && dup.id !== orig.id && dup.name.endsWith(" copy"));
dup.state.collapsed.charts = false;
assert.equal(orig.state.collapsed.charts, true, "duplicate must not share state");

// Delete: never the last one; deleting the active re-activates another.
assert.equal(WS.wsDelete(doc, dup.id), true);
assert.equal(WS.wsDelete(doc, orig.id), false, "last workspace is undeletable");
const d2 = WS.wsNewDoc();
const w2 = WS.wsCreate(d2, "two");
assert.equal(d2.activeId, w2.id);
WS.wsDelete(d2, w2.id);
assert.equal(d2.activeId, d2.workspaces[0].id, "active moves after deleting it");

// v1 migration: order/collapsed/legacy density carried into Default.
const mig = WS.wsParseDoc(null, JSON.stringify({ order: ["orders", "positions"], collapsed: { book: true } }), "compact");
assert.equal(mig.migrated, true);
const mst = mig.doc.workspaces[0].state;
assert.deepEqual(mst.order, ["orders", "positions"]);
assert.equal(mst.collapsed.book, true);
assert.equal(mst.density, "compact");

// Corrupt storage: fresh defaults + corrupt flag (caller quarantines the blob).
assert.equal(WS.wsParseDoc("{not json", null, null).corrupt, true);
assert.equal(WS.wsParseDoc(JSON.stringify({ version: 99, workspaces: [] }), null, null).corrupt, true,
  "future schema versions are quarantined, never half-read");
assert.equal(WS.wsParseDoc(null, null, null).corrupt, false);

// Round-trip: a valid doc survives parse unchanged in the fields that matter.
const rt = WS.wsParseDoc(JSON.stringify(d2), null, null);
assert.equal(rt.corrupt, false);
assert.equal(rt.doc.workspaces.length, d2.workspaces.length);
assert.equal(rt.doc.activeId, d2.activeId);

// State sanitization: hostile/garbage values are coerced to safe defaults.
// (`chart` is the LEGACY single-chart shape — it must still migrate.)
const dirty = WS.wsSanitizeState({
  order: ["positions", "positions", "<script>", "charts"],
  collapsed: { charts: true, evil: true },
  density: "ultra",
  chart: { view: "3d", interval: "42", single: "btc<img>" },
  tab: "admin",
  bookSymbol: "sol usdt",
});
assert.deepEqual(dirty.order, ["positions", "charts"], "unknown/dup panel ids dropped");
assert.deepEqual(Object.keys(dirty.collapsed), ["charts"]);
assert.equal(dirty.density, "comfortable");
assert.equal(dirty.charts.layout, "3", "garbage legacy view falls back to the default grid");
assert.equal(dirty.charts.slots.length, 3);
assert.ok(dirty.charts.slots.every((s) => s.interval === "15"), "bad legacy interval → default");
assert.equal(dirty.tab, "dashboard");
assert.equal(dirty.bookSymbol, "");

// Legacy single-view migration keeps the user's symbol + interval.
const legacySingle = WS.wsSanitizeState({ chart: { view: "single", interval: "60", single: "solusdt" } });
assert.equal(legacySingle.charts.layout, "1");
assert.equal(legacySingle.charts.slots.length, 1);
assert.equal(legacySingle.charts.slots[0].symbol, "SOLUSDT");
assert.equal(legacySingle.charts.slots[0].interval, "60");

// Import validation: accepts the export envelope + bare workspaces; rejects junk.
assert.equal(WS.wsValidateImport(null), null);
assert.equal(WS.wsValidateImport({ kind: "theme" }), null);
assert.equal(WS.wsValidateImport({ kind: "workspace" }), null);
const imp = WS.wsValidateImport({
  kind: "workspace", workspace: { name: "Research", state: { tab: "history" } },
});
assert.ok(imp && imp.name === "Research" && imp.state.tab === "history");
assert.ok(imp.id.startsWith("ws_"), "import mints a FRESH id");
const bare = WS.wsValidateImport({ name: "Bare", state: { density: "compact" } });
assert.ok(bare && bare.state.density === "compact");

// ---------------------------------------------------------------------------
// Multi-chart core (charts.js) — mcSanitizeCharts is the trust boundary for
// everything the chart grid renders and everything workspaces persist.
// ---------------------------------------------------------------------------
const MC = { mcSanitizeCharts: WS.mcSanitizeCharts };

// Defaults: no input → the 3-chart focus layout with sane links.
let mc = MC.mcSanitizeCharts(null);
assert.equal(mc.layout, "3");
assert.equal(mc.slots.length, 3);
assert.deepEqual(mc.slots.map((s) => s.symbol), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
assert.deepEqual(mc.links, { symbol: false, interval: false, crosshair: true, zoom: false });
assert.equal(mc.focus, 0);
assert.equal(mc.fs, "");
assert.equal(mc.panelFull, false);
const ids = new Set(mc.slots.map((s) => s.id));
assert.equal(ids.size, 3, "slot ids are unique");

// Round-trip: a valid document survives unchanged in the fields that matter.
mc.slots[1].symbol = "DOGEUSDT";
mc.slots[1].interval = "240";
mc.slots[1].span = 60;
mc.links.symbol = true;
mc.fs = mc.slots[1].id;
mc.focus = 1;
mc.tracks = { "3": { c: [1.5, 1], r: [1, 1] } };
let rt2 = MC.mcSanitizeCharts(mc);
assert.equal(rt2.slots[1].symbol, "DOGEUSDT");
assert.equal(rt2.slots[1].interval, "240");
assert.equal(rt2.slots[1].span, 60);
assert.equal(rt2.slots[1].id, mc.slots[1].id, "ids are stable across round-trips");
assert.equal(rt2.links.symbol, true);
assert.equal(rt2.fs, mc.slots[1].id);
assert.equal(rt2.focus, 1);
assert.deepEqual(rt2.tracks["3"], { c: [1.5, 1], r: [1, 1] });

// Hostile/garbage input: everything coerces to safe values.
mc = MC.mcSanitizeCharts({
  layout: "999",
  slots: [
    { symbol: "btc<img>", interval: "13", span: 1e9, id: "x".repeat(99) },
    { symbol: "ethusdt", interval: "60", span: -5, linked: false },
    "junk",
  ],
  links: { symbol: "yes", drawings: true },
  focus: 42,
  fs: "nonexistent",
  panelFull: "sure",
  tracks: { "4": { c: [0, 900], r: [1, 1] }, evil: { c: [1], r: [1] } },
});
assert.equal(mc.layout, "3", "unknown layout → default");
assert.equal(mc.slots.length, 3, "layout capacity respected");
assert.equal(mc.slots[0].symbol, "BTCUSDT", "invalid symbol → positional default");
assert.equal(mc.slots[0].interval, "15", "invalid interval → default");
assert.equal(mc.slots[0].span, 400, "span clamped to MC_MAX_SPAN");
assert.ok(/^[A-Za-z0-9_-]{1,24}$/.test(mc.slots[0].id), "oversized id regenerated");
assert.equal(mc.slots[1].symbol, "ETHUSDT");
assert.equal(mc.slots[1].span, 20, "span clamped to MC_MIN_SPAN");
assert.equal(mc.slots[1].linked, false);
assert.equal(mc.slots[2].linked, true, "junk slot → defaults, linked by default");
assert.equal(mc.links.symbol, true, "truthy link coerced to boolean");
assert.ok(!("drawings" in mc.links), "unknown link kinds dropped");
assert.equal(mc.focus, 0, "out-of-range focus reset");
assert.equal(mc.fs, "", "fullscreen id must reference a real slot");
assert.equal(mc.panelFull, true);
assert.deepEqual(mc.tracks["4"], { c: [1, 1], r: [1, 1] },
  "out-of-range track fractions fall back to equal tracks (valid axis kept)");
assert.ok(!("evil" in mc.tracks), "unknown layout keys dropped");

// Slot overflow: more slots than the layout holds are truncated, dup ids re-minted.
mc = MC.mcSanitizeCharts({
  layout: "2h",
  slots: [{ id: "same", symbol: "AUSDT" }, { id: "same", symbol: "BUSDT" }, { symbol: "CUSDT" }],
});
assert.equal(mc.slots.length, 2);
assert.notEqual(mc.slots[0].id, mc.slots[1].id, "duplicate slot ids regenerated");

// Legacy migration (grid): three default charts at the saved interval.
mc = MC.mcSanitizeCharts(null, { view: "grid", interval: "5", single: "BTCUSDT" });
assert.equal(mc.layout, "3");
assert.ok(mc.slots.every((s) => s.interval === "5"));

// Legacy migration (single): one chart, the saved symbol.
mc = MC.mcSanitizeCharts(null, { view: "single", interval: "1", single: "dogeusdt" });
assert.equal(mc.layout, "1");
assert.equal(mc.slots.length, 1);
assert.equal(mc.slots[0].symbol, "DOGEUSDT");
assert.equal(mc.slots[0].interval, "1");

// ---------------------------------------------------------------------------
// Risk core (risk.js) — the metrics/score/alert math behind the Risk tab.
// Money-adjacent display logic: wrong numbers here misinform risk decisions,
// so every derivation is pinned. DOM-free, extracted from source.
// ---------------------------------------------------------------------------
const rkConsts = ["RK_BANDS", "RK_BAND_LABELS", "RK_ALLOC_VIEWS", "RK_HIST_METRICS",
  "RK_SORTS", "RK_ALERT_COOLDOWN_MS"].map(extractConst).join("\n");
const rkFns = ["walletAccount", "rkNum", "rkComputeMetrics", "rkRiskScore",
  "rkEvalAlerts", "rkDiffEvents", "rkSanitizeViewState"].map(extractFn).join("\n");
const RK = new Function(rkConsts + "\n" + rkFns +
  "\nreturn { rkComputeMetrics, rkRiskScore, rkEvalAlerts, rkDiffEvents, rkSanitizeViewState };")();
const RK_ROUNDTRIP_BANDS = ["safe", "moderate", "high", "critical"];
const RK_COOLDOWN = 15 * 60_000; // mirrors RK_ALERT_COOLDOWN_MS

const balanceOf = (acct) => ({ result: { list: [acct] } });
const snap = {
  positions: [
    { symbol: "BTCUSDT", side: "Buy", size: "0.5", positionValue: "50000", leverage: "10",
      markPrice: "100000", liqPrice: "90000", unrealisedPnl: "1000", avgPrice: "98000" },
    { symbol: "ETHUSDT", side: "Sell", size: "10", positionValue: "30000", leverage: "5",
      markPrice: "3000", liqPrice: "3900", unrealisedPnl: "-500", avgPrice: "3050" },
    { symbol: "SOLUSDT", side: "Buy", size: "100", positionValue: "20000", leverage: "4",
      markPrice: "200", unrealisedPnl: "1000", positionIM: "5000" },
    { symbol: "GHOST", side: "Buy", size: "0" }, // flat rows never count
  ],
  balance: balanceOf({
    totalEquity: "100000", totalAvailableBalance: "80000", totalInitialMargin: "10000",
    totalMaintenanceMargin: "2000", totalMarginBalance: "100000", totalPerpUPL: "1500",
    accountMMRate: "0.02",
  }),
  errors: {},
};
let rm = RK.rkComputeMetrics(snap);
assert.equal(rm.count, 3, "flat rows excluded");
assert.equal(rm.exposure.gross, 100000);
assert.equal(rm.exposure.net, 40000, "long 70k − short 30k");
assert.equal(rm.exposure.long, 70000);
assert.equal(rm.exposure.short, 30000);
assert.ok(Math.abs(rm.exposure.longPct - 70) < 1e-9);
// Concentration: shares 50/30/20 → HHI = (2500+900+400)/100 = 38.
assert.equal(rm.concentration.largestSymbol, "BTCUSDT");
assert.ok(Math.abs(rm.concentration.largestShare - 50) < 1e-9);
assert.ok(Math.abs(rm.concentration.top3Share - 100) < 1e-9);
assert.ok(Math.abs(rm.concentration.hhi - 38) < 1e-9);
// Liquidation distances: BTC |100000−90000|/100000 = 10%; ETH |3000−3900|/3000 = 30%.
assert.equal(rm.liq.nearest.symbol, "BTCUSDT");
assert.ok(Math.abs(rm.liq.nearest.dist - 10) < 1e-9);
assert.equal(rm.liq.farthest.symbol, "ETHUSDT");
assert.equal(rm.liq.covered, 2, "SOL has no liq price → excluded, never invented");
assert.ok(Math.abs(rm.liq.avg - 20) < 1e-9);
// Margin: util = IM/marginBal = 10%; exchange MM rate wins for health.
assert.ok(Math.abs(rm.margin.util - 10) < 1e-9);
assert.ok(Math.abs(rm.margin.mmPct - 2) < 1e-9);
// Portfolio leverage = gross/equity = 1.0x; UPL% of equity = 1.5%.
assert.ok(Math.abs(rm.leverage.portfolio - 1) < 1e-9);
assert.ok(Math.abs(rm.leverage.uplPctEquity - 1.5) < 1e-9);
// Per-position: exchange positionIM is used verbatim; missing one is estimated.
const solRow = rm.positions.find((p) => p.symbol === "SOLUSDT");
assert.equal(solRow.im, 5000);
assert.equal(solRow.imIsEstimate, false);
const btcRow = rm.positions.find((p) => p.symbol === "BTCUSDT");
assert.equal(btcRow.im, 5000, "estimated as value/leverage");
assert.equal(btcRow.imIsEstimate, true);

// Risk score: available factors only, weights renormalized.
let score = RK.rkRiskScore(rm);
assert.ok(score.score >= 0 && score.score <= 100);
assert.ok(RK_ROUNDTRIP_BANDS.includes(score.band));
assert.equal(score.factors.length, 5, "all five factors present");
assert.ok(score.factors.every((f) => f.score == null || (f.score >= 0 && f.score <= 100)));

// Flat book → 0 / Safe, with an explanation instead of fake precision.
score = RK.rkRiskScore(RK.rkComputeMetrics({ positions: [], balance: snap.balance, errors: {} }));
assert.equal(score.score, 0);
assert.equal(score.band, "safe");
assert.ok(score.note && /no open positions/i.test(score.note));

// Missing balance: money factors drop out and the score renormalizes over
// what is actually known (liq + concentration here) — never fabricated.
const noBal = RK.rkComputeMetrics({ positions: snap.positions, balance: null, errors: {} });
assert.equal(noBal.margin.util, null);
assert.equal(noBal.leverage.portfolio, null);
score = RK.rkRiskScore(noBal);
const usable = score.factors.filter((f) => f.score != null).map((f) => f.key).sort();
assert.deepEqual(usable, ["conc", "liq"], "only derivable factors count");
// liq: 100−10×4 = 60 (w25) · conc: (50−30)×100/70 ≈ 28.6 (w15) → ≈ 48.
assert.ok(Math.abs(score.score - Math.round((60 * 25 + (20 * 100 / 70) * 15) / 40)) <= 1);

// Critical portfolio: high util + near liq + concentrated + levered + deep loss.
const hot = RK.rkComputeMetrics({
  positions: [{ symbol: "BTCUSDT", side: "Buy", size: "1", positionValue: "900000",
    leverage: "25", markPrice: "100000", liqPrice: "97500", unrealisedPnl: "-9000" }],
  balance: balanceOf({ totalEquity: "60000", totalAvailableBalance: "3000",
    totalInitialMargin: "57000", totalMarginBalance: "60000", totalPerpUPL: "-9000" }),
  errors: {},
});
score = RK.rkRiskScore(hot);
assert.equal(score.band, "critical");
assert.ok(score.score >= 75);

// Alert engine: rising edge + hysteresis + cooldown (pure, custom def).
const defs = [{ id: "t", level: "warn", dir: "gte", on: 70, off: 65,
  value: (m) => m.v, msg: (v) => `v=${v}` }];
let ast = { active: {}, lastFired: {} };
let ar = RK.rkEvalAlerts({ v: 72 }, null, ast, 1000, defs);
assert.equal(ar.fired.length, 1, "fires on the rising edge");
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 80 }, null, ast, 2000, defs);
assert.equal(ar.fired.length, 0, "no re-fire while active");
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 66 }, null, ast, 3000, defs);
assert.equal(ar.fired.length, 0);
assert.ok(ar.state.active.t, "hysteresis: 66 ≥ off(65) stays active");
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 60 }, null, ast, 4000, defs);
assert.ok(!ar.state.active.t, "clears below off threshold");
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 90 }, null, ast, 5000, defs);
assert.equal(ar.fired.length, 0, "re-arm inside the cooldown stays silent");
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 60 }, null, ast, 6000, defs);
ast = ar.state;
ar = RK.rkEvalAlerts({ v: 90 }, null, ast, 1000 + RK_COOLDOWN + 1, defs);
assert.equal(ar.fired.length, 1, "fires again after the cooldown");
assert.equal(ar.fired[0].msg, "v=90");
// A null value (missing data) can never hold an alert active.
ar = RK.rkEvalAlerts({ v: null }, null, { active: { t: true }, lastFired: {} }, 1, defs);
assert.equal(ar.fired.length, 0);
assert.ok(!ar.state.active.t);

// Timeline diff: open/close/resize + margin band cross + score band change.
const prevM = RK.rkComputeMetrics(snap);
const nextSnap = JSON.parse(JSON.stringify(snap));
nextSnap.positions = nextSnap.positions.filter((p) => p.symbol !== "ETHUSDT"); // closed
nextSnap.positions[0].size = "1.0"; // BTC increased
nextSnap.positions.push({ symbol: "XRPUSDT", side: "Buy", size: "1000", positionValue: "5000" });
nextSnap.balance = balanceOf({ ...snap.balance.result.list[0], totalInitialMargin: "72000" });
const nextM = RK.rkComputeMetrics(nextSnap);
const evs = RK.rkDiffEvents(prevM, nextM,
  { band: "safe", label: "Safe", score: 10 }, { band: "high", label: "High", score: 60 });
const msgs = evs.map((e) => e.msg).join(" | ");
assert.ok(/Position closed: ETHUSDT/.test(msgs));
assert.ok(/Position increased: BTCUSDT/.test(msgs));
assert.ok(/Position opened: XRPUSDT/.test(msgs));
assert.ok(/utilization rose above 70%/.test(msgs));
assert.ok(/Risk score → High/.test(msgs));

// Liquidation band-cross direction: getting CLOSER is the danger message.
const mkLiq = (dist) => RK.rkComputeMetrics({
  positions: [{ symbol: "BTCUSDT", side: "Buy", size: "1", positionValue: "1000",
    markPrice: "100", liqPrice: String(100 - dist) }],
  balance: snap.balance, errors: {},
});
let liqEvs = RK.rkDiffEvents(mkLiq(12), mkLiq(8));
assert.ok(liqEvs.some((e) => /closer than 10%/.test(e.msg) && e.level === "warn"),
  "12% → 8% must warn about closing in on liquidation");
liqEvs = RK.rkDiffEvents(mkLiq(8), mkLiq(12));
assert.ok(liqEvs.some((e) => /beyond 10% away/.test(e.msg) && e.level === "pos"),
  "8% → 12% is the safe direction");
// Partial snapshots never diff (a failed read must not read as "all closed").
assert.deepEqual(RK.rkDiffEvents(prevM, RK.rkComputeMetrics({ positions: [], balance: null, errors: { positions: "boom" } })), []);

// View-state sanitize: garbage → defaults; valid values survive.
let rv = RK.rkSanitizeViewState({ alloc: "pie3d", sort: "evil", dir: "up", hist: "vibes" });
assert.deepEqual(rv, { alloc: "donut", sort: "value", dir: "desc", hist: "score" });
rv = RK.rkSanitizeViewState({ alloc: "map", sort: "liq", dir: "asc", hist: "util" });
assert.deepEqual(rv, { alloc: "map", sort: "liq", dir: "asc", hist: "util" });
// …and it rides the workspace state end-to-end.
const wsWithRisk = WS.wsSanitizeState({ risk: { alloc: "bars", sort: "lev", dir: "asc", hist: "equity" } });
assert.deepEqual(wsWithRisk.risk, { alloc: "bars", sort: "lev", dir: "asc", hist: "equity" });

// ---------------------------------------------------------------------------
// Watchlist document operations — the PURE core of the Watchlist & Market
// Monitor (CRUD, symbol ops, favorites, sort/filter view, alert evaluation,
// corrupt-storage recovery, import validation). DOM-free, extracted from app.js.
// ---------------------------------------------------------------------------
const wlConsts = ["WL_SCHEMA_VERSION", "WL_MAX_LISTS", "WL_MAX_SYMBOLS", "WL_MAX_ALERTS",
  "WL_SYMBOL_RE", "WL_FILTERS", "WL_SORTS", "WL_ALERT_KINDS", "WL_MOVER_PCT"].map(extractConst).join("\n");
const wlFns = ["wlId", "wlSanitizeSymbol", "wlSanitizeSymbols", "wlSanitizeList", "wlSanitizeAlert",
  "wlNewDoc", "wlParseDoc", "wlValidateImport", "wlFindList", "wlCreate", "wlRename", "wlDuplicate",
  "wlDelete", "wlAddSymbol", "wlRemoveSymbol", "wlReorder", "wlMoveSymbol", "wlToggleFav",
  "wlEvalAlert", "wlComputeView"].map(extractFn).join("\n");
const WL = new Function(wlConsts + "\n" + wlFns +
  "\nreturn { wlSanitizeSymbol, wlNewDoc, wlParseDoc, wlValidateImport, wlFindList, wlCreate, wlRename, wlDuplicate, wlDelete, wlAddSymbol, wlRemoveSymbol, wlReorder, wlMoveSymbol, wlToggleFav, wlEvalAlert, wlComputeView };")();

// Symbol sanitization is the trust boundary.
assert.equal(WL.wlSanitizeSymbol("btcusdt"), "BTCUSDT");
assert.equal(WL.wlSanitizeSymbol(" ethusdt "), "ETHUSDT");
assert.equal(WL.wlSanitizeSymbol("bad-sym!"), null);
assert.equal(WL.wlSanitizeSymbol("<script>"), null);
assert.equal(WL.wlSanitizeSymbol(""), null);

// New doc seeds one "Favorites" list, active.
let wdoc = WL.wlNewDoc();
assert.equal(wdoc.version, 1);
assert.equal(wdoc.lists.length, 1);
assert.equal(wdoc.lists[0].name, "Favorites");
assert.deepEqual(wdoc.lists[0].symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
assert.equal(wdoc.activeId, wdoc.lists[0].id);

// CRUD.
const wl2 = WL.wlCreate(wdoc, "Scalping");
assert.ok(wl2 && wdoc.activeId === wl2.id && wdoc.lists.length === 2);
assert.equal(WL.wlRename(wdoc, wl2.id, "  Swing  "), true);
assert.equal(WL.wlFindList(wdoc, wl2.id).name, "Swing");
assert.equal(WL.wlRename(wdoc, wl2.id, "   "), false); // empty rejected

// Add / dedup / remove symbols.
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "solusdt"), true);
assert.equal(WL.wlFindList(wdoc, wl2.id).symbols[0], "SOLUSDT");
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "SOLUSDT"), false, "duplicate rejected");
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "bad!"), false, "invalid rejected");
WL.wlAddSymbol(wdoc, wl2.id, "XRPUSDT");
assert.equal(WL.wlRemoveSymbol(wdoc, wl2.id, "SOLUSDT"), true);
assert.deepEqual(WL.wlFindList(wdoc, wl2.id).symbols, ["XRPUSDT"]);

// Favorites toggle (only for symbols present in the list).
WL.wlAddSymbol(wdoc, wl2.id, "BTCUSDT");
assert.equal(WL.wlToggleFav(wdoc, wl2.id, "BTCUSDT"), true);
assert.ok(WL.wlFindList(wdoc, wl2.id).favs.includes("BTCUSDT"));
WL.wlToggleFav(wdoc, wl2.id, "BTCUSDT");
assert.ok(!WL.wlFindList(wdoc, wl2.id).favs.includes("BTCUSDT"));
assert.equal(WL.wlToggleFav(wdoc, wl2.id, "NOTINLIST"), false);

// Reorder within a list (custom order).
const rl = WL.wlCreate(wdoc, "Order");
["AUSDT", "BUSDT", "CUSDT"].forEach((s) => WL.wlAddSymbol(wdoc, rl.id, s));
WL.wlReorder(wdoc, rl.id, "CUSDT", "AUSDT"); // move C before A
assert.deepEqual(WL.wlFindList(wdoc, rl.id).symbols, ["CUSDT", "AUSDT", "BUSDT"]);

// Move between lists.
assert.equal(WL.wlMoveSymbol(wdoc, rl.id, wl2.id, "BUSDT"), true);
assert.ok(!WL.wlFindList(wdoc, rl.id).symbols.includes("BUSDT"));
assert.ok(WL.wlFindList(wdoc, wl2.id).symbols.includes("BUSDT"));

// Delete: last list is undeletable; deleting the active re-activates another.
const dd = WL.wlNewDoc();
const only = dd.lists[0];
assert.equal(WL.wlDelete(dd, only.id), false, "last list undeletable");
const extra = WL.wlCreate(dd, "extra");
assert.equal(dd.activeId, extra.id);
WL.wlDelete(dd, extra.id);
assert.equal(dd.activeId, dd.lists[0].id, "active moves after deleting it");

// Corrupt / future-version storage → fresh defaults + corrupt flag.
assert.equal(WL.wlParseDoc("{bad json").corrupt, true);
assert.equal(WL.wlParseDoc(JSON.stringify({ version: 99, lists: [] })).corrupt, true);
assert.equal(WL.wlParseDoc(null).corrupt, false);
const rtWl = WL.wlParseDoc(JSON.stringify(wdoc));
assert.equal(rtWl.corrupt, false);
assert.equal(rtWl.doc.lists.length, wdoc.lists.length);
// Sanitization drops hostile symbols on load.
const poisoned = WL.wlParseDoc(JSON.stringify({
  version: 1, activeId: "x",
  lists: [{ id: "x", name: "P", symbols: ["BTCUSDT", "bad!", "<script>", "ETHUSDT", "BTCUSDT"] }],
}));
assert.deepEqual(poisoned.doc.lists[0].symbols, ["BTCUSDT", "ETHUSDT"], "invalid/dupe symbols dropped");

// Import validation.
assert.equal(WL.wlValidateImport(null), null);
assert.equal(WL.wlValidateImport({ kind: "theme" }), null);
const wimp = WL.wlValidateImport({ kind: "watchlist", list: { name: "Imported", symbols: ["btcusdt", "junk!"] } });
assert.ok(wimp && wimp.name === "Imported");
assert.deepEqual(wimp.symbols, ["BTCUSDT"]);
assert.ok(wimp.id.startsWith("wl_"), "import mints a fresh id");

// Alert evaluation (pure; one-shot edge for above/below via prevPrice).
assert.equal(WL.wlEvalAlert({ kind: "above", value: 100 }, { lastPrice: 101 }, 99), true, "crossed up");
assert.equal(WL.wlEvalAlert({ kind: "above", value: 100 }, { lastPrice: 101 }, 100.5), false, "already above → no re-fire");
assert.equal(WL.wlEvalAlert({ kind: "below", value: 100 }, { lastPrice: 99 }, 101), true, "crossed down");
assert.equal(WL.wlEvalAlert({ kind: "pct_up", value: 5 }, { price24hPcnt: 0.06 }), true);
assert.equal(WL.wlEvalAlert({ kind: "pct_down", value: -5 }, { price24hPcnt: -0.06 }), true);
assert.equal(WL.wlEvalAlert({ kind: "funding_abs", value: 0.05 }, { fundingRate: -0.001 }), true, "|−0.1%| ≥ 0.05%");
assert.equal(WL.wlEvalAlert({ kind: "funding_abs", value: 0.5 }, { fundingRate: 0.0001 }), false);

// Sort + filter view (pure). index maps symbol → metrics.
const idx = {
  AAA: { lastPrice: 10, price24hPcnt: 0.08, turnover24h: 300, fundingRate: 0.001, openInterest: 5 },
  BBB: { lastPrice: 30, price24hPcnt: -0.02, turnover24h: 900, fundingRate: -0.002, openInterest: 9 },
  CCC: { lastPrice: 20, price24hPcnt: 0.01, turnover24h: 100, fundingRate: 0.003, openInterest: 1 },
};
const syms = ["AAA", "BBB", "CCC"];
// Custom keeps order, favorites float to top.
assert.deepEqual(WL.wlComputeView(syms, ["CCC"], idx, { filter: "all", sort: "custom" }), ["CCC", "AAA", "BBB"]);
// Sort by price descending / ascending.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "price", dir: "desc" }), ["BBB", "CCC", "AAA"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "price", dir: "asc" }), ["AAA", "CCC", "BBB"]);
// Sort by 24h % / volume.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "pct", dir: "desc" }), ["AAA", "CCC", "BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "vol", dir: "desc" }), ["BBB", "AAA", "CCC"]);
// Filters combine with search.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "gainers", sort: "symbol", dir: "asc" }), ["AAA", "CCC"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "losers" }), ["BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "movers" }), ["AAA"], "only |24h|≥5%");
assert.deepEqual(WL.wlComputeView(syms, ["BBB"], idx, { filter: "fav" }), ["BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "all", query: "bb" }), ["BBB"]);

// Large watchlist: cap + dedup enforced through the sanitizer at load.
const big = [];
for (let i = 0; i < 600; i++) big.push("S" + i + "USDT");
const bigDoc = WL.wlParseDoc(JSON.stringify({ version: 1, activeId: "b", lists: [{ id: "b", name: "Big", symbols: big }] }));
assert.equal(bigDoc.doc.lists[0].symbols.length, 500, "WL_MAX_SYMBOLS cap enforced on load");

// ---------------------------------------------------------------------------
// Market Scanner core — the PURE engine of the Scan tab (metric accessors,
// rule engine, presets/filters/search/sort pipeline, section ranking, alert
// evaluation, storage sanitization, workspace view state). DOM-free.
// ---------------------------------------------------------------------------
const scConsts = ["SC_SCHEMA_VERSION", "SC_MAX_SCANS", "SC_MAX_RULES", "SC_MAX_ALERTS",
  "SC_MAX_LOG", "SC_MAX_FAVS", "SC_SYMBOL_RE", "SC_TOP_N", "SC_METRICS", "SC_OPS",
  "SC_SORTS", "SC_PRESETS", "SC_SECTION_IDS", "SC_ALERT_KINDS", "SC_ALERT_COOLDOWN_MS"]
  .map(extractConst).join("\n");
const scFns = ["scId", "scMetric", "scSanitizeRule", "scEvalRule", "scScanMatches",
  "scSanitizeScan", "scSanitizeAlert", "scAlertLabel", "scTopMovers", "scEvalAlerts",
  "scSanitizeLogEntry", "scNewDoc", "scParseDoc", "scSanitizeViewState", "scFuzzyScore",
  "scComputeView", "scSectionRows"].map(extractFn).join("\n");
const SC = new Function(scConsts + "\n" + scFns +
  "\nreturn { scMetric, scSanitizeRule, scEvalRule, scScanMatches, scSanitizeScan, scSanitizeAlert, scAlertLabel, scTopMovers, scEvalAlerts, scNewDoc, scParseDoc, scSanitizeViewState, scFuzzyScore, scComputeView, scSectionRows };")();

// Row factory shaped like /api/scanner rows (percent metrics are PERCENT
// numbers; fundingRate stays a fraction exactly as the exchange reports it).
const scRow = (symbol, over) => Object.assign({
  symbol, last: 100, pct5m: 0, pct15m: 0, pct1h: 0, pct24h: 0,
  high24h: 110, low24h: 90, range24hPct: 20, vol15mPct: 0.2,
  turnover24h: 1e6, turnoverDelta15m: 0, fundingRate: 0.0001, fundingDelta1h: 0,
  openInterestValue: 5e6, bid1: 99.9, ask1: 100.1, spark: [1, 2],
}, over || {});

// --- metric accessor: derived metrics + the null trust boundary ---
assert.equal(SC.scMetric(scRow("A"), "last"), 100);
assert.equal(SC.scMetric(scRow("A", { fundingRate: 0.0005 }), "fundingPct"), 0.05, "funding fraction → percent");
assert.equal(SC.scMetric(scRow("A", { fundingDelta1h: -0.0002 }), "fundingDelta1hPct"), -0.02);
assert.ok(Math.abs(SC.scMetric(scRow("A", { last: 99, high24h: 100 }), "distHigh24hPct") - 1) < 1e-9);
assert.ok(Math.abs(SC.scMetric(scRow("A", { last: 91, low24h: 90 }), "distLow24hPct") - (1 / 90) * 100) < 1e-9);
assert.ok(Math.abs(SC.scMetric(scRow("A"), "spreadPct") - 0.2) < 1e-9);
assert.equal(SC.scMetric(scRow("A", { pct15m: null }), "pct15m"), null, "null stays null");
assert.equal(SC.scMetric(scRow("A", { pct15m: "garbage" }), "pct15m"), null);
assert.equal(SC.scMetric(scRow("A", { fundingRate: null }), "fundingPct"), null);
assert.equal(SC.scMetric(null, "last"), null);

// --- rule engine: operators, null-metric refusal, AND/OR ---
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "gte", value: 5 }, scRow("A", { pct24h: 5 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "gt", value: 5 }, scRow("A", { pct24h: 5 })), false);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "lte", value: -5 }, scRow("A", { pct24h: -6 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "absGte", value: 5 }, scRow("A", { pct24h: -6 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "absLte", value: 5 }, scRow("A", { pct24h: -6 })), false);
assert.equal(SC.scEvalRule({ metric: "pct15m", op: "gte", value: 0 }, scRow("A", { pct15m: null })), false,
  "a missing metric can NEVER satisfy a rule — warmup must not fake matches");
const andScan = SC.scSanitizeScan({ id: "s1", name: "big movers", mode: "and", rules: [
  { metric: "pct24h", op: "absGte", value: 5 }, { metric: "turnover24h", op: "gte", value: 1e6 }] });
assert.ok(andScan);
assert.equal(SC.scScanMatches(andScan, scRow("A", { pct24h: 6, turnover24h: 2e6 })), true);
assert.equal(SC.scScanMatches(andScan, scRow("A", { pct24h: 6, turnover24h: 1 })), false, "AND needs all");
const orScan = SC.scSanitizeScan({ id: "s2", mode: "or", rules: [
  { metric: "pct24h", op: "gte", value: 5 }, { metric: "fundingPct", op: "absGte", value: 0.05 }] });
assert.equal(SC.scScanMatches(orScan, scRow("A", { pct24h: 0, fundingRate: 0.001 })), true, "OR needs one");
assert.equal(SC.scScanMatches(orScan, scRow("A", { pct24h: 0 })), false);
// Sanitization: bad rules dropped; a scan with no valid rule is rejected.
const dirtyScan = SC.scSanitizeScan({ id: "s3", mode: "xor", rules: [
  { metric: "nope", op: "gte", value: 1 }, { metric: "pct24h", op: "gte", value: "7" },
  { metric: "pct24h", op: "gte", value: "NaN" }] });
assert.equal(dirtyScan.mode, "and", "unknown mode → and");
assert.equal(dirtyScan.rules.length, 1, "invalid metric / non-numeric value dropped");
assert.equal(SC.scSanitizeScan({ id: "s4", rules: [{ metric: "nope", op: "gt", value: 1 }] }), null);
assert.equal(SC.scSanitizeScan({ rules: [{ metric: "pct24h", op: "gt", value: 1 }] }), null, "id required");

// --- alert sanitization ---
assert.equal(SC.scSanitizeAlert(null), null);
assert.equal(SC.scSanitizeAlert({ kind: "unknown", symbol: "BTCUSDT", value: 1 }), null);
const tm = SC.scSanitizeAlert({ kind: "top_mover" });
assert.ok(tm && tm.symbol === "*" && tm.value === 10, "top_mover defaults: any symbol, rank 10");
assert.equal(SC.scSanitizeAlert({ kind: "top_mover", value: 99 }).value, 10, "out-of-range rank → default");
assert.equal(SC.scSanitizeAlert({ kind: "vol_double", symbol: "*", baseline: 100 }), null,
  "vol_double needs a concrete symbol");
assert.equal(SC.scSanitizeAlert({ kind: "vol_double", symbol: "BTCUSDT" }), null, "…and a baseline");
assert.ok(SC.scSanitizeAlert({ kind: "vol_double", symbol: "btcusdt", baseline: 5e6 }).symbol === "BTCUSDT");
assert.equal(SC.scSanitizeAlert({ kind: "vol15m", symbol: "BTCUSDT", value: 0 }), null, "threshold must be > 0");
assert.ok(SC.scSanitizeAlert({ kind: "funding_abs", symbol: "*", value: 0.05 }));

// --- alert evaluation ---
const mkIdx = (rows) => { const o = {}; rows.forEach((r) => { o[r.symbol] = r; }); return o; };
{
  const rows = [scRow("AAA", { pct24h: 9 }), scRow("BBB", { pct24h: 8 }), scRow("CCC", { pct24h: 7 })];
  const top = SC.scTopMovers(rows, 25);
  assert.deepEqual(top, ["AAA", "BBB", "CCC"]);
  const alert = SC.scSanitizeAlert({ kind: "top_mover", value: 3 });
  // First snapshot (prev null): NOTHING fires — boot is not "entering".
  assert.equal(SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: null }, 1000).length, 0);
  // Sitting on the board: no fire. New entrant: fires once.
  assert.equal(SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: top }, 1000).length, 0);
  const fired = SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] }, 1000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].symbol, "CCC");
  // Rank semantics: moving 4th → 2nd ENTERS a top-3 board even though the
  // symbol sat on the deeper (25-rank) board before.
  const deepPrev = ["AAA", "BBB", "DDD", "CCC"];
  const nowTop = ["AAA", "CCC", "BBB", "DDD"];
  const f2 = SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: nowTop, prevTopMovers: deepPrev }, 1000);
  assert.deepEqual(f2.map((f) => f.symbol), ["CCC"]);
  // Cooldown: a recent lastFired suppresses the re-fire.
  const cooled = SC.scSanitizeAlert({ kind: "top_mover", value: 3, lastFired: { CCC: 900 } });
  assert.equal(SC.scEvalAlerts([cooled], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] }, 1000).length, 0);
  assert.equal(SC.scEvalAlerts([cooled], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] },
    900 + 30 * 60000 + 1).length, 1, "…and expires after the cooldown");
}
{
  const a = SC.scSanitizeAlert({ kind: "vol_double", symbol: "AAA", baseline: 1e6 });
  const under = [scRow("AAA", { turnover24h: 1.9e6 })];
  const over = [scRow("AAA", { turnover24h: 2e6 })];
  assert.equal(SC.scEvalAlerts([a], { index: mkIdx(under), topMovers: [], prevTopMovers: [] }, 1).length, 0);
  assert.equal(SC.scEvalAlerts([a], { index: mkIdx(over), topMovers: [], prevTopMovers: [] }, 1).length, 1);
}
{
  const vol = SC.scSanitizeAlert({ kind: "vol15m", symbol: "*", value: 2 });
  const mv = SC.scSanitizeAlert({ kind: "move15m", symbol: "AAA", value: 1 });
  const fn = SC.scSanitizeAlert({ kind: "funding_abs", symbol: "*", value: 0.05 });
  const rows = [scRow("AAA", { vol15mPct: 2.5, pct15m: -1.2, fundingRate: -0.001 }),
                scRow("BBB", { vol15mPct: 0.1, pct15m: 0.1, fundingRate: 0.0001 })];
  const fired = SC.scEvalAlerts([vol, mv, fn], { index: mkIdx(rows), topMovers: [], prevTopMovers: [] }, 1);
  const bySym = fired.map((f) => f.alert.kind + ":" + f.symbol).sort();
  assert.deepEqual(bySym, ["funding_abs:AAA", "move15m:AAA", "vol15m:AAA"],
    "wildcard scans every symbol; |−1.2%| ≥ 1 and |−0.1%| funding ≥ 0.05 fire");
  // Warm-up honesty: null metrics never fire threshold alerts.
  const cold = [scRow("AAA", { vol15mPct: null, pct15m: null })];
  assert.equal(SC.scEvalAlerts([vol, mv], { index: mkIdx(cold), topMovers: [], prevTopMovers: [] }, 1).length, 0);
}

// --- storage document: corrupt recovery + caps ---
assert.equal(SC.scParseDoc("{nope").corrupt, true);
assert.equal(SC.scParseDoc(JSON.stringify({ version: 99 })).corrupt, true, "future schema quarantined");
assert.equal(SC.scParseDoc(null).corrupt, false);
{
  const doc = SC.scNewDoc();
  doc.favs = ["BTCUSDT", "bad sym!", "ethusdt", "BTCUSDT"];
  doc.scans = new Array(30).fill(0).map((_, i) => ({ id: "s" + i, name: "n" + i, rules: [{ metric: "pct24h", op: "gt", value: i }] }));
  doc.alerts = [{ kind: "vol15m", symbol: "BTCUSDT", value: 1 }, { kind: "vol15m", symbol: "BTCUSDT", value: -1 }];
  doc.log = [{ ts: 1, msg: "x".repeat(500) }, { msg: "" }];
  const rt = SC.scParseDoc(JSON.stringify(doc));
  assert.equal(rt.corrupt, false);
  assert.deepEqual(rt.doc.favs, ["BTCUSDT", "ETHUSDT"], "favs sanitized + deduped");
  assert.equal(rt.doc.scans.length, 20, "SC_MAX_SCANS cap");
  assert.equal(rt.doc.alerts.length, 1, "invalid alert dropped");
  assert.equal(rt.doc.log.length, 1);
  assert.equal(rt.doc.log[0].msg.length, 140, "log messages capped");
}

// --- workspace view state (persisted per workspace) ---
{
  const st = SC.scSanitizeViewState(null);
  assert.equal(st.preset, "all");
  assert.equal(st.sort, "pct24h");
  assert.equal(st.dir, "desc");
  assert.deepEqual(st.sections.order, ["movers", "losers", "volume", "volatility", "funding", "active", "watchlist", "alerts"]);
  const dirty = SC.scSanitizeViewState({
    preset: "evil", sort: "<script>", dir: "sideways", pinFavs: 1, cards: false,
    filters: { priceMin: "5", priceMax: "junk", turnoverMin: 1e6, unknown: 4 },
    sections: { order: ["alerts", "alerts", "nope", "movers"], collapsed: { movers: true, evil: true } },
    sel: "btc usdt", scroll: -50,
  });
  assert.equal(dirty.preset, "all", "unknown preset → all");
  assert.equal(dirty.sort, "pct24h");
  assert.equal(dirty.pinFavs, true);
  assert.equal(dirty.cards, false);
  assert.equal(dirty.filters.priceMin, 5);
  assert.equal(dirty.filters.priceMax, null, "non-numeric filter → off");
  assert.equal(dirty.filters.unknown, undefined, "unknown filter keys dropped");
  assert.equal(dirty.sections.order[0], "alerts");
  assert.equal(dirty.sections.order.length, 8, "missing sections appended, dupes/unknowns dropped");
  assert.deepEqual(Object.keys(dirty.sections.collapsed), ["movers"]);
  assert.equal(dirty.sel, "", "invalid symbol dropped");
  assert.equal(dirty.scroll, 0, "negative scroll clamped");
  assert.equal(SC.scSanitizeViewState({ preset: "scan:scan_abc123" }).preset, "scan:scan_abc123",
    "custom scan preset ids survive");
  // Workspace integration end-to-end: wsSanitizeState carries the scanner view.
  const ws = WS.wsSanitizeState({ tab: "scanner", scanner: { preset: "momentum", sort: "turnover24h", dir: "asc" } });
  assert.equal(ws.tab, "scanner", "scanner is a valid workspace tab");
  assert.equal(ws.scanner.preset, "momentum");
  assert.equal(ws.scanner.sort, "turnover24h");
  assert.equal(ws.scanner.dir, "asc");
  assert.equal(WS.wsSanitizeState({}).scanner.preset, "all", "default scanner state always present");
}

// --- fuzzy search ---
assert.equal(SC.scFuzzyScore("BTCUSDT", "BTC"), 3, "prefix");
assert.equal(SC.scFuzzyScore("WBTCUSDT", "BTC"), 2, "substring");
assert.equal(SC.scFuzzyScore("BTCUSDT", "BCT"), 1, "in-order subsequence (B…C…T)");
assert.equal(SC.scFuzzyScore("BTCUSDT", "TDB"), 0, "out-of-order letters never match");
assert.equal(SC.scFuzzyScore("BTCUSDT", "bud"), 1, "subsequence, case-insensitive");
assert.equal(SC.scFuzzyScore("BTCUSDT", "XRP"), 0);
assert.equal(SC.scFuzzyScore("BTCUSDT", ""), 0);

// --- the view pipeline: presets → filters → search → sort ---
{
  const rows = [
    scRow("UPUSDT", { pct24h: 12, pct15m: 1, pct1h: 3, turnover24h: 9e6, openInterestValue: 9e6 }),
    scRow("DOWNUSDT", { pct24h: -9, pct15m: 0.5, pct1h: -2, turnover24h: 5e6, openInterestValue: 5e6 }),
    scRow("FLATUSDT", { pct24h: 0.2, pct15m: 0.05, pct1h: 0.1, turnover24h: 1e6, openInterestValue: 1e6 }),
    scRow("WARMUSDT", { pct24h: 3, pct15m: null, pct1h: null, vol15mPct: null, turnover24h: 3e6, openInterestValue: 3e6 }),
    scRow("HIUSDT", { pct24h: 4, pct15m: -0.6, pct1h: -1.4, turnover24h: 7e6, openInterestValue: 7e6, last: 5000 }),
  ];
  const view = (over) => Object.assign({ preset: "all", query: "", sort: "pct24h", dir: "desc", pinFavs: false, filters: {} }, over || {});
  const syms = (out) => out.map((r) => r.symbol);

  assert.deepEqual(syms(SC.scComputeView(rows, view(), {})),
    ["UPUSDT", "HIUSDT", "WARMUSDT", "FLATUSDT", "DOWNUSDT"], "default: 24h% desc");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ dir: "asc" }), {})),
    ["DOWNUSDT", "FLATUSDT", "WARMUSDT", "HIUSDT", "UPUSDT"]);
  // Nulls sink regardless of direction.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ sort: "pct15m", dir: "desc" }), {})).pop(), "WARMUSDT");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ sort: "pct15m", dir: "asc" }), {})).pop(), "WARMUSDT");
  // Presets.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "gainers" }), {})),
    ["UPUSDT", "HIUSDT", "WARMUSDT", "FLATUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "losers" }), {})), ["DOWNUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "momentum" }), {})), ["UPUSDT", "HIUSDT"],
    "same-direction 15m+1h moves, either sign; warming rows excluded");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "meanrevert" }), {})), ["DOWNUSDT"],
    "|24h|≥8 with 15m pulling the other way");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "highvolume" }), {})), ["UPUSDT", "HIUSDT"],
    "top decile by turnover (5-sample quantile lands at 7e6)");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "largecaps" }), {})), ["UPUSDT", "HIUSDT"],
    "top quintile by OI value");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "smallcaps" }), {})),
    ["WARMUSDT", "FLATUSDT", "DOWNUSDT"], "bottom half by OI value");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "active" }), {})), ["UPUSDT", "HIUSDT", "DOWNUSDT"],
    "|15m| ≥ 0.3 only; WARMUSDT's null 15m is not active");
  const nearHigh = [scRow("BRKUSDT", { last: 109.8, high24h: 110, low24h: 90 }), scRow("MIDUSDT", { last: 100 })];
  assert.deepEqual(syms(SC.scComputeView(nearHigh, view({ preset: "breakout" }), {})), ["BRKUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "favorites" }), { favs: ["FLATUSDT"] })), ["FLATUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "watchlist" }), { watch: ["HIUSDT", "NOPEUSDT"] })), ["HIUSDT"]);
  // Custom scan preset via ctx.scans.
  const scan = SC.scSanitizeScan({ id: "x1", name: "hot", rules: [{ metric: "pct24h", op: "absGte", value: 8 }] });
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "scan:x1" }), { scans: [scan] })), ["UPUSDT", "DOWNUSDT"]);
  // Filters combine; rows missing a filtered metric are excluded.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { turnoverMin: 5e6, pct24hAbsMin: 5 } }), {})),
    ["UPUSDT", "DOWNUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { vol15mMin: 0.1 } }), {})).includes("WARMUSDT"), false,
    "null vol15m cannot pass a volatility filter");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { priceMin: 1000 } }), {})), ["HIUSDT"]);
  // Search filters the universe…
  assert.deepEqual(syms(SC.scComputeView(rows, view({ query: "UP" }), {})), ["UPUSDT"]);
  // …and ranks matches: a prefix match outranks a substring match even when
  // the active sort would order them the other way.
  assert.deepEqual(syms(SC.scComputeView([scRow("ZUPUSDT"), scRow("UPZUSDT")],
    view({ query: "UP", sort: "symbol", dir: "asc" }), {})), ["UPZUSDT", "ZUPUSDT"]);
  // Pinned favorites float, groups keep sort inside.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ pinFavs: true }), { favs: ["FLATUSDT", "DOWNUSDT"] })),
    ["FLATUSDT", "DOWNUSDT", "UPUSDT", "HIUSDT", "WARMUSDT"]);
}

// --- overview-card ranking ---
{
  const rows = [
    scRow("AAA", { pct24h: 9, pct15m: 2, vol15mPct: 3, turnover24h: 1e6, fundingRate: 0.002, fundingDelta1h: 0.0001 }),
    scRow("BBB", { pct24h: -7, pct15m: -3, vol15mPct: 4, turnover24h: 9e6, fundingRate: -0.003, fundingDelta1h: -0.0009 }),
    scRow("CCC", { pct24h: 2, pct15m: 0.5, vol15mPct: 1, turnover24h: 5e6, fundingRate: 0.0005, fundingDelta1h: 0.0004 }),
  ];
  const sy = (res) => res.rows.map((r) => r.symbol);
  assert.deepEqual(sy(SC.scSectionRows(rows, "movers", {})), ["AAA", "CCC"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "losers", {})), ["BBB"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "volume", {})), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "volatility", {})), ["BBB", "AAA", "CCC"]);
  assert.equal(SC.scSectionRows(rows, "volatility", {}).metric, "vol15mPct");
  // Volatility falls back to 24h range while 15m warms — and says so.
  const warm = rows.map((r) => scRow(r.symbol, { vol15mPct: null, range24hPct: r.turnover24h / 1e6 }));
  assert.equal(SC.scSectionRows(warm, "volatility", {}).metric, "range24hPct");
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "pos" })), ["AAA", "CCC", "BBB"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "neg" })), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "delta" })), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "active", {})), ["BBB", "AAA", "CCC"], "by |15m|");
  assert.deepEqual(sy(SC.scSectionRows(rows, "watchlist", { watch: ["CCC", "BBB"] })), ["BBB", "CCC"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "movers", { limit: 1 })), ["AAA"], "limit respected");
  // No funding data → empty rows (the DOM shows the capability note instead).
  const noFund = rows.map((r) => scRow(r.symbol, { fundingRate: null, fundingDelta1h: null }));
  assert.equal(SC.scSectionRows(noFund, "funding", {}).rows.length, 0);
}

// --- performance guard: the full pipeline over a large universe ---
{
  const big = [];
  for (let i = 0; i < 2000; i++) {
    big.push(scRow("S" + i + "USDT", {
      pct24h: (i % 41) - 20, pct15m: ((i * 7) % 11) - 5, pct1h: ((i * 3) % 13) - 6,
      turnover24h: 1e4 + i * 1e4, last: 1 + (i % 500),
    }));
  }
  const t0 = Date.now();
  let out;
  for (let k = 0; k < 10; k++) {
    out = SC.scComputeView(big, { preset: "momentum", query: "S1", sort: "turnover24h", dir: "desc",
      filters: { turnoverMin: 1e5 } }, { favs: [], watch: [], scans: [] });
  }
  const elapsed = Date.now() - t0;
  assert.ok(out.length > 0 && out.length < big.length);
  for (let k = 1; k < out.length; k++) {
    const sPrev = SC.scFuzzyScore(out[k - 1].symbol, "S1");
    const sCur = SC.scFuzzyScore(out[k].symbol, "S1");
    assert.ok(sCur > 0, "search applied");
    assert.ok(sPrev >= sCur, "ranked by match quality first");
    if (sPrev === sCur) {
      assert.ok(SC.scMetric(out[k - 1], "turnover24h") >= SC.scMetric(out[k], "turnover24h"),
        "sorted by turnover within equal match rank");
    }
  }
  assert.ok(elapsed < 2000, `10 full pipeline passes over 2000 symbols took ${elapsed}ms (must stay interactive)`);
}

// ---------------------------------------------------------------------------
// Journal core (journal.js) — the pure layer between exchange records and the
// review UI: identity, join, filters, queue semantics, stats, calendar,
// markdown safety. All DOM-free by the module's own contract.
// ---------------------------------------------------------------------------
{
  const jnConsts = ["JN_STATUSES", "JN_STATUS_LABELS", "JN_ID_RE", "JN_EXCERPT", "JN_PAGE"]
    .map(extractConst).join("\n");
  const jnFns = ["esc", "jnSanitizeViewState", "jnTradeId", "jnJoin", "jnDirection",
    "jnEffectiveStatus", "jnInQueue", "jnMatchesSearch", "jnFilterTrades", "jnSortTrades",
    "jnDayKey", "jnGroupDays", "jnMonthShift", "jnCalendarModel", "jnStats", "jnBreakdown",
    "jnScoreBuckets", "jnWordCount", "jnExcerptText", "jnListShape", "jnMarkdown"]
    .map(extractFn).join("\n");
  const JN = new Function(wsConsts + "\n" + jnConsts + "\n" + jnFns +
    "\nreturn { jnSanitizeViewState, jnTradeId, jnJoin, jnDirection, jnInQueue, jnFilterTrades, " +
    "jnSortTrades, jnDayKey, jnGroupDays, jnMonthShift, jnCalendarModel, jnStats, jnBreakdown, " +
    "jnScoreBuckets, jnWordCount, jnExcerptText, jnListShape, jnMarkdown };")();

  // Identity: the Closed-PnL natural id, charset-enforced like the backend.
  const row = (o) => ({ orderId: "ord1", updatedTime: "1700000000000", createdTime: "1699990000000",
    symbol: "BTCUSDT", side: "Sell", closedPnl: "25.5", qty: "1", avgEntryPrice: "100",
    avgExitPrice: "125", leverage: "10", ...o });
  assert.equal(JN.jnTradeId(row()), "ord1:1700000000000");
  assert.equal(JN.jnTradeId({ orderId: "", updatedTime: "1" }), null);
  assert.equal(JN.jnTradeId({ orderId: "a b", updatedTime: "1" }), null, "id charset enforced");

  // Join + direction (a Sell CLOSE means the position was long).
  const entries = [{ id: "ord1:1700000000000", tags: ["Breakout"], mistakes: ["Late Entry"],
    reviewStatus: "reviewed", hasNotes: true, noteWords: 5, notesExcerpt: "clean breakout",
    rating: 4, confidence: 3, strategy: "Momentum" }];
  const trades = JN.jnJoin(
    [row(), row({ orderId: "ord2", updatedTime: "1700000100000", side: "Buy", closedPnl: "-10" })],
    entries);
  assert.equal(trades.length, 2);
  assert.equal(JN.jnDirection(trades[0]), "long");
  assert.equal(JN.jnDirection(trades[1]), "short");
  assert.ok(trades[0].entry && trades[1].entry === null, "entries attach by id only");
  assert.equal(trades[0].durMs, 10000000, "hold time from createdTime→updatedTime");

  // Review-queue semantics: reviewed leaves the queue, unjournaled stays.
  assert.equal(JN.jnInQueue(trades[0]), false);
  assert.equal(JN.jnInQueue(trades[1]), true);

  // Filters combine as AND; search spans symbol/strategy/tags/notes.
  const V = (o) => JN.jnSanitizeViewState(o);
  assert.deepEqual(JN.jnFilterTrades(trades, V({ result: "win", tags: ["Breakout"] })).map((t) => t.id),
    ["ord1:1700000000000"]);
  assert.equal(JN.jnFilterTrades(trades, V({ search: "momentum breakout" })).length, 1);
  assert.equal(JN.jnFilterTrades(trades, V({ search: "zzz" })).length, 0);
  assert.equal(JN.jnFilterTrades(trades, V({ status: "queue" }))[0].id, "ord2:1700000100000");
  assert.equal(JN.jnFilterTrades(trades, V({ status: "noted" })).length, 1);
  assert.equal(JN.jnFilterTrades(trades, V({ mistake: "Late Entry" })).length, 1);
  assert.equal(JN.jnFilterTrades(trades, V({ confMin: 4 })).length, 0, "confidence 3 < min 4");
  assert.equal(JN.jnFilterTrades(trades, V({ side: "short" })).length, 1);
  assert.equal(JN.jnSortTrades(trades, "pnl", "desc")[0].pnl, 25.5);

  // Sanitizer: hostile/garbage view state coerces to safe defaults.
  const dirty = JN.jnSanitizeViewState({ view: "hack", range: "999", from: "20250101",
    search: 42, tags: ["ok", 7, "x".repeat(200)], confMin: 9, sort: "evil", dir: "up",
    status: "root", calMonth: "junk" });
  assert.equal(dirty.view, "overview");
  assert.equal(dirty.range, "30");
  assert.equal(dirty.from, "");
  assert.equal(dirty.search, "");
  assert.deepEqual(dirty.tags.map((t) => t.length <= 60), [true, true]);
  assert.equal(dirty.confMin, 0);
  assert.equal(dirty.sort, "time");
  assert.equal(dirty.dir, "desc");
  assert.equal(dirty.status, "all");
  assert.equal(dirty.calMonth, "");

  // Stats: totals, queue, profit factor, journaled coverage.
  const s = JN.jnStats(trades);
  assert.equal(s.count, 2);
  assert.equal(s.wins, 1);
  assert.ok(Math.abs(s.total - 15.5) < 1e-9);
  assert.ok(Math.abs(s.profitFactor - 2.55) < 1e-9);
  assert.equal(s.journaled, 1);
  assert.equal(s.queue, 1);
  assert.equal(s.avgRating, 4);

  // Day grouping + calendar (timezone-agnostic: keys derived via jnDayKey).
  const days = JN.jnGroupDays(JN.jnSortTrades(trades, "time", "desc"));
  assert.equal(days.length, 1, "trades 100s apart share a local day");
  assert.equal(days[0].trades.length, 2);
  const key = JN.jnDayKey(1700000000000);
  const cal = JN.jnCalendarModel(trades, key.slice(0, 7));
  assert.ok(cal.weeks.every((w) => w.length === 7), "Monday-first full weeks");
  const cell = cal.weeks.flat().find((c) => c.key === key);
  assert.ok(cell && cell.count === 2);
  assert.ok(Math.abs(cell.pnl - 15.5) < 1e-9);
  assert.equal(cell.noted, 1);
  assert.equal(JN.jnMonthShift("2026-01", -1), "2025-12");
  assert.equal(JN.jnMonthShift("2026-12", 1), "2027-01");

  // Breakdown + score buckets (the insights layer).
  assert.deepEqual(JN.jnBreakdown(trades, (t) => (t.entry && t.entry.tags) || []),
    [{ label: "Breakout", count: 1, wins: 1, pnl: 25.5 }]);
  assert.equal(JN.jnScoreBuckets(trades, "confidence")[2].count, 1, "confidence 3 → bucket 3");

  // Notes helpers: word count, excerpting, list-shape mirror of the server.
  assert.equal(JN.jnWordCount("one  two\nthree"), 3);
  assert.equal(JN.jnWordCount(""), 0);
  const long = "word ".repeat(100).trim();
  assert.ok(JN.jnExcerptText(long).endsWith("…") && JN.jnExcerptText(long).length <= 241);
  const shaped = JN.jnListShape({ id: "x", notes: long, lessons: "", tags: [] });
  assert.equal(shaped.notes, undefined, "list shape must never carry full text");
  assert.equal(shaped.noteWords, 100);
  assert.equal(shaped.hasNotes, true);
  assert.equal(shaped.hasLessons, false);

  // Markdown-lite: escape-first — injected tags can never survive.
  const html = JN.jnMarkdown("# Head\n- item **bold**\n> quote\n<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "raw tags are escaped, never rendered");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<h4"));
  assert.ok(html.includes("<li>item <strong>bold</strong></li>"));
  assert.ok(html.includes("<blockquote>"));
}

// ---------------------------------------------------------------------------
// AI coach core (ai.js) — the pure layer: view-state sanitizer (the workspace
// trust boundary) and the SSE protocol parser the streaming answers ride on.
// ---------------------------------------------------------------------------
{
  const aiConsts = ["AI_VIEWS", "AI_RANGES", "AI_PERIODS"].map(extractConst).join("\n");
  const aiFns = ["aiSanitizeViewState", "aiSseParse"].map(extractFn).join("\n");
  const AI = new Function(aiConsts + "\n" + aiFns +
    "\nreturn { aiSanitizeViewState, aiSseParse };")();

  // Sanitizer: hostile/garbage state coerces to safe defaults.
  const dirty = AI.aiSanitizeViewState({
    view: "sudo", range: 30, period: "year", convSearch: 42, extra: "dropped",
  });
  assert.deepEqual(dirty, { view: "briefing", range: "30", period: "day", convSearch: "" });
  const ok = AI.aiSanitizeViewState({ view: "patterns", range: "90", period: "week", convSearch: "x".repeat(100) });
  assert.equal(ok.view, "patterns");
  assert.equal(ok.range, "90");
  assert.equal(ok.convSearch.length, 60);

  // SSE parser: complete events extracted, partial frames kept as remainder.
  const chunk1 = 'data: {"type":"start","conversationId":"abc"}\n\n' +
    'data: {"type":"delta","text":"Hel"}\n\ndata: {"type":"del';
  const p1 = AI.aiSseParse(chunk1);
  assert.equal(p1.events.length, 2);
  assert.equal(p1.events[0].type, "start");
  assert.equal(p1.events[1].text, "Hel");
  assert.equal(p1.rest, 'data: {"type":"del');
  const p2 = AI.aiSseParse(p1.rest + 'ta","text":"lo"}\n\ndata: {"type":"done"}\n\n');
  assert.deepEqual(p2.events.map((e) => e.type), ["delta", "done"]);
  assert.equal(p2.rest, "");
  // Garbled frames are skipped, never thrown.
  const p3 = AI.aiSseParse("data: {not json}\n\ndata: {\"type\":\"done\"}\n\n");
  assert.deepEqual(p3.events.map((e) => e.type), ["done"]);
}

// ---------------------------------------------------------------------------
// Execution-workspace core (exec.js) — ladder building, order lifecycle,
// execution stats, break-even and preview math. This is money-adjacent
// display math: a wrong ladder bucket or preview number misleads a live
// trader, so every formula gets a known-answer test.
// ---------------------------------------------------------------------------
{
  const exConsts = ["EX_GROUPINGS", "EX_ROWS_OPTIONS", "EX_ORDER_SORTS", "EX_ORDER_SIDES",
    "EX_STATUS_LABELS"].map(extractConst).join("\n");
  const exFns = ["exSanitizeViewState", "exBucket", "exBuildLadder", "exOrderTimeline",
    "exExecStats", "exBreakEven", "exTicketPreview", "exPositionInsights"]
    .map(extractFn).join("\n");
  const EX = new Function(exConsts + "\n" + exFns +
    "\nreturn { exSanitizeViewState, exBucket, exBuildLadder, exOrderTimeline, " +
    "exExecStats, exBreakEven, exTicketPreview, exPositionInsights };")();

  // Sanitizer: hostile state coerces to safe defaults.
  const dirty = EX.exSanitizeViewState({ grouping: "3", rows: 99, follow: "no",
    orders: { side: "Both", search: 42, sort: "evil", dir: "up" } });
  assert.deepEqual(dirty, { grouping: "1", rows: "12", follow: true,
    orders: { side: "all", search: "", sort: "time", dir: "desc" } });
  assert.equal(EX.exSanitizeViewState({ follow: false }).follow, false);

  // Bucketing: bids floor, asks ceil — grouped levels never cross the spread.
  assert.equal(EX.exBucket(100.07, 0.05, true), 100.05);
  assert.equal(EX.exBucket(100.07, 0.05, false), 100.1);
  assert.equal(EX.exBucket(100.05, 0.05, true), 100.05, "exact boundary stays put");
  assert.equal(EX.exBucket(100.05, 0.05, false), 100.05);

  // Ladder: cumulative sums, display ordering, spread, bar scales.
  const book = { result: {
    b: [["100.0", "2"], ["99.9", "3"], ["99.8", "5"]],
    a: [["100.1", "1"], ["100.2", "4"], ["100.3", "2"]],
  } };
  const ladder = EX.exBuildLadder(book, { tick: 0.1, grouping: "1", rows: 3, last: 100.05, mark: 100.02 });
  assert.equal(ladder.bestBid, 100.0);
  assert.equal(ladder.bestAsk, 100.1);
  assert.ok(Math.abs(ladder.spread - 0.1) < 1e-9);
  assert.deepEqual(ladder.bids.map((r) => r.cum), [2, 5, 10], "cumulative from best outward");
  assert.deepEqual(ladder.asks.map((r) => r.price), [100.3, 100.2, 100.1], "asks render worst→best");
  assert.equal(ladder.asks[2].cum, 1, "best ask is the last displayed ask row");
  assert.equal(ladder.totalBid, 10);
  assert.equal(ladder.totalAsk, 7);
  const grouped = EX.exBuildLadder(book, { tick: 0.1, grouping: "2", rows: 5 });
  assert.deepEqual(grouped.bids.map((r) => [r.price, r.size]), [[100, 2], [99.8, 8]],
    "grouping merges bid levels downward");
  assert.deepEqual(grouped.asks.slice().reverse().map((r) => [r.price, r.size]),
    [[100.2, 5], [100.4, 2]], "grouping merges ask levels upward");
  // Garbage levels are dropped, never NaN rows.
  const dirtyLadder = EX.exBuildLadder({ result: { b: [["x", "1"], ["100", "0"]], a: null } }, {});
  assert.equal(dirtyLadder.bids.length + dirtyLadder.asks.length, 0);

  // Order lifecycle: created → fills (matched by orderId, funding excluded) →
  // terminal status; fill progress from the venue's own counters.
  const order = { orderId: "o1", createdTime: "1000", updatedTime: "5000",
    orderStatus: "PartiallyFilled", qty: "10", cumExecQty: "4" };
  const fills = [
    { orderId: "o1", execTime: "2000", execQty: "1", execPrice: "100", isMaker: "true" },
    { orderId: "o1", execTime: "3000", execQty: "3", execPrice: "101" },
    { orderId: "o2", execTime: "2500", execQty: "9", execPrice: "50" },
    { orderId: "o1", execTime: "2600", execQty: "0.1", execPrice: "0", execType: "Funding" },
  ];
  const tl = EX.exOrderTimeline(order, fills);
  assert.deepEqual(tl.events.map((e) => e.kind), ["created", "fill", "fill", "status"]);
  assert.equal(tl.events[1].maker, true);
  assert.equal(tl.progress.pct, 40);

  // Execution stats: maker %, volume, fees, weighted entry/exit.
  const stats = EX.exExecStats(
    [
      { orderId: "a", execQty: "1", execPrice: "100", execValue: "100", execFee: "0.05", isMaker: true },
      { orderId: "a", execQty: "1", execPrice: "102", execValue: "102", execFee: "0.06" },
      { orderId: "b", execQty: "2", execPrice: "50", execValue: "100", execFee: "0.04" },
      { execQty: "5", execPrice: "1", execType: "Funding", execFee: "0.9" },
    ],
    [
      { qty: "2", avgEntryPrice: "100", avgExitPrice: "110", closedPnl: "20" },
      { qty: "2", avgEntryPrice: "200", avgExitPrice: "190", closedPnl: "-20" },
    ]);
  assert.equal(stats.fills, 3);
  assert.equal(stats.orders, 2);
  assert.equal(stats.makerPct, 33.3);
  assert.ok(Math.abs(stats.volume - 302) < 1e-9);
  assert.ok(Math.abs(stats.fees - 0.15) < 1e-9, "funding fee excluded from trade fees");
  assert.equal(stats.avgFillPrice, 75.5); // (100+102+100)/4 qty
  assert.equal(stats.avgEntry, 150);
  assert.equal(stats.avgExit, 150);
  assert.equal(stats.closeWinPct, 50);

  // Break-even: taker both ways; long above entry, short below.
  const beLong = EX.exBreakEven(100, "Buy", 0.00035);
  assert.ok(beLong > 100 && Math.abs(beLong - 100 * 1.00035 / 0.99965) < 1e-6);
  const beShort = EX.exBreakEven(100, "Sell", 0.00035);
  assert.ok(beShort < 100);
  assert.equal(EX.exBreakEven("junk", "Buy", 0.0003), null);

  // Ticket preview: margin, fee, leverage-only liq bound, post-trade position,
  // bracket R:R.
  const prev = EX.exTicketPreview({
    side: "Buy", qty: 2, price: 100, leverage: 10, feeRate: 0.00035,
    tp: 110, sl: 95, positionQty: 1, positionSide: "Sell",
  });
  assert.equal(prev.notional, 200);
  assert.equal(prev.margin, 20);
  assert.ok(Math.abs(prev.fee - 0.07) < 1e-9);
  assert.equal(prev.liqEstimate, 90, "long liq bound = price × (1 − 1/lev)");
  assert.deepEqual(prev.position, {
    beforeQty: -1, afterQty: 1, afterSide: "long", reduces: true, flips: true,
  });
  assert.equal(prev.projectedProfit, 20);
  assert.equal(prev.projectedLoss, 10);
  assert.equal(prev.riskReward, 2);
  assert.equal(EX.exTicketPreview({ side: "Buy", qty: 0, price: 100 }), null);

  // Position insights: ROE on the exchange's own IM; holding time; BE.
  const ins = EX.exPositionInsights(
    { avgPrice: "100", size: "3", side: "Buy", unrealisedPnl: "15",
      positionIM: "30", createdTime: "1000" },
    { feeRate: 0.00035, nowMs: 61000, fundingPaid: "0.5", feesPaid: "0.2" });
  assert.equal(ins.roePct, 50);
  assert.equal(ins.holdingMs, 60000);
  assert.equal(ins.notional, 300);
  assert.ok(ins.breakEven > 100);

  // Performance guard: a deep book rebuild must stay interactive.
  const big = { result: { b: [], a: [] } };
  for (let i = 0; i < 500; i++) {
    big.result.b.push([String(50000 - i * 0.5), String((i % 9) + 1)]);
    big.result.a.push([String(50000.5 + i * 0.5), String((i % 7) + 1)]);
  }
  const t0 = Date.now();
  for (let k = 0; k < 200; k++) {
    EX.exBuildLadder(big, { tick: 0.5, grouping: "5", rows: 24, last: 50000, mark: 50000 });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `200 rebuilds of a 1000-level book took ${elapsed}ms (must stay ≪ 16ms each)`);
}

// ---------------------------------------------------------------------------
// theme-core — the dark/light resolution rules. The DEFAULT MUST STAY DARK:
// an unset or corrupt preference has to render the UI the app has always had,
// never a half-applied light paint.
// ---------------------------------------------------------------------------
{
  const T = new Function(
    extractFn("themeFromStored") + "\n" + extractFn("nextTheme") +
    "\nreturn { themeFromStored, nextTheme };"
  )();

  // Explicit preferences win regardless of what the OS reports.
  assert.equal(T.themeFromStored("light", false), "light");
  assert.equal(T.themeFromStored("light", true), "light");
  assert.equal(T.themeFromStored("dark", true), "dark");
  assert.equal(T.themeFromStored("dark", false), "dark");

  // "system" follows the media query in both directions.
  assert.equal(T.themeFromStored("system", true), "light");
  assert.equal(T.themeFromStored("system", false), "dark");

  // Anything else -> dark. Covers a fresh browser (null), a wiped value, and
  // junk from another app/version sharing the origin.
  for (const junk of [null, undefined, "", "Light", "LIGHT", "sepia", "0", "{}", 1]) {
    assert.equal(T.themeFromStored(junk, false), "dark");
    assert.equal(T.themeFromStored(junk, true), "dark",
      "an unrecognized preference must NOT silently adopt the OS scheme");
  }

  // The button is a plain two-state flip on what is currently rendered.
  assert.equal(T.nextTheme("dark"), "light");
  assert.equal(T.nextTheme("light"), "dark");
  // Flipping twice returns to the start (no third state to get stuck in).
  assert.equal(T.nextTheme(T.nextTheme("dark")), "dark");
}

// ---------------------------------------------------------------------------
// pnl-core (pnl.js) — range sanitizing + axis-tick math for the uPnL chart.
// ---------------------------------------------------------------------------
{
  const P = new Function(
    `const PN_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"];\n` +
    extractFn("pnSanitizeRange") + "\n" + extractFn("pnNiceTicks") +
    "\n" + extractFn("pnTickDecimals") +
    "\nreturn { pnSanitizeRange, pnNiceTicks, pnTickDecimals };"
  )();

  // Only known ranges survive; junk (old keys, other apps' values) -> default.
  assert.equal(P.pnSanitizeRange("24h"), "24h");
  assert.equal(P.pnSanitizeRange("all"), "all");
  for (const junk of [null, undefined, "", "2h", "1H", "ALL", 42, "{}"]) {
    assert.equal(P.pnSanitizeRange(junk), "6h");
  }

  // Ticks: cover the domain, ordered, include an exact 0 when 0 is in range
  // (the zero gridline must pair with the chart's green/red split).
  const ticks = P.pnNiceTicks(-37.4, 82.1, 5);
  assert.ok(ticks.length >= 2 && ticks.length <= 9);
  assert.ok(ticks.includes(0), "zero must be an exact tick when in range");
  assert.ok(ticks[0] >= -37.4 - 1e-9 && ticks[ticks.length - 1] <= 82.1 + 1e-9);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
  // A flat series must still produce ticks (the domain is padded, not divided by 0).
  assert.ok(P.pnNiceTicks(5, 5, 5).length >= 2);
  assert.deepEqual(P.pnNiceTicks(NaN, 10, 5), []);

  // Label precision follows the step size.
  assert.equal(P.pnTickDecimals(50), 0);
  assert.equal(P.pnTickDecimals(2.5), 1);
  assert.equal(P.pnTickDecimals(0.25), 2);
}

console.log("snapToStep + projectedPnl + workspace-core + watchlist-core + scanner-core + journal-core + ai-core + exec-core + theme-core + pnl-core regression tests passed");
