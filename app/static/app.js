"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const settleCoin = () => state.settleCoin || "USDT";
// tradeToken is held ONLY in memory for this tab — never persisted.
const state = {
  role: null,
  settleCoin: "USDT",
  currency: "USDT", // display lens: "USDT" | "INR" (read-only views only)
  tradeToken: "",
  writeInFlight: false,
  orderLastPrice: null,
  symbolLeverage: null, // { symbol, leverage } — the exchange's real leverage for the order-ticket symbol
  prevPos: {},
  lastPositions: [],
  lastOrders: [],
  expandedPos: new Set(),
  expandedOrders: new Set(),
  sortPos: { key: null, dir: 1 },
  sortOrders: { key: null, dir: 1 },
  // --- account snapshot (read-only; for sizing + confirm context) ---
  available: null,
  equity: null,
  // --- order-ticket / market-data context ---
  activeSymbol: "",
  specs: {}, // symbol -> { tickSize, qtyStep, minOrderQty, maxOrderQty, maxLeverage }
  lastExplorer: null, // { render, data } of the last API Explorer query, for re-render on currency toggle
  // --- live-feed health (staleness watchdog) ---
  connState: "connecting", // connecting | live | off
  connDegraded: false,
  feedError: null,
  lastFrameAt: null,
  frameGaps: [], // recent inter-frame gaps (seconds) for an adaptive threshold
};

// ---------------------------------------------------------------------------
// Notification center: every toast is ALSO recorded here (newest first, last
// 50), so a missed 4.5s toast is never lost information. In-memory only by
// design — entries can carry money figures, so nothing persists past the tab;
// rendered text is `.priv` so privacy mode masks the log like everything else.
// ---------------------------------------------------------------------------
const _notifLog = [];
const _NOTIF_MAX = 50;
let _notifUnread = 0;

function recordNotification(msg, type) {
  _notifLog.unshift({ ts: Date.now(), type: type || "info", msg: String(msg) });
  if (_notifLog.length > _NOTIF_MAX) _notifLog.pop();
  const panel = document.getElementById("notif-panel");
  if (panel && !panel.hidden) renderNotifList();
  else { _notifUnread++; paintNotifBadge(); }
}

function paintNotifBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  badge.hidden = _notifUnread === 0;
  badge.textContent = _notifUnread > 9 ? "9+" : String(_notifUnread);
}

function renderNotifList() {
  const listEl = document.getElementById("notif-list");
  if (!listEl) return;
  listEl.innerHTML = _notifLog.length
    ? _notifLog.map((n) =>
        `<div class="notif-item"><span class="dot ${esc(n.type)}"></span>` +
        `<div class="nt"><span class="msg priv">${esc(n.msg)}</span>` +
        `<span class="t">${new Date(n.ts).toLocaleTimeString()}</span></div></div>`
      ).join("")
    : `<div class="notif-empty muted">No notifications this session.</div>`;
}

function wireNotifCenter() {
  const btn = document.getElementById("notif-btn");
  const panel = document.getElementById("notif-panel");
  if (!btn || !panel) return;
  const close = () => { panel.hidden = true; };
  btn.addEventListener("click", () => {
    if (panel.hidden) {
      _notifUnread = 0;
      paintNotifBadge();
      renderNotifList();
      panel.hidden = false;
    } else close();
  });
  const clearBtn = document.getElementById("notif-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { _notifLog.length = 0; renderNotifList(); });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });
}

// Non-blocking toast notifications for action outcomes.
function toast(msg, type = "info", ms = 4500) {
  if (!msg) return;
  recordNotification(msg, type);
  // Errors/warnings go to an assertive alert region so a failed or blocked action
  // interrupts a screen reader instead of queuing politely (and possibly expiring
  // before it is read); info/success stay polite.
  const assertive = type === "neg" || type === "warn";
  const wrap = document.getElementById(assertive ? "toasts-alert" : "toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  // Prefix severity so it isn't carried by the left-border colour alone.
  const prefix = type === "neg" ? "Error: " : type === "warn" ? "Warning: " : "";
  el.textContent = prefix + msg;
  el.title = "Dismiss";
  wrap.appendChild(el);
  // Cap the stack so a burst of fills/errors can never bury the order rail's Submit.
  while (wrap.children.length > 4) wrap.firstChild.remove();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener("click", remove); // click to dismiss
  setTimeout(remove, ms);
}

// Client-side sort of an array of objects by a key (auto numeric vs string).
function applySort(rows, sortState) {
  if (!sortState || !sortState.key) return rows;
  const k = sortState.key;
  const dir = sortState.dir;
  return rows.slice().sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    const an = Number(av);
    const bn = Number(bv);
    const numeric = av !== "" && bv !== "" && isFinite(an) && isFinite(bn);
    if (numeric) return (an - bn) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

// Reflect the active sort column/direction on the (static) table headers.
function updateSortIndicators() {
  [["#positions-table", state.sortPos], ["#orders-table", state.sortOrders]].forEach(([sel, st]) => {
    const tbl = document.querySelector(sel);
    if (!tbl) return;
    tbl.querySelectorAll("thead th[data-sortkey]").forEach((th) => {
      const active = th.dataset.sortkey === st.key;
      th.setAttribute("data-dir", active ? (st.dir > 0 ? "asc" : "desc") : "");
      th.setAttribute("aria-sort", active ? (st.dir > 0 ? "ascending" : "descending") : "none");
      // Make headers keyboard-operable (idempotent — runs every render).
      if (!th.hasAttribute("tabindex")) {
        th.setAttribute("tabindex", "0");
        th.setAttribute("role", "button");
      }
    });
  });
}

// Small key/value detail grid for an expanded row. Skips empty values. A third
// truthy tuple element ([k, v, true]) marks that value as a private account
// figure, so the privacy toggle masks it (money/size) while leaving neutral
// fields like ids, modes and timestamps readable.
function detailGrid(pairs) {
  const items = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "—")
    .map(([k, v, priv]) => `<div><span class="dt-k">${esc(k)}</span><span class="dt-v mono${priv ? " priv" : ""}">${esc(v)}</span></div>`)
    .join("");
  return `<div class="detail-grid">${items || '<span class="muted">No extra detail.</span>'}</div>`;
}

// Assign a tbody's HTML only when it actually CHANGED. The live feed re-renders
// every poll tick, but between ticks the markup is often byte-identical (idle
// orders table, PnL flat at display precision) — and a needless innerHTML swap
// tears down the DOM subtree, kills any text selection the user has open, and
// costs a reparse+layout for zero visual change. Building the string is cheap;
// comparing it is the dirty-check (same pattern as the chart SVG signature).
const _tbodyCache = new WeakMap();
function setTbodyHTML(body, html) {
  if (_tbodyCache.get(body) === html) return;
  _tbodyCache.set(body, html);
  body.innerHTML = html;
}

// Skeleton shimmer rows for the initial loading state.
function renderLoading() {
  const skel = (cols) =>
    Array.from({ length: 5 }, () =>
      "<tr>" + Array.from({ length: cols }, () => '<td><span class="skel"></span></td>').join("") + "</tr>"
    ).join("");
  const admin = state.role === "admin";
  const pb = document.getElementById("positions-body");
  const ob = document.getElementById("orders-body");
  if (pb) setTbodyHTML(pb, skel(admin ? 12 : 11));
  if (ob) setTbodyHTML(ob, skel(admin ? 8 : 7));
}

// Pick the account object from a wallet-balance payload that actually carries
// the totals we need (defensive — never assume list[0]).
function walletAccount(balance) {
  const list = balance?.result?.list || [];
  for (const acct of list) {
    if (acct && (acct.totalEquity !== undefined || acct.totalWalletBalance !== undefined)) return acct;
  }
  return list[0] || null;
}

// Global single-flight lock for ALL write actions. The live tables are rebuilt
// via innerHTML every few seconds, which destroys the button nodes a per-button
// `disabled` flag lives on — so that flag alone can't prevent a duplicate
// close/cancel across a re-render. This lock spans the whole click→confirm→send
// lifecycle, so only one write can ever be in progress at a time.
async function withWriteLock(fn) {
  if (state.writeInFlight) {
    toast("Another trading action is in progress — please wait.", "warn");
    return;
  }
  state.writeInFlight = true;
  try {
    return await fn();
  } finally {
    state.writeInFlight = false;
  }
}

// Escape any exchange-/server-controlled string before putting it into HTML.
// Exchange data (symbol, side, orderStatus, …) is untrusted and is rendered
// via innerHTML below — without this, a crafted value could execute script in
// the admin's authenticated tab (which holds the in-memory trade token).
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtNum(value, digits = 2) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Consistent percent formatting (single source so sign/precision never drift).
function fmtPct(n, withSign = true) {
  if (!isFinite(n)) return "";
  return `${withSign && n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Money/PnL formatting that ALWAYS carries an explicit sign, so a gain and a
// loss are never distinguishable by colour alone (accessibility + glance-safety
// on a real-money tool). A real minus sign (U+2212) aligns better in columns.
function fmtSigned(value, digits = 2) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  const body = fmtNum(Math.abs(n), digits);
  if (n > 0) return "+" + body;
  if (n < 0) return "−" + body;
  return body;
}

// --- Currency display lens --------------------------------------------------
// INR mode shows every READ-side USDT value ×INR_RATE, labelled INR. It is a
// pure display transform: WRITE surfaces (order ticket, TP/SL & confirm modals,
// transfer, and the rail order book that click-fills the USDT price input) ALWAYS
// stay in USDT, because orders are sent to the exchange in USDT. Only currency
// amounts and prices convert — never quantities (base coin), leverage, counts,
// times, or percentages/ratios (which are currency-invariant).
// Default matches the server's INR_RATE default; overwritten from /api/me at
// boot (loadMe) so the deployed rate is configured in ONE place (the env).
let INR_RATE = 94;
function rate() { return state.currency === "INR" ? INR_RATE : 1; }
function curUnit() { return state.currency === "INR" ? "INR" : settleCoin(); }
function cvtNum(v) { const n = Number(v); return isFinite(n) ? n * rate() : NaN; }
// Converting formatters for the already-formatted dashboard cells. In USDT mode
// rate()===1, so output is byte-identical to fmtNum / fmtSigned.
function fmtMoney(v, digits = 2) { return fmtNum(cvtNum(v), digits); }
function fmtMoneySigned(v, digits = 2) { return fmtSigned(cvtNum(v), digits); }
// For explorer/markets tables that print RAW exchange strings: leave them
// untouched in USDT mode (no formatting regression); convert + format only in
// INR mode, preserving the value's own decimal precision unless overridden.
function cvtCell(v, digits) {
  // Returns SAFE HTML for innerHTML/raw-column contexts. USDT mode: escaped raw
  // value (byte-identical to main). INR mode: numeric string (already safe).
  if (state.currency !== "INR") return esc(cell(v));
  const n = Number(v);
  if (!isFinite(n)) return esc(cell(v));
  const d = digits != null ? digits : decimalsOf(v);
  return fmtNum(n * INR_RATE, d);
}

// Funding rate as a signed percentage (the API returns a raw decimal, e.g.
// 0.0001 = +0.0100%). Returns safe HTML coloured by sign for buildTable raw cells.
function fmtFundingHTML(value) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  const pctVal = n * 100;
  const sign = pctVal > 0 ? "+" : pctVal < 0 ? "−" : "";
  return `<span class="${pnlClass(n)}">${sign}${Math.abs(pctVal).toFixed(4)}%</span>`;
}

// Human feed-age label for the connection pill.
function fmtAge(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Decimal places implied by a step string (e.g. "0.001" -> 3) so snapped
// quantities/prices render at the instrument's own precision. Handles
// exponential notation ("1e-7" -> 7) defensively, though exchanges normally
// return plain decimals.
function decimalsOf(step) {
  let s = String(step);
  if (/e/i.test(s)) {
    const n = Number(step);
    if (!isFinite(n)) return 0;
    s = n.toFixed(20); // expand exponential into fixed notation
  }
  const i = s.indexOf(".");
  if (i < 0) return 0;
  s = s.replace(/0+$/, ""); // trim trailing zeros from the expanded form
  return Math.max(0, s.length - i - 1);
}

// Floor `value` to the nearest multiple of `step` (used by the %-sizing helper).
// Returns a string at the step's precision. Returns null if step is unusable.
function snapToStep(value, step) {
  const v = Number(value);
  const st = Number(step);
  if (!(v >= 0) || !(st > 0)) return null;
  // Add a tiny epsilon before flooring so IEEE-754 division error doesn't drop a
  // whole lot step: e.g. 0.3 / 0.1 === 2.9999999999999996, which would floor to 2
  // and silently under-size the order by a full step. The epsilon is far smaller
  // than any real step, so it never rounds a genuinely-below value up.
  const snapped = Math.floor(v / st + 1e-9) * st;
  return snapped.toFixed(decimalsOf(step));
}

// --- Projected PnL at a TP/SL price ---------------------------------------
// Bybit exposes no projected-PnL field, so we compute it. For LINEAR (USDT)
// contracts the gross result of exiting `size` at `exitPrice` is
// (exit - entry) * size for a long (sign-flipped for a short) — this is exactly
// Bybit's documented closedPnl = cumExitValue - cumEntryValue (minus fees),
// where cumValue = price * qty for linear.
//
// Fee policy (per account): taker 0.035%, maker 0.014%. TP/SL in Full mode
// trigger MARKET exits, so the exit fee is the TAKER fee. We subtract ONLY the
// exit fee (the entry fee is already reflected in an existing position's
// realised PnL, and is excluded for new orders by request).
// Account fee rate confirmed 2026-06 (taker tier). TP/SL in Full mode are
// MARKET exits, so the exit leg always pays the TAKER fee. This rate affects
// ONLY the displayed projected-PnL estimate — never an order/TP/SL we send.
// If the account's fee tier changes, update this value.
const TAKER_FEE_RATE = 0.00035; // 0.035%
// Maker tier for the same account (see the taker note above). Used ONLY for
// the entry-fee estimate in the ticket — never in anything sent to the venue.
const MAKER_FEE_RATE = 0.00014; // 0.014%

// Returns { net, gross, exitFee, roi } or null if inputs are incomplete.
// roi is null when leverage is unknown (e.g. the order form).
function projectedPnl({ side, entry, exitPrice, size, leverage }) {
  const e = Number(entry);
  const x = Number(exitPrice);
  const q = Number(size);
  if (!(e > 0) || !(x > 0) || !(q > 0)) return null;
  const isLong = String(side).toLowerCase() === "buy";
  const gross = isLong ? (x - e) * q : (e - x) * q;
  const exitFee = x * q * TAKER_FEE_RATE; // market exit => taker
  const net = gross - exitFee;
  let roi = null;
  const lev = Number(leverage);
  if (lev > 0) {
    const margin = (e * q) / lev;
    if (margin > 0) roi = (net / margin) * 100;
  }
  return { net, gross, exitFee, roi };
}

// Single source of truth for the colored "<net> (<roi>%)" markup, shared by the
// table badge, the TP/SL modal preview and the order-form preview so they can
// never diverge. `r` is a projectedPnl() result.
// `convert` defaults to true (read context, e.g. the positions table). Write
// surfaces (order form + TP/SL modal previews) pass false to stay in USDT. ROI%
// is a ratio and never converts.
function projAmount(r, withRoi, convert = true) {
  if (!r) return "";
  const roi =
    withRoi && r.roi != null ? ` (${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(2)}%)` : "";
  const amt = convert ? fmtMoneySigned(r.net) : fmtSigned(r.net);
  return `<span class="${pnlClass(r.net)}">${amt}${roi}</span>`;
}

// Small projected net PnL (ROI%) badge for a table cell.
function projHintHTML(args) {
  const r = projectedPnl(args);
  if (!r) return "";
  return `<div class="pnl-hint">${projAmount(r, true)}</div>`;
}

function pnlClass(value) {
  const n = Number(value);
  if (!isFinite(n) || n === 0) return "flat";
  return n > 0 ? "pos" : "neg";
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error || `Request failed (${res.status})`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    // Money-path callers need to distinguish a DEFINITIVE 4xx rejection from an
    // INDETERMINATE 5xx (e.g. the transfer idempotency-key lifecycle below).
    err.status = res.status;
    throw err;
  }
  return data;
}

// All WRITE operations go through here: requires the trade token to be present
// and attaches it as the X-Trade-Token header. The server independently
// verifies it; this is the client-side gate + transport.
async function writeApi(path, body) {
  if (!state.tradeToken) {
    throw new Error("Enter the trade token to unlock trading.");
  }
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trade-Token": state.tradeToken },
    body: JSON.stringify(body || {}),
  });
}

// Client-owned idempotency keys for fund transfers, keyed by transfer INTENT
// (direction|amount|asset) and kept until that transfer resolves DEFINITIVELY:
//  * confirmed success  -> cleared (a later identical transfer is a new intent);
//  * definitive 4xx     -> cleared (the exchange evaluated and REFUSED — reusing
//    the key after fixing the cause could be replay-deduped into a no-op);
//  * indeterminate 5xx / network error -> KEPT, so the retry reuses the SAME
//    key and the exchange dedups instead of moving funds twice.
// Persisted per-tab in sessionStorage so a page refresh during that uncertainty
// window cannot mint a fresh key for the same unresolved intent.
const _TXN_STORE_KEY = "dma.transferTxnIds";
const _transferTxnIds = (() => {
  try { return JSON.parse(sessionStorage.getItem(_TXN_STORE_KEY) || "{}") || {}; }
  catch (e) { return {}; }
})();
function _persistTxnIds() {
  try { sessionStorage.setItem(_TXN_STORE_KEY, JSON.stringify(_transferTxnIds)); } catch (e) {}
}
function _uuid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback (non-secure contexts): unique enough for a client idempotency key.
  return "txn-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function transferTxnId(intentKey) {
  if (!_transferTxnIds[intentKey]) {
    _transferTxnIds[intentKey] = _uuid();
    _persistTxnIds();
  }
  return _transferTxnIds[intentKey];
}
function clearTransferTxnId(intentKey) {
  delete _transferTxnIds[intentKey];
  _persistTxnIds();
}

// Build the confirm-modal body. A plain string is shown as-is (textContent,
// safe); a { head, lines:[[k,v]], note } object renders a small escaped
// key/value summary so high-stakes writes show notional / PnL / size at a glance.
function setConfirmMessage(message) {
  const el = $("#confirm-message");
  if (!el) return;
  if (message && typeof message === "object") {
    const head = message.head ? `<p class="cm-head">${esc(message.head)}</p>` : "";
    const lines = (message.lines || [])
      .map(([k, v]) => `<div class="cm-line"><span class="cm-k">${esc(k)}</span><span class="cm-v">${esc(v)}</span></div>`)
      .join("");
    const note = message.note ? `<p class="muted" style="margin:8px 0 0">${esc(message.note)}</p>` : "";
    el.innerHTML = head + lines + note;
  } else {
    el.textContent = String(message ?? "");
  }
}

// Keep Tab focus inside an open modal; returns a function to remove the trap.
function focusTrap(container) {
  if (!container) return () => {};
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = Array.from(container.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener("keydown", onKey);
  return () => container.removeEventListener("keydown", onKey);
}

// Restore focus to the element that had it before a modal opened.
function restoreFocus(prev) {
  if (prev && typeof prev.focus === "function" && document.contains(prev)) {
    try { prev.focus(); } catch (e) { /* element no longer focusable */ }
  }
}

// Typed-confirm modal: the user must type the word "confirm" to proceed.
// Resolves false on cancel; on proceed resolves { percent } (100 unless the
// caller passed opts.percents and the user picked a different portion) — an
// object, so every existing truthiness check (`if (!ok)`) works unchanged.
// opts.percents: optional array of portion buttons (e.g. [25,50,75,100]);
// opts.hint(pct): optional per-selection helper line rendered under them.
let _confirmOpen = false;
function typedConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    // Only one confirm modal may be open at a time. A second trigger (e.g.
    // clicking another Close button) is ignored rather than stacking listeners
    // on the shared overlay, which could otherwise fire two writes at once.
    if (_confirmOpen) {
      resolve(false);
      return;
    }
    _confirmOpen = true;
    const overlay = $("#confirm-overlay");
    const input = $("#confirm-input");
    const proceed = $("#confirm-proceed");
    const cancel = $("#confirm-cancel");
    const choices = $("#confirm-choices");
    const prevFocus = document.activeElement;
    setConfirmMessage(message);

    // Optional portion buttons (percent values are our own constants, not data).
    // opts.defaultPercent only changes which choice starts highlighted — the
    // typed "confirm" ceremony is identical either way.
    let percent = Array.isArray(opts.percents) && opts.percents.includes(opts.defaultPercent)
      ? opts.defaultPercent : 100;
    const paintChoices = () => {
      choices.querySelectorAll("button[data-pct]").forEach((b) => {
        const on = Number(b.dataset.pct) === percent;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const hintEl = choices.querySelector(".choices-hint");
      if (hintEl) hintEl.textContent = opts.hint ? opts.hint(percent) : "";
    };
    const onChoice = (e) => {
      const b = e.target.closest("button[data-pct]");
      if (!b) return;
      percent = Number(b.dataset.pct);
      paintChoices();
    };
    if (choices) {
      if (Array.isArray(opts.percents) && opts.percents.length) {
        choices.hidden = false;
        choices.innerHTML =
          `<div class="choices-btns" role="group" aria-label="Portion to apply">` +
          opts.percents
            .map((p) => `<button type="button" data-pct="${Number(p)}" title="${esc(Number(p) === 100 ? "Apply to the whole position" : "Apply to " + Number(p) + "% of the position")}" aria-pressed="${Number(p) === percent}">${Number(p) === 100 ? "Full" : Number(p) + "%"}</button>`)
            .join("") +
          `</div><div class="choices-hint muted"></div>`;
        choices.addEventListener("click", onChoice);
        paintChoices();
      } else {
        choices.hidden = true;
        choices.innerHTML = "";
      }
    }

    input.value = "";
    proceed.disabled = true;
    overlay.hidden = false;
    input.focus();
    const untrap = focusTrap(overlay.querySelector(".modal"));

    const cleanup = (result) => {
      overlay.hidden = true;
      input.removeEventListener("input", onInput);
      proceed.removeEventListener("click", onProceed);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlay);
      if (choices) {
        choices.removeEventListener("click", onChoice);
        choices.hidden = true;
        choices.innerHTML = ""; // never leak stale portion buttons into the next confirm
      }
      untrap();
      restoreFocus(prevFocus);
      _confirmOpen = false;
      resolve(result ? { percent } : false);
    };
    const isValid = () => input.value.trim().toLowerCase() === "confirm";
    const onInput = () => { proceed.disabled = !isValid(); };
    const onProceed = () => { if (isValid()) cleanup(true); };
    const onCancel = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === "Enter" && isValid()) onProceed();
      if (e.key === "Escape") onCancel();
    };
    const onOverlay = (e) => { if (e.target === overlay) onCancel(); };

    input.addEventListener("input", onInput);
    proceed.addEventListener("click", onProceed);
    cancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlay);
  });
}

// ---------------------------------------------------------------------------
// Session / role
// ---------------------------------------------------------------------------
async function loadMe() {
  const me = await api("/api/me");
  state.role = me.role;
  // Display-only USDT→INR lens rate, configured server-side (env INR_RATE).
  const inr = Number(me.inrRate);
  if (isFinite(inr) && inr > 0) INR_RATE = inr;
  $("#user-name").textContent = me.username;
  const rolePill = $("#user-role");
  rolePill.textContent = me.role;
  rolePill.classList.add(me.role === "admin" ? "role-admin" : "role-viewer");
  if (me.role !== "admin") {
    document.body.classList.add("viewer");
    document.querySelectorAll(".admin-only").forEach((el) => el.remove());
  }
}

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderSummary(d) {
  const summary = d.summary || {};
  state.settleCoin = summary.settleCoin || state.settleCoin;
  const coin = settleCoin();

  const upl = Number(summary.totalUnrealisedPnl);
  const pnlEl = $("#stat-pnl");
  pnlEl.textContent = `${fmtMoneySigned(summary.totalUnrealisedPnl)} ${curUnit()}`;
  // `priv` kept on every reassignment so the privacy mask survives re-renders.
  pnlEl.className = "stat-value priv " + pnlClass(summary.totalUnrealisedPnl);

  // Live PnL in the tab title so the terminal is glanceable from another
  // window. Suppressed in privacy mode — window titles leak to task switchers,
  // window lists and screen shares, which is exactly what that mode hides from.
  document.title = document.body.classList.contains("privacy-on") || !isFinite(upl)
    ? "DMA Terminal — Dashboard"
    : `${fmtMoneySigned(summary.totalUnrealisedPnl)} ${curUnit()} · DMA Terminal`;

  $("#stat-positions").textContent = summary.openPositions ?? "—";
  $("#stat-orders").textContent = summary.openOrders ?? "—";

  // Scope chip: make explicit which settlement universe the view is filtered to,
  // so an empty table reads as "none in USDT", not "none anywhere".
  const scope = $("#scope-chip");
  if (scope) scope.textContent = coin ? `${coin} PERP` : "";

  // The rail order book always quotes the settle coin (never the INR lens); keep
  // its unit chip in sync with the real settle coin rather than a hardcoded USDT.
  const bookUnit = $("#book-unit");
  if (bookUnit && coin) bookUnit.textContent = coin;

  // --- Account-health bar (all from the wallet-balance payload) ---
  const acct = walletAccount(d.balance);
  const num = (v) => (v !== undefined && v !== "" && isFinite(Number(v)) ? Number(v) : null);

  let equity = acct ? num(acct.totalEquity) ?? num(acct.totalWalletBalance) : null;
  if (equity == null && acct) {
    const c = (acct.coin || []).find((x) => x.coin === coin);
    equity = num(c?.equity) ?? num(c?.walletBalance);
  }
  const available = acct ? num(acct.totalAvailableBalance) : null;
  const usedMargin = acct ? num(acct.totalInitialMargin) : null;
  const maintMargin = acct ? num(acct.totalMaintenanceMargin) : null;

  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  setText("#stat-equity", equity != null ? `${fmtMoney(equity)} ${curUnit()}` : "—");
  setText("#stat-available", available != null ? `avail ${fmtMoney(available)}` : "");
  setText("#stat-margin-used", usedMargin != null ? `${fmtMoney(usedMargin)} ${curUnit()}` : "—");

  // Cache for the order-ticket sizing helper + enriched confirm context.
  state.available = available;
  state.equity = equity;
  updateSizingAvail();

  // PnL % relative to used (initial) margin → ROE-style; fall back to equity.
  const pnlPctEl = $("#stat-pnl-pct");
  if (pnlPctEl) {
    const base = usedMargin && usedMargin > 0 ? usedMargin : equity;
    if (isFinite(upl) && base && base > 0) {
      pnlPctEl.textContent = fmtPct((upl / base) * 100);
      pnlPctEl.className = "stat-sub priv " + pnlClass(upl);
    } else {
      pnlPctEl.textContent = "";
    }
  }

  // Margin ratio = maintenance margin ÷ margin balance (higher = closer to
  // liquidation). Prefer the exchange's own accountMMRate when present so the
  // figure matches Bybit's liquidation math exactly.
  const ratioEl = $("#stat-margin-ratio");
  const meter = $("#margin-meter");
  if (ratioEl && meter) {
    let ratio = null;
    const mmRate = acct ? num(acct.accountMMRate) : null;
    if (mmRate != null) {
      ratio = mmRate * 100;
    } else {
      const marginBal = acct ? num(acct.totalMarginBalance) ?? equity : equity;
      if (maintMargin != null && marginBal && marginBal > 0) ratio = (maintMargin / marginBal) * 100;
    }
    const bar = meter.querySelector("span");
    if (ratio != null && isFinite(ratio)) {
      ratioEl.textContent = fmtPct(ratio, false);
      bar.style.width = Math.min(100, Math.max(0, ratio)).toFixed(1) + "%";
      meter.className = "meter" + (ratio >= 80 ? " danger" : ratio >= 50 ? " warn" : "");
      meter.setAttribute("aria-label", "Margin ratio " + fmtPct(ratio, false));
      ratioEl.className = "stat-value priv" + (ratio >= 80 ? " neg" : ratio >= 50 ? " warn" : "");
    } else {
      ratioEl.textContent = "—";
      ratioEl.className = "stat-value priv";
      bar.style.width = "0%";
      meter.className = "meter";
      meter.setAttribute("aria-label", "Margin ratio unavailable");
    }
  }
}

function renderPositions(positions) {
  const body = $("#positions-body");
  state.lastPositions = positions || [];
  const rows = state.lastPositions.filter((p) => Number(p.size) !== 0);
  if (!rows.length) {
    // colspan="99" spans all columns regardless of count/role (same as the detail
    // rows) — no hardcoded per-role count to drift when a column is added.
    const hint = state.role === "admin"
      ? `<div class="empty-hint">Use the order ticket on the right to open a position.</div>`
      : "";
    setTbodyHTML(body, `<tr><td colspan="99" class="muted center empty-cell">No open positions${hint}</td></tr>`);
    return;
  }
  const isAdmin = state.role === "admin";
  const hasVal = (v) => v !== undefined && v !== null && v !== "" && Number(v) !== 0;
  const nextPrev = {};
  const sorted = applySort(rows, state.sortPos);
  const html = sorted
    .map((p) => {
      const pnl = p.unrealisedPnl;
      const key = `${p.symbol}/${p.positionIdx ?? 0}`;
      const expanded = state.expandedPos.has(key);
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-trade="${esc(p.symbol)}" title="Load ${esc(p.symbol)} into the order ticket">⇄</button>
            <button class="btn-ghost sm" data-tpsl='${esc(JSON.stringify({
              symbol: p.symbol,
              positionIdx: p.positionIdx ?? 0,
              side: p.side,
              size: p.size,
              leverage: p.leverage,
              avgPrice: p.avgPrice,
              markPrice: p.markPrice,
              breakEvenPrice: p.breakEvenPrice,
              takeProfit: p.takeProfit,
              stopLoss: p.stopLoss,
            }))}'>TP/SL</button>
            <button class="btn-danger sm" data-close='${esc(JSON.stringify({
              symbol: p.symbol,
              side: p.side,
              qty: p.size,
              positionIdx: p.positionIdx ?? 0,
            }))}'>Close</button>
          </td>`
        : "";
      const tpCell = hasVal(p.takeProfit)
        ? `${fmtMoney(p.takeProfit, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.takeProfit, size: p.size, leverage: p.leverage })}`
        : "—";
      const slCell = hasVal(p.stopLoss)
        ? `${fmtMoney(p.stopLoss, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.stopLoss, size: p.size, leverage: p.leverage })}`
        : "—";

      // Break-even (incl. fees) under entry.
      const beSub = hasVal(p.breakEvenPrice)
        ? `<span class="cell-sub">BE ${fmtMoney(p.breakEvenPrice, 4)}</span>`
        : "";

      // Liquidation distance % + a proximity gauge under the liq price. The
      // gauge fills (and reddens) as mark approaches the liquidation price — the
      // single most safety-critical signal per position, now glanceable.
      let liqCell = "—";
      if (hasVal(p.liqPrice)) {
        liqCell = fmtMoney(p.liqPrice, 4);
        const mark = Number(p.markPrice);
        const liq = Number(p.liqPrice);
        if (isFinite(mark) && mark > 0 && isFinite(liq)) {
          const dist = (Math.abs(mark - liq) / mark) * 100;
          const cls = dist < 5 ? "neg" : dist < 10 ? "warn" : "";
          const gcls = dist < 5 ? "danger" : dist < 10 ? "warn" : "";
          const prox = Math.min(100, Math.max(0, 100 - dist)); // closer to liq => fuller
          liqCell += `<span class="cell-sub ${cls}">${dist.toFixed(2)}% away</span>`;
          liqCell += `<span class="cell-gauge ${gcls}" role="img" aria-label="${dist.toFixed(1)}% from liquidation"><i style="width:${prox.toFixed(1)}%"></i></span>`;
        }
      }

      // ROE % (unrealised PnL ÷ position initial margin) under the PnL.
      let roeSub = "";
      const im = Number(p.positionIM);
      if (isFinite(im) && im > 0 && isFinite(Number(pnl))) {
        roeSub = `<span class="cell-sub ${pnlClass(pnl)}">${fmtPct((Number(pnl) / im) * 100)}</span>`;
      }

      // Change-flash on the PnL cell — only on a MEANINGFUL move, otherwise it
      // would flash every tick (PnL drifts constantly) and become pure noise.
      const cur = Number(pnl);
      const prev = state.prevPos[key];
      let flash = "";
      if (
        prev !== undefined &&
        isFinite(cur) &&
        Math.abs(cur - prev) >= Math.max(0.01, Math.abs(prev) * 0.001)
      ) {
        flash = cur > prev ? " flash-up" : " flash-down";
      }
      if (isFinite(cur)) nextPrev[key] = cur;

      const detail = detailGrid([
        ["Break-even", hasVal(p.breakEvenPrice) ? fmtMoney(p.breakEvenPrice, 4) : "", true],
        ["Initial margin", p.positionIM ? fmtMoney(p.positionIM) : "", true],
        ["Maint. margin", p.positionMM ? fmtMoney(p.positionMM) : "", true],
        ["Realized PnL", p.curRealisedPnl !== undefined && p.curRealisedPnl !== "" ? fmtMoney(p.curRealisedPnl) : "", true],
        ["Cum. realized", p.cumRealisedPnl ? fmtMoney(p.cumRealisedPnl) : "", true],
        ["Position value", fmtMoney(p.positionValue), true],
        ["TP/SL mode", p.tpslMode],
        ["Position idx", p.positionIdx],
        ["Opened", fmtTime(p.createdTime)],
        ["Updated", fmtTime(p.updatedTime)],
        // Execution-workspace insights (fee-inclusive BE, ROE, holding time,
        // today's funding/fees from the mirror); empty when exec.js is absent.
        ...(typeof exPositionExtras === "function" ? exPositionExtras(p) : []),
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}${(p.side || "").toLowerCase() === "buy" ? " side-buy" : " side-sell"}" data-pkey="${esc(key)}" role="button" tabindex="0" aria-expanded="${expanded}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(p.symbol)}</td>
        <td data-label="Side" class="side-cell ${(p.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(p.side)}</td>
        <td data-label="Size" class="mono priv">${fmtNum(p.size, 4)}</td>
        <td data-label="Entry" class="mono priv">${fmtMoney(p.avgPrice, 4)}${beSub}</td>
        <td data-label="Mark" class="mono">${fmtMoney(p.markPrice, 4)}</td>
        <td data-label="Liq." class="mono priv">${liqCell}</td>
        <td data-label="Lev" class="mono priv">${esc(p.leverage ?? "—")}x</td>
        <td data-label="Value" class="mono priv">${fmtMoney(p.positionValue)}</td>
        <td data-label="Unrealised PnL" class="mono priv ${pnlClass(pnl)}${flash}">${fmtMoneySigned(pnl)}${roeSub}</td>
        <td data-label="TP" class="mono priv">${tpCell}</td>
        <td data-label="SL" class="mono priv">${slCell}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
  setTbodyHTML(body, html);
  state.prevPos = nextPrev;
  // Drop expanded-state for positions that no longer exist (avoid unbounded growth).
  const liveKeys = new Set(sorted.map((p) => `${p.symbol}/${p.positionIdx ?? 0}`));
  state.expandedPos.forEach((k) => { if (!liveKeys.has(k)) state.expandedPos.delete(k); });
  updateSortIndicators();
}

function renderOrders(orders) {
  const body = $("#orders-body");
  state.lastOrders = orders || [];
  const rows = state.lastOrders;
  // Hide the bulk-destructive "Cancel all" when there's nothing to cancel, so a
  // live wipe-everything button never sits on an empty panel. (Null for viewers.)
  const cancelAllBtn = document.getElementById("cancel-all-btn");
  if (cancelAllBtn) cancelAllBtn.hidden = !rows.length;
  // Execution-workspace toolbar filter (search/side) narrows the view only —
  // cancel-all above is deliberately keyed on the UNfiltered set.
  const filtered = typeof exApplyOrderFilters === "function" ? exApplyOrderFilters(rows) : rows;
  if (!filtered.length) {
    const hint = rows.length
      ? `<div class="empty-hint">${rows.length} open order${rows.length === 1 ? "" : "s"} hidden by the filter above.</div>`
      : state.role === "admin"
        ? `<div class="empty-hint">Place an order from the ticket to see it here.</div>`
        : "";
    setTbodyHTML(body, `<tr><td colspan="99" class="muted center empty-cell">${rows.length ? "No orders match" : "No open orders"}${hint}</td></tr>`);
    updateSortIndicators();
    return;
  }
  const isAdmin = state.role === "admin";
  const sorted = applySort(filtered, state.sortOrders);
  const html = sorted
    .map((o) => {
      const key = o.orderId || `${o.symbol}/${o.orderLinkId || ""}`;
      const expanded = state.expandedOrders.has(key);
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-dup='${esc(JSON.stringify({
              symbol: o.symbol,
              side: o.side,
              orderType: o.orderType,
              qty: o.qty,
              price: o.price,
            }))}' title="Duplicate: copy this order's parameters into the ticket (nothing is placed until you submit)">⧉</button>
            <button class="btn-ghost sm" data-amend='${esc(JSON.stringify({
              symbol: o.symbol,
              orderId: o.orderId,
              side: o.side,
              // Amend the UNFILLED remainder when the order is partially filled.
              qty: Number(o.leavesQty) > 0 ? o.leavesQty : o.qty,
              price: o.price,
            }))}' title="Cancel this order and edit it in the ticket">✎</button>
            <button class="btn-danger sm" data-cancel='${esc(JSON.stringify({
              symbol: o.symbol,
              orderId: o.orderId,
            }))}'>Cancel</button></td>`
        : "";

      // Fill progress + flags as small badges under the type cell.
      const filled = Number(o.cumExecQty);
      const total = Number(o.qty);
      const hasFill = isFinite(filled) && isFinite(total) && total > 0 && filled > 0;
      const fillPct = hasFill ? Math.min(100, (filled / total) * 100) : 0;
      const fillSub = hasFill
        ? `<span class="cell-sub">${fmtNum(filled, 4)}/${fmtNum(total, 4)} filled</span>` +
          `<span class="cell-gauge" role="img" aria-label="${fillPct.toFixed(0)}% filled"><i style="width:${fillPct.toFixed(1)}%"></i></span>`
        : "";
      const badges =
        (o.reduceOnly ? '<span class="badge">reduce</span>' : "") +
        (o.closeOnTrigger ? '<span class="badge">close</span>' : "") +
        (o.stopOrderType ? `<span class="badge">${esc(o.stopOrderType)}</span>` : "");

      const detail = detailGrid([
        ["Order ID", o.orderId],
        ["Order link ID", o.orderLinkId],
        ["Time in force", o.timeInForce],
        ["Reduce only", o.reduceOnly === undefined ? "" : String(o.reduceOnly)],
        ["Close on trigger", o.closeOnTrigger === undefined ? "" : String(o.closeOnTrigger)],
        ["Stop order type", o.stopOrderType],
        ["Trigger by", o.triggerBy],
        ["Cum. exec qty", o.cumExecQty, true],
        ["Leaves qty", o.leavesQty, true],
        ["Created", fmtTime(o.createdTime)],
        ["Updated", fmtTime(o.updatedTime)],
        // Execution-workspace lifecycle (created → fills → status) from the
        // executions mirror; empty when exec.js isn't loaded.
        ...(typeof exOrderExtras === "function" ? exOrderExtras(o) : []),
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}${(o.side || "").toLowerCase() === "buy" ? " side-buy" : " side-sell"}" data-okey="${esc(key)}" role="button" tabindex="0" aria-expanded="${expanded}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(o.symbol)}</td>
        <td data-label="Side" class="side-cell ${(o.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(o.side)}</td>
        <td data-label="Type">${esc(o.orderType)}${badges}</td>
        <td data-label="Qty" class="mono priv">${fmtNum(o.qty, 4)}${fillSub}</td>
        <td data-label="Price" class="mono priv">${o.price && Number(o.price) ? fmtMoney(o.price, 4) : "—"}</td>
        <td data-label="Trigger" class="mono priv">${o.triggerPrice && Number(o.triggerPrice) ? fmtMoney(o.triggerPrice, 4) : "—"}</td>
        <td data-label="Status">${esc(o.orderStatus)}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
  // The upstream open-orders call is capped at 50 — a full page means MORE may
  // exist on the exchange that this table cannot show. Never present a capped
  // page as the complete set.
  const capNote = rows.length >= 50
    ? `<tr><td colspan="99" class="muted center">Showing 50 open orders (the feed's cap) — more may be open on the exchange.</td></tr>`
    : "";
  setTbodyHTML(body, html + capNote);
  // Prune expansion state against ALL live orders (not the filtered view), so
  // clearing a filter restores previously expanded rows.
  const liveKeys = new Set(rows.map((o) => o.orderId || `${o.symbol}/${o.orderLinkId || ""}`));
  state.expandedOrders.forEach((k) => { if (!liveKeys.has(k)) state.expandedOrders.delete(k); });
  updateSortIndicators();
}

function renderErrors(errors) {
  // Surface upstream errors inline in the updated label, non-blocking.
  const label = $("#positions-updated");
  if (errors && Object.keys(errors).length) {
    label.textContent = "⚠ " + Object.values(errors)[0];
    label.classList.add("neg");
  } else {
    const t = new Date();
    label.textContent = "updated " + t.toLocaleTimeString();
    label.classList.remove("neg");
  }
}

// Highest server-authored dashboard generation rendered so far. Every dashboard
// snapshot (WS push AND the /api/dashboard GET) carries `gen`, a monotonic counter
// stamped server-side at data-assembly time, so freshness is ordered by when the
// exchange reads completed — not by which transport happened to arrive first.
// A snapshot older than the last rendered one is dropped, so neither a post-write
// GET nor a routine WS frame can clobber the other with staler data. Reset to 0 on
// WS reconnect (a redeploy restarts the server counter). Equal gen still renders,
// so a currency-toggle re-render of the cached snapshot is unaffected.
let _lastDashSeq = 0;
function renderDashboard(d) {
  const gen = Number(d && d.gen);
  if (isFinite(gen)) {
    if (gen < _lastDashSeq) return; // an older snapshot lost the race; keep the newer one
    _lastDashSeq = gen;
  }
  state.lastDashboard = d; // kept so a currency toggle can re-render instantly
  renderSummary(d);
  renderPositions(d.positions);
  renderOrders(d.orders);
  renderErrors(d.errors);
  notifyPositionChanges(d);
  // Risk system (risk.js): metrics, score, alerts, timeline, and both risk
  // surfaces (the compact dashboard panel + the Risk tab) all feed off this
  // one snapshot — no extra requests.
  rkIngest(d);
  // PnL tab (pnl.js): the live "current unrealised PnL" value rides the same
  // snapshot; the history series itself is fetched from /api/upnl on entry.
  pnlIngest(d);
  // Execution workspace (exec.js): quick-actions context, ladder markers and
  // the ticket preview all ride the same snapshot.
  exIngest();
}

// In-app fill/close awareness: announce position open/close/size changes by
// diffing consecutive snapshots, so a TP firing while the user is on another
// tab (or a limit entry filling) is surfaced without needing Telegram. Only
// POSITIONS are diffed — an order-row disappearance is ambiguous (fill vs
// cancel vs expiry), but a position change is an unambiguous money-state fact.
// key -> {size, side, symbol}; null until the first full snapshot (baseline).
let _posChangeBaseline = null;
function notifyPositionChanges(d) {
  // A PARTIAL snapshot (the positions read failed upstream this cycle) must
  // never be diffed: its empty list would read as "everything closed".
  if (d.errors && d.errors.positions) return;
  const cur = {};
  (d.positions || []).forEach((p) => {
    const size = Number(p.size);
    if (isFinite(size) && size !== 0) {
      cur[`${p.symbol}/${p.positionIdx ?? 0}`] = { size, side: p.side, symbol: p.symbol };
    }
  });
  if (_posChangeBaseline === null) { _posChangeBaseline = cur; return; }
  const prev = _posChangeBaseline;
  _posChangeBaseline = cur;
  // Privacy mode: announce the event, never the figures (toasts are on-screen).
  const priv = document.body.classList.contains("privacy-on");
  for (const k in cur) {
    if (!prev[k]) {
      toast(`Position opened: ${cur[k].side} ${cur[k].symbol}${priv ? "" : " " + fmtNum(cur[k].size, 4)}`, "info", 6000);
    } else if (prev[k].size !== cur[k].size) {
      toast(
        priv
          ? `${cur[k].symbol} position size changed`
          : `${cur[k].symbol} size ${fmtNum(prev[k].size, 4)} → ${fmtNum(cur[k].size, 4)}`,
        "info", 6000
      );
    }
  }
  for (const k in prev) {
    if (!cur[k]) toast(`Position closed: ${prev[k].symbol}`, "info", 6000);
  }
}

// ---------------------------------------------------------------------------
// Action handlers (admin)
// ---------------------------------------------------------------------------
function ensureToken() {
  if (!state.tradeToken) {
    toast("Enter the trade token (top of the order rail on the Dashboard) to unlock trading.", "warn");
    return false;
  }
  return true;
}

// Safely read a JSON payload embedded in a row button's data-* attribute.
// A malformed attribute must never throw an uncaught error inside the delegated
// click handler (which would make the button silently do nothing).
function parseRowData(el, attr) {
  try {
    return JSON.parse(el.getAttribute(attr));
  } catch (err) {
    toast("Could not read position/order data — please refresh and retry.", "neg");
    return null;
  }
}

document.addEventListener("click", async (e) => {
  const tradeBtn = e.target.closest("[data-trade]");
  if (tradeBtn) {
    loadSymbolIntoTicket(tradeBtn.getAttribute("data-trade"));
    return;
  }

  const tpslBtn = e.target.closest("[data-tpsl]");
  if (tpslBtn) {
    const payload = parseRowData(tpslBtn, "data-tpsl");
    if (!payload) return;
    if (!ensureToken()) return;
    openTpslModal(payload);
    return;
  }

  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const payload = parseRowData(closeBtn, "data-close");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      // Enrich the confirm with the load-bearing fact: the unrealised PnL this
      // close will realise (looked up from the live position snapshot).
      const pos = (state.lastPositions || []).find(
        (p) => p.symbol === payload.symbol &&
          String(p.positionIdx ?? 0) === String(payload.positionIdx ?? 0)
      );
      const lines = [
        ["Symbol", payload.symbol],
        ["Action", "Close · market reduce-only"],
        ["Size (live)", String(payload.qty)],
      ];
      if (pos && isFinite(Number(pos.unrealisedPnl))) {
        lines.push(["Unrealised PnL to realise", `${fmtSigned(pos.unrealisedPnl)} ${settleCoin()}`]);
      }
      const liveQty = Number(payload.qty);
      // Quick-action buttons preselect a portion (data-close-pct); the same
      // typed-confirm ceremony still gates the write — only the default
      // highlighted choice changes.
      const presetPct = Number(closeBtn.getAttribute("data-close-pct"));
      const ok = await typedConfirm({
        head: `Close ${payload.symbol}`,
        lines,
        note: "Sends a market order on the opposite side; reduce-only can only shrink the position.",
      }, {
        // Partial close: pick the portion of the LIVE position to exit. The
        // server re-derives the size from the exchange and floors the slice to
        // the lot step — the figure here is a preview, never the payload qty.
        percents: [25, 50, 75, 100],
        defaultPercent: [25, 50, 75, 100].includes(presetPct) ? presetPct : undefined,
        hint: (pct) =>
          pct === 100
            ? "Closes the entire position."
            : `Closes ≈ ${isFinite(liveQty) ? fmtNum((liveQty * pct) / 100, 4) : "…"} of ${payload.qty} (exact size floors to the lot step server-side).`,
      });
      if (!ok) return;
      const pct = Number(ok.percent) > 0 && Number(ok.percent) < 100 ? Number(ok.percent) : 100;
      closeBtn.disabled = true;
      const row = closeBtn.closest("tr");
      try {
        // percent omitted on a full close — the request stays byte-identical to
        // the pre-partial-close behaviour (server echoes the exact live size).
        await writeApi("/api/position/close", pct < 100 ? { ...payload, percent: pct } : payload);
        toast(`✓ Close order sent for ${payload.symbol}${pct < 100 ? ` (${pct}%)` : ""}`, "pos");
        // Optimistic dim only when the whole row is on its way out.
        if (row && pct === 100) row.style.opacity = "0.45";
        refreshDashboardSoon();
      } catch (err) {
        toast("Close failed: " + err.message, "neg");
      } finally {
        closeBtn.disabled = false;
      }
    });
    return;
  }

  const dupBtn = e.target.closest("[data-dup]");
  if (dupBtn) {
    // Duplicate = prefill the ticket only. No write happens here, so no
    // confirmation — submission still goes through the full ceremony.
    const payload = parseRowData(dupBtn, "data-dup");
    if (payload) prefillTicketFromOrder(payload);
    return;
  }

  const amendBtn = e.target.closest("[data-amend]");
  if (amendBtn) {
    const payload = parseRowData(amendBtn, "data-amend");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      // Amend = cancel + edit in the ticket. The venue exposes no verified
      // in-place amend on this gateway, and cancel-then-resubmit keeps the
      // ticket as the ONE write surface; nothing is re-placed until submit.
      const ok = await typedConfirm({
        head: `Amend ${payload.symbol} order`,
        lines: [
          ["Order", String(payload.orderId)],
          ["Current", `${payload.side} ${payload.qty}${payload.price && Number(payload.price) ? " @ " + payload.price : ""}`],
        ],
        note: "Cancels this order and loads its parameters into the ticket to adjust and resubmit. Nothing is re-placed until you submit.",
      });
      if (!ok) return;
      amendBtn.disabled = true;
      try {
        await writeApi("/api/order/cancel", { symbol: payload.symbol, orderId: payload.orderId });
        toast("✓ Order cancelled — adjust and resubmit from the ticket", "pos");
        prefillTicketFromOrder(payload);
        refreshDashboardSoon();
      } catch (err) {
        toast("Amend failed: " + err.message, "neg");
      } finally {
        amendBtn.disabled = false;
      }
    });
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel]");
  if (cancelBtn) {
    const payload = parseRowData(cancelBtn, "data-cancel");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      const ok = await typedConfirm(`Cancel order ${payload.orderId} (${payload.symbol})?`);
      if (!ok) return;
      cancelBtn.disabled = true;
      const row = cancelBtn.closest("tr");
      try {
        await writeApi("/api/order/cancel", payload);
        toast(`✓ Cancel sent for ${payload.symbol}`, "pos");
        if (row) row.style.opacity = "0.45"; // optimistic: row is being cancelled
        refreshDashboardSoon();
      } catch (err) {
        toast("Cancel failed: " + err.message, "neg");
      } finally {
        cancelBtn.disabled = false;
      }
    });
  }
});

// Restore keyboard focus to a row after a re-render destroys-and-rebuilds it
// (matched by its stable data key rather than a CSS selector, to avoid any
// selector-injection from exchange-controlled symbols).
function focusRowByKey(containerSel, attr, key) {
  document.querySelectorAll(`${containerSel} tr.exp-row`).forEach((r) => {
    if (r.dataset[attr] === key) r.focus();
  });
}

// Expand/collapse a position or order row. Used by both pointer and keyboard.
function toggleRowExpand(row) {
  if (row.matches("#positions-body tr.exp-row")) {
    const key = row.dataset.pkey;
    state.expandedPos.has(key) ? state.expandedPos.delete(key) : state.expandedPos.add(key);
    renderPositions(state.lastPositions);
    focusRowByKey("#positions-body", "pkey", key);
    return true;
  }
  if (row.matches("#orders-body tr.exp-row")) {
    const key = row.dataset.okey;
    state.expandedOrders.has(key) ? state.expandedOrders.delete(key) : state.expandedOrders.add(key);
    renderOrders(state.lastOrders);
    focusRowByKey("#orders-body", "okey", key);
    return true;
  }
  return false;
}

// Toggle the sort for a sortable header. Used by both pointer and keyboard.
function sortByHeader(th) {
  const table = th.closest("table");
  const st = table.id === "positions-table" ? state.sortPos : state.sortOrders;
  const key = th.dataset.sortkey;
  if (st.key === key) st.dir *= -1;
  else { st.key = key; st.dir = 1; }
  if (table.id === "positions-table") renderPositions(state.lastPositions);
  else renderOrders(state.lastOrders);
}

document.addEventListener("click", (e) => {
  // Sortable header click → sort.
  const th = e.target.closest("table.sortable thead th[data-sortkey]");
  if (th) { sortByHeader(th); return; }
  // Row click (not on an action control) → expand/collapse.
  if (e.target.closest("button, a, input, select")) return;
  const row = e.target.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (row) toggleRowExpand(row);
});

// Keyboard parity: Enter/Space activates a focused sortable header or row.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  const el = e.target;
  if (!el || !el.closest) return;
  const th = el.closest("table.sortable thead th[data-sortkey]");
  if (th && el === th) { e.preventDefault(); sortByHeader(th); return; }
  const row = el.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (row && el === row) { e.preventDefault(); toggleRowExpand(row); }
});

// ---------------------------------------------------------------------------
// TP/SL modal for an existing position (Full mode, market exit). The trade
// token is required; positionIdx is sent and re-verified server-side.
// ---------------------------------------------------------------------------
let _tpslOpen = false;
function openTpslModal(pos) {
  if (_tpslOpen) return;
  _tpslOpen = true;
  // Set once cleanup runs so a late finally/catch from an in-flight write can't
  // write to (or re-enable) this modal's shared DOM nodes after they've been
  // handed to a reopened modal.
  let closed = false;
  const _prevFocus = document.activeElement;

  const overlay = $("#tpsl-overlay");
  const tpInput = $("#tpsl-tp");
  const slInput = $("#tpsl-sl");
  const trigger = $("#tpsl-trigger");
  const out = $("#tpsl-result");
  const preview = $("#tpsl-preview");
  const applyBtn = $("#tpsl-apply");
  const cancelBtn = $("#tpsl-cancel");

  const cur = (v) =>
    v !== undefined && v !== null && v !== "" && Number(v) !== 0 ? String(v) : "";

  // Live "projected net PnL (ROI%)" preview as the user types a TP/SL price.
  const previewLine = (label, price) => {
    const r = projectedPnl({
      side: pos.side, entry: pos.avgPrice, exitPrice: price, size: pos.size, leverage: pos.leverage,
    });
    if (!r) return "";
    // Write surface — keep the projected PnL in USDT (convert=false) to match the
    // USDT-denominated inputs above it.
    return `<div>${label} @ ${esc(price)}: ${projAmount(r, true, false)} ${esc(settleCoin())} <span class="muted">net of exit fee</span></div>`;
  };
  const updatePreview = () => {
    const tp = tpInput.value.trim();
    const sl = slInput.value.trim();
    let html = "";
    if (tp && Number(tp) > 0) html += previewLine("TP", tp);
    if (sl && Number(sl) > 0) html += previewLine("SL", sl);
    preview.innerHTML = html;
  };

  $("#tpsl-title").textContent = `Set TP / SL — ${pos.symbol}`;
  $("#tpsl-context").textContent = `${pos.side} · entry ${fmtNum(pos.avgPrice, 4)} · mark ${fmtNum(pos.markPrice, 4)} · prices in USDT`;
  tpInput.value = cur(pos.takeProfit);
  slInput.value = cur(pos.stopLoss);
  trigger.value = "LastPrice";

  // One-click presets: PRE-FILL only (the user still reviews + applies with the
  // trade token, and the server re-derives the position — nothing is sent from
  // here). Direction-aware: SL lands on the losing side of mark, TP on the
  // winning side; BE = break-even (fees included) with entry as the fallback.
  const presets = document.getElementById("tpsl-presets");
  const markPx = Number(pos.markPrice);
  const isLong = String(pos.side).toLowerCase() === "buy";
  const bePx = Number(pos.breakEvenPrice) > 0 ? Number(pos.breakEvenPrice) : Number(pos.avgPrice);
  const tickSize = (state.specs[pos.symbol] || {}).tickSize;
  const snapPx = (v) => {
    const snapped = tickSize != null ? snapToStep(v, tickSize) : null;
    return snapped != null && Number(snapped) > 0 ? snapped : String(Number(v.toFixed(4)));
  };
  const onPreset = (ev) => {
    const b = ev.target.closest("button[data-kind]");
    if (!b) return;
    let px;
    if (b.dataset.be) {
      px = bePx;
    } else {
      const pct = Number(b.dataset.pct) / 100;
      const dir = b.dataset.kind === "sl" ? (isLong ? -1 : 1) : (isLong ? 1 : -1);
      px = markPx * (1 + dir * pct);
    }
    if (!(px > 0)) return;
    (b.dataset.kind === "sl" ? slInput : tpInput).value = snapPx(px);
    updatePreview();
  };
  if (presets) {
    if (isFinite(markPx) && markPx > 0) {
      const slBtn = (pct) => `<button type="button" data-kind="sl" data-pct="${pct}" title="Stop ${pct}% beyond mark, against the position">${pct}%</button>`;
      const tpBtn = (pct) => `<button type="button" data-kind="tp" data-pct="${pct}" title="Target ${pct}% beyond mark, in the position's favour">${pct}%</button>`;
      presets.innerHTML =
        `<span class="pp-k">SL</span>` +
        (bePx > 0 ? `<button type="button" data-kind="sl" data-be="1" title="Stop at break-even (fees included)">BE</button>` : "") +
        [1, 2, 5].map(slBtn).join("") +
        `<span class="pp-k">TP</span>` + [1, 2, 5].map(tpBtn).join("");
      presets.addEventListener("click", onPreset);
    } else {
      presets.innerHTML = "";
    }
  }
  out.textContent = "";
  out.className = "result-msg";
  applyBtn.disabled = false; // clear a stuck-disabled state from a prior write
  overlay.hidden = false;
  updatePreview();
  tpInput.focus();
  const _untrap = focusTrap(overlay.querySelector(".modal"));

  const cleanup = () => {
    closed = true;
    overlay.hidden = true;
    applyBtn.removeEventListener("click", onApply);
    cancelBtn.removeEventListener("click", onCancel);
    overlay.removeEventListener("click", onOverlay);
    document.removeEventListener("keydown", onKey);
    tpInput.removeEventListener("input", updatePreview);
    slInput.removeEventListener("input", updatePreview);
    if (presets) {
      presets.removeEventListener("click", onPreset);
      presets.innerHTML = ""; // never leak this position's presets into the next open
    }
    _untrap();
    restoreFocus(_prevFocus);
    _tpslOpen = false;
  };
  const onCancel = () => cleanup();
  const onOverlay = (ev) => { if (ev.target === overlay) cleanup(); };
  const onKey = (ev) => { if (ev.key === "Escape") cleanup(); };

  const onApply = () => {
    const tp = tpInput.value.trim();
    const sl = slInput.value.trim();
    if (!tp && !sl) {
      out.textContent = "Enter a Take Profit and/or Stop Loss (0 to cancel).";
      out.className = "result-msg neg";
      return;
    }
    for (const [name, v] of [["Take Profit", tp], ["Stop Loss", sl]]) {
      if (v && !(Number(v) >= 0)) {
        out.textContent = `${name} must be a number ≥ 0 (0 cancels).`;
        out.className = "result-msg neg";
        return;
      }
    }
    const body = { symbol: pos.symbol, positionIdx: pos.positionIdx, triggerBy: trigger.value };
    if (tp) body.takeProfit = tp;
    if (sl) body.stopLoss = sl;

    out.textContent = "Applying…";
    out.className = "result-msg";
    applyBtn.disabled = true;
    withWriteLock(async () => {
      try {
        await writeApi("/api/position/trading-stop", body);
        // The write settled; surface the outcome regardless of modal state.
        toast(`✓ TP/SL applied for ${pos.symbol}`, "pos");
        refreshDashboardSoon();
        if (closed) return; // modal already dismissed — don't touch its shared DOM
        out.textContent = "✓ TP/SL applied";
        out.className = "result-msg pos";
        setTimeout(cleanup, 800);
      } catch (err) {
        if (closed) return;
        out.textContent = "✗ " + err.message;
        out.className = "result-msg neg";
      } finally {
        if (!closed) applyBtn.disabled = false;
      }
    });
  };

  applyBtn.addEventListener("click", onApply);
  cancelBtn.addEventListener("click", onCancel);
  overlay.addEventListener("click", onOverlay);
  document.addEventListener("keydown", onKey);
  tpInput.addEventListener("input", updatePreview);
  slInput.addEventListener("input", updatePreview);
}

// Run a token-gated write while disabling its submit button. The trade token
// is always required; the typed-"confirm" modal is shown unless the spec sets
// skipConfirm (used for lower-risk actions like set-leverage).
// `gather` returns {body, confirmMsg, successMsg, skipConfirm?} or null to abort.
async function runWrite(submitBtn, out, gather) {
  if (out) { out.textContent = ""; out.className = "result-msg"; }
  if (!ensureToken()) return;
  await withWriteLock(async () => {
    let spec;
    try {
      spec = gather();
    } catch (err) {
      if (out) { out.textContent = "✗ " + err.message; out.classList.add("neg"); }
      return;
    }
    if (!spec) return;
    const ok = spec.skipConfirm ? true : await typedConfirm(spec.confirmMsg);
    if (!ok) return;
    const prevLabel = submitBtn ? submitBtn.textContent : null;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Working…"; }
    try {
      const res = await writeApi(spec.path, spec.body);
      const msg = spec.successMsg(res);
      if (out) { out.textContent = msg; out.classList.add("pos"); }
      if (msg) toast(msg, "pos");
      if (spec.onSuccess) spec.onSuccess();
    } catch (err) {
      if (out) { out.textContent = "✗ " + err.message; out.classList.add("neg"); }
      toast(err.message, "neg");
      if (spec.onError) {
        try { spec.onError(err); } catch (e) { /* never mask the original failure */ }
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
    }
  });
}

function wireTradeToken() {
  const field = $("#trade-token");
  const status = $("#token-status");
  if (!field) return;
  let timer;
  const setStatus = (text, cls) => {
    status.textContent = text;
    status.className = "token-status " + cls;
  };
  // Verify the token with the server (debounced) so the user sees VALID/INVALID
  // the moment they enter it, not only when they first try to trade.
  const verify = async (token) => {
    try {
      const res = await api("/api/verify-trade-token", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      if (field.value.trim() !== token) return; // field changed since request
      setStatus(res.valid ? "VALID" : "INVALID", res.valid ? "ready" : "invalid");
    } catch (e) {
      if (field.value.trim() !== token) return;
      setStatus("CHECK FAILED", "invalid");
    }
  };
  const sync = () => {
    const token = field.value.trim();
    state.tradeToken = token;
    clearTimeout(timer);
    if (!token) {
      setStatus("LOCKED", "locked");
      return;
    }
    setStatus("CHECKING…", "checking");
    timer = setTimeout(() => verify(token), 400);
  };
  field.addEventListener("input", sync);
  sync();
}

function wireAdminForms() {
  if (state.role !== "admin") return;

  wireTradeToken();

  // Toggle the limit-only fields (price + time-in-force) for limit orders.
  const orderType = $("#order-type");
  const limitFields = document.querySelectorAll(".limit-only");
  const syncLimit = () => {
    limitFields.forEach((el) => { el.style.display = orderType.value === "Limit" ? "" : "none"; });
  };
  orderType.addEventListener("change", syncLimit);
  syncLimit();

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#order-result"), () => {
      const body = {
        symbol: f.symbol.value.trim().toUpperCase(),
        side: f.side.value,
        orderType: f.orderType.value,
        qty: f.qty.value.trim(),
        positionIdx: 0,
      };
      // The order is ALWAYS sent as a base-coin qty. In Margin mode that qty was
      // derived from the margin input; a blank/zero derived qty means no price was
      // resolvable or the margin rounded below the lot step. Defence-in-depth:
      // reject qty <= 0 here too (the server also validates) so nothing invalid can
      // reach the money path. This blocks no order the exchange would have accepted.
      const sizedByMargin = f.sizeMode.value === "margin";
      if (!body.symbol) throw new Error("symbol is required");
      if (!body.qty || !(Number(body.qty) > 0)) {
        throw new Error(
          sizedByMargin
            ? "Enter a margin amount — plus a limit price (or wait for the market price) — so a quantity can be derived"
            : "quantity is required"
        );
      }
      if (f.orderType.value === "Limit") {
        body.price = f.price.value.trim();
        if (!body.price) throw new Error("limit price is required for a Limit order");
        // GTC is the exchange default — omitted so a default order's payload
        // stays byte-identical to before the TIF control existed.
        const tif = f.timeInForce.value;
        if (tif && tif !== "GTC") body.timeInForce = tif;
      }
      if (f.reduceOnly.checked) body.reduceOnly = true;

      // Optional TP/SL attached at order creation.
      const tp = f.takeProfit.value.trim();
      const sl = f.stopLoss.value.trim();
      if ((tp || sl) && body.reduceOnly) {
        throw new Error("Take Profit / Stop Loss cannot be set on a reduce-only order");
      }
      if (tp) {
        if (!(Number(tp) > 0)) throw new Error("Take Profit must be greater than 0");
        body.takeProfit = tp;
      }
      if (sl) {
        if (!(Number(sl) > 0)) throw new Error("Stop Loss must be greater than 0");
        body.stopLoss = sl;
      }

      // Advisory spec checks — these NEVER block a submit. The server stays
      // authoritative (exactly as before this change); any concern is surfaced
      // as a warning in the confirm modal so the order is still sent and the
      // exchange decides. This guarantees no order main would have sent is blocked.
      const spec = state.specs[body.symbol];
      const specWarnings = [];
      if (spec) {
        const qn = Number(body.qty);
        if (spec.minOrderQty != null && qn < Number(spec.minOrderQty))
          specWarnings.push(`Qty ${body.qty} is below the ${body.symbol} minimum (${spec.minOrderQty}); the exchange may reject it.`);
        if (spec.maxOrderQty != null && Number(spec.maxOrderQty) > 0 && qn > Number(spec.maxOrderQty))
          specWarnings.push(`Qty ${body.qty} exceeds the ${body.symbol} maximum (${spec.maxOrderQty}); the exchange may reject it.`);
        // Off-tick prices are rejected by the exchange only AFTER the whole
        // confirm ceremony — warn up front instead. snapToStep returns the
        // floored on-grid multiple, so any difference means off-grid. Advisory
        // only, like every spec check (the server/exchange stay authoritative).
        if (spec.tickSize != null) {
          const offTick = (v) => {
            const snapped = snapToStep(v, spec.tickSize);
            return snapped != null && Number(snapped) !== Number(v);
          };
          [["Price", body.price], ["Take Profit", body.takeProfit], ["Stop Loss", body.stopLoss]]
            .forEach(([name, v]) => {
              if (v && offTick(v))
                specWarnings.push(`${name} ${v} is not a multiple of the ${body.symbol} tick size (${spec.tickSize}); the exchange may reject it.`);
            });
        }
      }

      // A Market order sized by margin derives qty from the last fetched price,
      // which refreshes on symbol/type change (not continuously). Warn if it has
      // gone stale so a drifted quote isn't trusted blindly for the size. (Leverage
      // no longer needs an "assumed" warning — the qty is derived from the exchange's
      // real leverage, and margin sizing refuses to proceed when it isn't known.)
      if (sizedByMargin && String(body.orderType).toLowerCase() === "market") {
        const lp = state.orderLastPrice;
        const ageMs = lp && lp.symbol === body.symbol && lp.ts ? Date.now() - lp.ts : null;
        if (ageMs != null && ageMs > 15000) {
          specWarnings.push(`The market price used to size this order is ${Math.round(ageMs / 1000)}s old; re-select the symbol to refresh it if the price may have moved.`);
        }
      }
      // Leverage is fetched on symbol select / after an in-app change, but not
      // continuously — warn if it's old so an out-of-band change (exchange app)
      // isn't silently sized against.
      if (sizedByMargin) {
        const symLev = state.symbolLeverage;
        const ageMs = symLev && symLev.symbol === body.symbol && symLev.ts ? Date.now() - symLev.ts : null;
        if (ageMs != null && ageMs > 300000) {
          specWarnings.push(`Leverage for ${body.symbol} was read ${Math.round(ageMs / 60000)}m ago; if you changed it on the exchange since, re-select the symbol to refresh.`);
        }
      }

      // Enriched confirm: show notional, estimated initial margin and
      // %-of-available so the size is legible before a real-money write.
      // Entry = limit price, else live last.
      let entry = body.price ? Number(body.price) : null;
      if (entry == null && state.orderLastPrice && state.orderLastPrice.symbol === body.symbol) {
        entry = Number(state.orderLastPrice.price);
      }
      const lev = sizingLeverage();
      const lines = [
        ["Side / Type", `${body.side} ${body.orderType}`],
        ["Symbol", body.symbol],
        ["Quantity", String(body.qty)],
      ];
      if (sizedByMargin && lev > 0 && Number(f.margin.value.trim()) > 0) {
        lines.push(["Margin (requested)", `${fmtNum(Number(f.margin.value.trim()))} ${settleCoin()} (${lev}×)`]);
      }
      if (body.price) lines.push(["Limit price", String(body.price)]);
      if (body.timeInForce) lines.push(["Time in force", body.timeInForce]);
      if (entry && Number(body.qty) > 0) {
        const notional = Number(body.qty) * entry;
        lines.push(["Notional", `${fmtNum(notional)} ${settleCoin()}${body.price ? "" : " (est.)"}`]);
        // Reduce-only closes an existing position and commits no new margin, so the
        // initial-margin estimate would be misleading; also omit it if leverage is
        // unknown (never shown against a guess).
        if (!body.reduceOnly && lev > 0) lines.push(["Est. initial margin", `${fmtNum(notional / lev)} ${settleCoin()} (${lev}×)`]);
        if (state.available && state.available > 0) {
          lines.push(["≈ % of available", fmtPct((notional / state.available) * 100, false)]);
        }
      }
      if (body.takeProfit) lines.push(["Take Profit", String(body.takeProfit)]);
      if (body.stopLoss) lines.push(["Stop Loss", String(body.stopLoss)]);
      if (body.reduceOnly) lines.push(["Reduce only", "yes"]);
      return {
        path: "/api/order/create",
        body,
        confirmMsg: { head: `Submit ${body.side} ${body.orderType} order`, lines, note: specWarnings.length ? "⚠ " + specWarnings.join(" ") : undefined },
        successMsg: (res) => "✓ Order submitted" + (res.result?.orderId ? ` (${res.result.orderId})` : ""),
        onSuccess: () => {
          f.reset();
          // Re-sync segmented toggles + dependent UI to the reset select values.
          f.side.dispatchEvent(new Event("change", { bubbles: true }));
          f.orderType.dispatchEvent(new Event("change", { bubbles: true }));
          f.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
          state.symbolLeverage = null; // symbol cleared by reset; drop its cached leverage
          syncLimit();
          updateOrderPreview();
          // Repaint the Submit label AFTER runWrite's finally restores the pre-submit
          // label, so it reflects the reset form (no stale symbol) rather than the
          // label captured at submit time.
          setTimeout(paintSubmit, 0);
          refreshDashboardSoon(); // surface the new resting order / position promptly
        },
      };
    });
  });

  // --- live notional + projected-PnL preview for the order form ---
  // Entry is the limit price for Limit orders; for Market orders we use the
  // symbol's live last price (from the tickers API) as an estimate. Shows a
  // notional (qty × price) hint always, and a projected-PnL preview when TP/SL
  // are set. ROI is omitted here ($ only) because the form has no leverage input.
  const orderForm = $("#order-form");
  const orderPreview = $("#order-pnl-preview");
  const orderNotional = $("#order-notional");
  let _lastPriceTimer;

  // Declared as hoisted functions (not const arrows) so the order-form
  // onSuccess closure above can call updateOrderPreview regardless of source
  // ordering — avoids any "before initialization" footgun on the trade path.
  async function fetchMarketPrice(symbol) {
    if (!symbol) return;
    try {
      const data = await api(`/api/tickers?symbol=${encodeURIComponent(symbol)}`);
      const t = ((data.result && data.result.list) || [])[0];
      if (t && t.lastPrice) state.orderLastPrice = { symbol, price: t.lastPrice, ts: Date.now() };
    } catch (e) {
      /* preview simply won't render for market until a price is available */
    }
    updateOrderPreview();
  }

  // The account's REAL leverage for the active symbol, fetched from the exchange
  // on symbol change (see fetchSymbolLeverage) and used by the %-buttons and the
  // Margin→Quantity conversion. It is NEVER sent with the order. Returns null when
  // it isn't known yet (still loading, fetch failed, or no symbol) — callers must
  // then refuse to size rather than guess, since a wrong leverage mis-sizes real
  // money. Guarded by symbol so a stale value is never used for a different coin.
  function sizingLeverage() {
    const sl = state.symbolLeverage;
    if (!sl || sl.symbol !== orderForm.symbol.value.trim().toUpperCase()) return null;
    const lev = Number(sl.leverage);
    return lev > 0 && isFinite(lev) ? lev : null;
  }

  // Render the read-only leverage chip: a value, "loading" while a fetch is in
  // flight for the current symbol, or "unavailable" if the fetch couldn't resolve it.
  function updateLeverageDisplay() {
    const el = document.getElementById("sizing-lev-display");
    if (!el) return;
    const sym = orderForm.symbol.value.trim().toUpperCase();
    const sl = state.symbolLeverage;
    if (!sym) { el.innerHTML = "lev —"; return; }
    if (!sl || sl.symbol !== sym) { el.innerHTML = 'lev <span class="muted">…</span>'; return; }
    el.innerHTML = sl.leverage > 0
      ? `lev <b>${esc(String(sl.leverage))}×</b>`
      : 'lev <span class="warn">unavailable</span>';
  }

  // Monotonic token so a slower reply for the SAME symbol can't overwrite a newer
  // one (e.g. symbol re-selected, or a set-leverage re-fetch races the initial).
  let _levSeq = 0;

  // Fetch the exchange's real leverage for `symbol` and cache it in state. Guards:
  //  * out-of-order: applied only if it's still the LATEST request AND the field
  //    still holds this symbol (covers same-symbol and cross-symbol races);
  //  * fail-open: on error, leverage is marked unknown (null) — the ticket keeps
  //    working (Quantity mode unaffected; Margin mode refuses to guess);
  //  * empty symbol clears it. A cached record with leverage===null means
  //    "resolved but unavailable" (distinct from "still loading" = no record yet).
  async function fetchSymbolLeverage(symbol) {
    const sym = (symbol || "").trim().toUpperCase();
    const seq = ++_levSeq;
    if (!sym) { state.symbolLeverage = null; updateLeverageDisplay(); return; }
    let leverage = null;
    try {
      const data = await api(`/api/position/leverage?symbol=${encodeURIComponent(sym)}`);
      const lev = Number(data && data.leverage);
      if (lev > 0 && isFinite(lev)) leverage = lev;
    } catch (e) {
      /* leave leverage null -> sizing refuses to guess; never blocks the ticket */
    }
    if (seq !== _levSeq || orderForm.symbol.value.trim().toUpperCase() !== sym) return; // superseded
    state.symbolLeverage = { symbol: sym, leverage, ts: Date.now() };
    updateLeverageDisplay();
    updateOrderPreview();
  }

  // Base coin of a linear USDT symbol (e.g. "SOLUSDT" -> "SOL") for labelling the
  // derived quantity. Display-only; falls back to the raw symbol.
  function baseCoin(symbol) {
    const s = String(symbol || "").toUpperCase();
    const q = settleCoin();
    return s.endsWith(q) && s.length > q.length ? s.slice(0, -q.length) : s;
  }

  // Entry price used for sizing/preview: the typed limit price for a Limit order,
  // else the symbol's live last price (an estimate) for a Market order. Returns
  // { price: NaN } when no usable price is available yet.
  function resolveEntryPrice() {
    const symbol = orderForm.symbol.value.trim().toUpperCase();
    if (orderForm.orderType.value === "Limit") {
      const p = Number(orderForm.price.value.trim());
      return { price: p > 0 ? p : NaN, estimate: false };
    }
    if (state.orderLastPrice && state.orderLastPrice.symbol === symbol) {
      const p = Number(state.orderLastPrice.price);
      return { price: p > 0 ? p : NaN, estimate: true };
    }
    return { price: NaN, estimate: false };
  }

  // Margin sizing: in 'Margin' mode the user enters the USDT margin to commit and
  // we DERIVE the authoritative base-coin quantity (qty = margin × lev ÷ price),
  // floored to the lot step. The order payload is ALWAYS the qty field — the
  // margin value is never sent to the exchange. Re-run on every relevant change
  // so qty can never lag its inputs. No-op (never touches qty) in 'Quantity' mode.
  function recomputeMarginQty(price) {
    if (orderForm.sizeMode.value !== "margin") return;
    const margin = Number(orderForm.margin.value.trim());
    const lev = sizingLeverage();
    const sym = orderForm.symbol.value.trim().toUpperCase();
    // Need margin, price AND the real leverage — never guess leverage on the money
    // path. A null leverage (still loading / fetch failed) clears qty so the submit
    // guard blocks it and the hint explains why.
    if (!(margin > 0) || !(price > 0) || !(lev > 0)) { orderForm.qty.value = ""; return; }
    const spec = state.specs[sym];
    // Never derive a qty without the instrument's lot step: an unfloored qty is
    // rejected by the exchange and would make the notional/margin preview wrong.
    // Clear qty until the spec loads (fetchInstrumentSpec re-runs this on arrival).
    if (!spec || spec.qtyStep == null) { orderForm.qty.value = ""; return; }
    const snapped = snapToStep((margin * lev) / price, spec.qtyStep);
    // Flooring to the lot step can round a tiny margin down to 0 — treat that as
    // "no quantity" so the submit guard blocks it rather than sending qty "0".
    orderForm.qty.value = snapped && Number(snapped) > 0 ? snapped : "";
  }

  function updateOrderPreview() {
    const symbol = orderForm.symbol.value.trim().toUpperCase();
    const side = orderForm.side.value;
    const { price: entryNum, estimate } = resolveEntryPrice();

    updateLeverageDisplay();

    // In Margin mode, re-derive qty BEFORE reading it so the notional/PnL below
    // and the submitted order all reflect the current margin/lev/price inputs.
    recomputeMarginQty(entryNum);

    const qty = orderForm.qty.value.trim();
    const tp = orderForm.takeProfit.value.trim();
    const sl = orderForm.stopLoss.value.trim();
    const entry = entryNum > 0 ? String(entryNum) : "";
    const marginMode = orderForm.sizeMode.value === "margin";
    const lev = sizingLeverage(); // real leverage, or null if not known yet

    // Sizing hint: notional (qty × price) and the initial margin it implies
    // (notional ÷ leverage). In Margin mode we also lead with the resolved qty so
    // the exact size being ordered is always visible before submit. Reduce-only
    // orders commit no new margin, so the margin figure is omitted for them.
    if (orderNotional) {
      const marginTyped = Number(orderForm.margin.value.trim());
      const reduceOnly = orderForm.reduceOnly.checked;
      const spec = state.specs[symbol];
      if (Number(qty) > 0 && entryNum > 0) {
        const notional = Number(qty) * entryNum;
        const parts = [];
        if (marginMode) parts.push(`→ <b>${esc(qty)}</b> ${esc(baseCoin(symbol))}`);
        parts.push(`${fmtNum(notional)} ${esc(settleCoin())} notional${estimate ? " (at market)" : ""}`);
        // Margin figure only when the real leverage is known (never shown against a guess).
        if (!reduceOnly && lev > 0) parts.push(`margin ≈ <b>${fmtNum(notional / lev)}</b> ${esc(settleCoin())} <span class="muted">(${lev}×)</span>`);
        // Entry-fee estimate: a market order pays taker; a limit can fill either
        // side, so show the maker–taker band (Post-Only pins it to maker).
        if (orderForm.orderType.value === "Market") {
          parts.push(`fee ≈ ${fmtNum(notional * TAKER_FEE_RATE, 4)}`);
        } else if (orderForm.timeInForce && orderForm.timeInForce.value === "PostOnly") {
          parts.push(`fee ≈ ${fmtNum(notional * MAKER_FEE_RATE, 4)} <span class="muted">(maker)</span>`);
        } else {
          parts.push(`fee ≈ ${fmtNum(notional * MAKER_FEE_RATE, 4)}–${fmtNum(notional * TAKER_FEE_RATE, 4)}`);
        }
        orderNotional.innerHTML = parts.join('<span class="sep">·</span>');
      } else if (marginMode && marginTyped > 0 && !(entryNum > 0)) {
        orderNotional.innerHTML = `<span class="warn">enter a limit price (or wait for the market price) to size by margin</span>`;
      } else if (marginMode && marginTyped > 0 && !(lev > 0)) {
        // Distinguish "still fetching" (no record for this symbol yet) from
        // "resolved but no leverage available" (fetch returned/failed) so the hint
        // doesn't say "loading…" forever after a failure or on a hedge account.
        const resolved = state.symbolLeverage && state.symbolLeverage.symbol === symbol;
        orderNotional.innerHTML = resolved
          ? `<span class="warn">leverage unavailable for ${esc(baseCoin(symbol))} — size by Quantity, or set leverage under Account</span>`
          : `<span class="muted">loading leverage for ${esc(baseCoin(symbol))}…</span>`;
      } else if (marginMode && marginTyped > 0 && (!spec || spec.qtyStep == null)) {
        orderNotional.innerHTML = `<span class="muted">loading ${esc(baseCoin(symbol))} contract details…</span>`;
      } else if (marginMode && marginTyped > 0 && entryNum > 0) {
        const minTxt = spec && spec.minOrderQty != null ? ` (min ${esc(spec.minOrderQty)})` : "";
        orderNotional.innerHTML = `<span class="warn">margin too small for one lot step${minTxt} — increase margin or leverage</span>`;
      } else {
        orderNotional.textContent = "";
      }
    }

    if (!entry || !qty || (!tp && !sl) || orderForm.reduceOnly.checked) {
      orderPreview.innerHTML = "";
      return;
    }
    const line = (label, price) => {
      if (!(Number(price) > 0)) return "";
      const r = projectedPnl({ side, entry, exitPrice: price, size: qty });
      if (!r) return "";
      const note = estimate ? `net of exit fee · est. entry ${esc(entry)}` : "net of exit fee";
      // Write surface (order ticket) — keep the projected PnL in USDT (convert=false)
      // to match the USDT label and the USDT-denominated inputs.
      return `<div>${label} @ ${esc(price)}: ${projAmount(r, false, false)} ${esc(settleCoin())} <span class="muted">${note}</span></div>`;
    };
    orderPreview.innerHTML = line("TP", tp) + line("SL", sl);
  }

  // A preview must never interfere with typing into the order form: any error
  // here is swallowed so it can't disrupt the (separate) submit handler.
  ["input", "change"].forEach((ev) =>
    orderForm.addEventListener(ev, (e) => {
      try {
        if (e.target.name === "symbol") {
          const sym = orderForm.symbol.value.trim().toUpperCase();
          clearTimeout(_lastPriceTimer);
          _lastPriceTimer = setTimeout(() => {
            fetchSymbolLeverage(sym);  // REAL account leverage — issued first (drives margin sizing)
            fetchMarketPrice(sym);     // live last price (sizing + market preview)
            fetchInstrumentSpec(sym);  // tick/lot filters -> spec strip
            setActiveSymbol(sym);      // load the order-book widget for this symbol
          }, 400);
        } else if (e.target.name === "orderType" && orderForm.orderType.value === "Market") {
          const sym = orderForm.symbol.value.trim().toUpperCase();
          clearTimeout(_lastPriceTimer);
          _lastPriceTimer = setTimeout(() => fetchMarketPrice(sym), 400);
        }
        updateOrderPreview();
      } catch (err) {
        console.debug("order preview update failed", err);
      }
    })
  );

  // %-of-balance sizing: "commit X% of available as margin". In Margin mode we fill
  // the margin field (qty is derived from it once leverage/price load); in Quantity
  // mode we fill qty directly using the REAL leverage. Both resolve to the SAME
  // size: qty = (avail × pct × lev) ÷ price. Leverage is never part of the payload.
  const sizingBtns = document.getElementById("sizing-btns");
  if (sizingBtns) {
    sizingBtns.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pct]");
      if (!b) return;
      const pct = Number(b.dataset.pct) / 100;
      const avail = Number(state.available);
      const sym = orderForm.symbol.value.trim().toUpperCase();
      if (!(avail > 0)) { toast("Available balance not loaded yet.", "warn"); return; }
      if (orderForm.sizeMode.value === "margin") {
        // The margin <input> shows a raw balance-derived figure that CSS privacy
        // masking cannot hide (it masks text, not input values). Don't leak the
        // balance on screen while privacy mode is on.
        if (document.body.classList.contains("privacy-on")) {
          toast("Turn off privacy mode to size by % (it would show your balance).", "warn");
          return;
        }
        // Setting the margin is valid regardless of leverage; qty derives once the
        // real leverage (and price) are available.
        orderForm.margin.value = String(Number((avail * pct).toFixed(2)));
        updateOrderPreview();
        return;
      }
      // Quantity mode also writes a balance-derived figure (the qty) into a
      // visible input. CSS privacy masks text, not <input> values, so — exactly
      // like the Margin branch above — refuse to size by % while privacy is on
      // rather than paint the (balance-derived) size on screen.
      if (document.body.classList.contains("privacy-on")) {
        toast("Turn off privacy mode to size by % (it would show your balance).", "warn");
        return;
      }
      // Quantity mode needs the real leverage to convert margin→qty.
      const lev = sizingLeverage();
      if (!(lev > 0)) { toast("Leverage not loaded yet for this symbol.", "warn"); return; }
      let price = orderForm.orderType.value === "Limit" ? Number(orderForm.price.value) : NaN;
      if (!(price > 0) && state.orderLastPrice && state.orderLastPrice.symbol === sym) {
        price = Number(state.orderLastPrice.price);
      }
      if (!(price > 0)) { toast("Enter a symbol (and price for a Limit) to size by %.", "warn"); return; }
      const qty = (avail * pct * lev) / price;
      const spec = state.specs[sym];
      // Mirror recomputeMarginQty: never write an unfloored/full-precision qty.
      // Without the lot step the value isn't snapped (and can render as "1e-7"),
      // which the exchange rejects — clear it and prompt to retry once specs load.
      if (!spec || spec.qtyStep == null) {
        orderForm.qty.value = "";
        toast("Contract details still loading — try again in a moment.", "warn");
        updateOrderPreview();
        return;
      }
      const snapped = snapToStep(qty, spec.qtyStep);
      orderForm.qty.value = snapped && Number(snapped) > 0 ? snapped : "";
      updateOrderPreview();
    });
  }

  // Segmented Buy/Sell & Market/Limit toggles mirror the (sr-only) <select>s,
  // which remain the source of truth — so every existing handler keeps working.
  const wireSegment = (segId, selectEl) => {
    const seg = document.querySelector(segId);
    if (!seg || !selectEl) return;
    const buttons = Array.from(seg.querySelectorAll("button"));
    const paint = () =>
      buttons.forEach((b) => {
        const on = b.dataset.val === selectEl.value;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    buttons.forEach((b) =>
      b.addEventListener("click", () => {
        if (selectEl.value === b.dataset.val) return;
        selectEl.value = b.dataset.val;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        selectEl.dispatchEvent(new Event("input", { bubbles: true }));
        paint();
      })
    );
    // Arrow-key navigation between the mutually-exclusive options (expected of a
    // segmented single-select), moving focus and selection to the adjacent button.
    seg.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const enabled = buttons.filter((b) => !b.disabled);
      if (enabled.length < 2) return;
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const cur = enabled.indexOf(document.activeElement);
      const next = enabled[((cur < 0 ? 0 : cur) + dir + enabled.length) % enabled.length];
      if (next) { e.preventDefault(); next.click(); next.focus(); }
    });
    // Keep the buttons in sync if the select is reset/changed programmatically
    // (e.g. f.reset() after a successful order).
    selectEl.addEventListener("change", paint);
    paint();
  };
  wireSegment("#seg-side", orderForm.side);
  wireSegment("#seg-type", orderForm.orderType);
  wireSegment("#seg-sizemode", orderForm.sizeMode);

  // Reinforce Buy/Sell intent at the point of commit: colour + label the Submit
  // button to match the selected side (green Buy / red Sell), so a mistoggled side
  // has a last-line-of-defense cue right where the click happens. Reads the side
  // <select> (source of truth); presentation only — the order payload is unchanged.
  const submitBtn = orderForm.querySelector('button[type="submit"]');
  function paintSubmit() {
    if (!submitBtn) return;
    const isBuy = orderForm.side.value === "Buy";
    submitBtn.classList.toggle("submit-buy", isBuy);
    submitBtn.classList.toggle("submit-sell", !isBuy);
    const sym = orderForm.symbol.value.trim().toUpperCase();
    submitBtn.textContent = `${isBuy ? "Buy" : "Sell"}${sym ? " " + sym : ""} order`;
  }
  orderForm.side.addEventListener("change", paintSubmit);
  orderForm.symbol.addEventListener("input", paintSubmit);
  paintSubmit();

  // 'Size by' toggle: show the Quantity input or the Margin input (never both).
  // The Margin field is a sizing helper only — it derives qty (see
  // recomputeMarginQty) and is never part of the order payload.
  const syncSizeMode = () => {
    const marginMode = orderForm.sizeMode.value === "margin";
    // Carry the size across a Quantity→Margin switch: seed the (empty) margin
    // field from the qty already entered so toggling modes never silently
    // discards a size the user typed. Margin = qty × price ÷ leverage.
    if (marginMode && !orderForm.margin.value.trim()) {
      const { price } = resolveEntryPrice();
      const qtyNum = Number(orderForm.qty.value.trim());
      const lev = sizingLeverage();
      if (qtyNum > 0 && price > 0 && lev > 0) {
        orderForm.margin.value = String(Number(((qtyNum * price) / lev).toFixed(2)));
      }
    }
    document.querySelectorAll(".sizeby-qty").forEach((el) => (el.style.display = marginMode ? "none" : ""));
    document.querySelectorAll(".sizeby-margin").forEach((el) => (el.style.display = marginMode ? "" : "none"));
    updateOrderPreview();
  };
  orderForm.sizeMode.addEventListener("change", syncSizeMode);
  syncSizeMode();

  // Reduce-only closes a known position size — committing fresh margin is
  // meaningless there — so lock the form to Quantity mode while it's checked.
  const marginModeBtn = document.querySelector('#seg-sizemode button[data-val="margin"]');
  const syncReduceOnly = () => {
    const ro = orderForm.reduceOnly.checked;
    if (marginModeBtn) {
      marginModeBtn.disabled = ro; // native: a disabled button can't be clicked
      marginModeBtn.setAttribute("aria-disabled", String(ro));
    }
    if (ro && orderForm.sizeMode.value === "margin") {
      orderForm.sizeMode.value = "qty"; // preserves the last derived qty in the field
      orderForm.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  orderForm.reduceOnly.addEventListener("change", syncReduceOnly);
  syncReduceOnly();

  $("#leverage-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#leverage-result"), () => {
      const body = {
        symbol: f.symbol.value.trim().toUpperCase(),
        buyLeverage: f.buyLeverage.value.trim(),
        sellLeverage: f.sellLeverage.value.trim(),
      };
      if (!body.symbol || !body.buyLeverage || !body.sellLeverage)
        throw new Error("symbol and both leverage values are required");

      const reqLev = Math.max(Number(body.buyLeverage) || 0, Number(body.sellLeverage) || 0);
      const spec = state.specs[body.symbol];
      // Advisory only — NEVER blocks (server stays authoritative, as before).
      // An over-max request is surfaced as a warning and forces the typed confirm.
      const overMax = !!(spec && spec.maxLeverage != null && reqLev > Number(spec.maxLeverage));

      // Keep the no-prompt convenience for routine changes, but require the
      // typed confirm for a large jump (≥2× the current leverage, or ≥25x) since
      // that materially moves the liquidation price.
      const posForSym = (state.lastPositions || []).find(
        (p) => p.symbol === body.symbol && Number(p.size) !== 0
      );
      const curLev = posForSym ? Number(posForSym.leverage) : null;
      const bigJump = reqLev >= 25 || (curLev && curLev > 0 && reqLev >= curLev * 2);
      const lvLines = [
        ["Buy leverage", `${body.buyLeverage}×`],
        ["Sell leverage", `${body.sellLeverage}×`],
      ];
      if (curLev) lvLines.push(["Current", `${curLev}×`]);
      return {
        path: "/api/position/set-leverage",
        body,
        skipConfirm: !bigJump && !overMax, // trade token still required regardless
        confirmMsg: {
          head: `Set leverage — ${body.symbol}`,
          lines: lvLines,
          note: overMax
            ? `⚠ ${reqLev}x exceeds the ${body.symbol} maximum (${spec.maxLeverage}x); the exchange may reject it.`
            : "Higher leverage moves your liquidation price closer to the mark.",
        },
        successMsg: () => `✓ Leverage set for ${body.symbol}`,
        onSuccess: () => {
          refreshDashboardSoon();
          // If the ticket is on this symbol, refresh its leverage so the sizer
          // reflects the change immediately.
          if (orderForm.symbol.value.trim().toUpperCase() === body.symbol) fetchSymbolLeverage(body.symbol);
        },
      };
    });
  });

  const cancelAll = $("#cancel-all-btn");
  if (cancelAll) {
    cancelAll.addEventListener("click", () => {
      runWrite(cancelAll, null, () => ({
        path: "/api/order/cancel-all",
        body: {},
        confirmMsg: `Cancel ALL open orders for ${settleCoin()}.`,
        successMsg: () => "✓ Cancel-all sent",
        onSuccess: () => refreshDashboardSoon(),
      })).catch((err) => toast("Cancel-all failed: " + err.message, "neg"));
    });
  }

  $("#margin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#margin-result"), () => {
      const body = { setMarginMode: f.setMarginMode.value };
      return {
        path: "/api/account/set-margin-mode",
        body,
        confirmMsg: `Set account margin mode to ${body.setMarginMode}.`,
        successMsg: () => `✓ Margin mode set to ${body.setMarginMode}`,
      };
    });
  });

  $("#transfer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#transfer-result"), () => {
      const amount = Number(f.amount.value);
      if (!(amount > 0) || !isFinite(amount)) throw new Error("amount must be a finite number greater than 0");
      const body = {
        direction: f.direction.value,
        amount,
        quote_asset: f.quote_asset.value,
      };
      // Idempotency key OWNED by the client, keyed on the exact transfer intent
      // (direction+amount+asset). A retry after a local timeout reuses the SAME
      // id, so the exchange dedups it instead of moving funds twice. It is cleared
      // ONLY on confirmed success, so a genuinely-repeated identical transfer
      // later gets a fresh id (and is not wrongly deduped as a replay).
      const intentKey = `${body.direction}|${body.amount}|${body.quote_asset}`;
      body.client_txn_id = transferTxnId(intentKey);
      return {
        path: "/api/funds/transfer",
        body,
        confirmMsg: `Transfer ${body.amount} ${body.quote_asset} (${body.direction}). This moves real funds.`,
        // The backend only resolves on a POSITIVELY confirmed transfer (exchange
        // txn_id present), so this is a real confirmation, not a hedge. Show the
        // txn id when the exchange returns one.
        successMsg: (res) => {
          const txn = res && res.data && (res.data.txn_id || res.data.txnId);
          return "✓ Transfer completed" + (txn ? ` (txn ${txn})` : "");
        },
        onSuccess: () => { clearTransferTxnId(intentKey); f.reset(); refreshDashboardSoon(); },
        // Definitive 4xx = the exchange evaluated and refused this transfer —
        // rotate the key so a corrected retry isn't replay-deduped into a no-op.
        // 5xx/network errors keep the key: that retry MUST dedup.
        onError: (err) => {
          if (err && err.status >= 400 && err.status < 500) clearTransferTxnId(intentKey);
        },
      };
    });
  });
}

// ---------------------------------------------------------------------------
// API Explorer (read-only queries, available to any logged-in user)
// Each query renders a formatted table; raw JSON stays available via a toggle.
// ---------------------------------------------------------------------------

// --- formatting helpers ---
function cell(v) {
  return v === undefined || v === null || v === "" ? "—" : v;
}
function sideClass(side) {
  return String(side || "").toLowerCase() === "buy" ? "pos" : "neg";
}
function fmtTime(ms) {
  if (ms === undefined || ms === null || ms === "") return "—";
  const n = Number(ms);
  if (!isFinite(n)) return esc(String(ms));
  const d = new Date(n > 1e12 ? n : n * 1000); // ms vs seconds
  return d.toLocaleString();
}
function pct(v) {
  const n = Number(v);
  return isFinite(n) ? (n * 100).toFixed(2) + "%" : "—";
}
function emptyMsg(msg) {
  return `<p class="muted center" style="padding:18px">${esc(msg || "No data")}</p>`;
}
// Standard ERROR block for panel bodies: bordered + tinted so a failure reads
// as a failure at a glance (not as data or an empty state), and role="alert"
// so screen readers announce it with the same urgency as the error toasts.
function errorMsg(msg) {
  return `<div class="error-block" role="alert">⚠ ${esc(msg || "Request failed")}</div>`;
}
// Standard LOADING line (subtle pulse via CSS; stilled under reduced motion).
function loadingMsg(label) {
  return `<p class="loading-msg muted">${esc(label || "Loading…")}</p>`;
}
function listOf(data) {
  const r = data && data.result;
  if (r && Array.isArray(r.list)) return r.list;
  if (Array.isArray(r)) return r;
  return [];
}
// Build a table. columns: [{label, get:(row)=>value, cls?:(row)=>className,
// raw?:(row)=>html, priv?:bool}]. `raw` injects pre-built HTML for a cell (used
// for sign-coloured funding %, fill/range gauges). IMPORTANT: a raw producer
// must build its HTML only from numeric/own values — never from unescaped
// exchange strings. `priv: true` marks the column as a private account figure
// (money/size/PnL) so the privacy toggle masks it; leave it off for public
// market columns (prices on Tickers, instrument specs, …). Every cell carries
// data-label so the mobile card layout can label values.
function buildTable(rows, columns) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        "<tr>" +
        columns
          .map((c) => {
            const extra = (c.priv ? " priv" : "") + (c.cls ? " " + c.cls(r) : "");
            const lbl = ` data-label="${esc(c.label)}"`;
            // c.money => currency-convert the value (INR mode) via cvtCell;
            // c.raw => caller-built safe HTML; otherwise escaped raw value.
            const inner = c.raw ? c.raw(r)
              : c.money ? cvtCell(c.get(r), c.digits)
              : esc(cell(c.get(r)));
            return `<td class="mono${extra}"${lbl}>${inner}</td>`;
          })
          .join("") +
        "</tr>"
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Key/value table for a single object.
function buildKV(obj, fields) {
  const entries = fields
    ? fields.map((f) => [f.label, obj ? obj[f.key] : undefined])
    : Object.entries(obj || {});
  if (!entries.length) return emptyMsg();
  const rows = entries
    .map(([k, v]) => {
      const val = v && typeof v === "object" ? JSON.stringify(v) : v;
      return `<tr><th>${esc(k)}</th><td class="mono">${esc(cell(val))}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="kv"><tbody>${rows}</tbody></table></div>`;
}
// Generic fallback: array-of-objects → table; object → kv; else raw.
function autoRender(data) {
  const list = listOf(data);
  if (list.length) {
    const keys = Object.keys(list[0]);
    return buildTable(
      list,
      keys.map((k) => ({ label: k, get: (r) => (r[k] && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]) }))
    );
  }
  const r = data && data.result;
  if (r && typeof r === "object" && !Array.isArray(r)) return buildKV(r);
  return `<pre class="json-view">${esc(JSON.stringify(data, null, 2))}</pre>`;
}

// --- per-endpoint renderers ---
function renderWallet(data) {
  const acct = listOf(data)[0];
  if (!acct) return autoRender(data);
  // Third tuple element = private account figure (masked by the privacy toggle).
  const rows = [
    ["Account Type", esc(cell(acct.accountType))],
    ["Total Equity", cvtCell(acct.totalEquity, 2), true],
    ["Wallet Balance", cvtCell(acct.totalWalletBalance, 2), true],
    ["Available Balance", cvtCell(acct.totalAvailableBalance, 2), true],
    ["Margin Balance", cvtCell(acct.totalMarginBalance, 2), true],
    ["Unrealised PnL", cvtCell(acct.totalPerpUPL, 2), true],
    ["Initial Margin", cvtCell(acct.totalInitialMargin, 2), true],
    ["Maint. Margin", cvtCell(acct.totalMaintenanceMargin, 2), true],
    ["Display Currency", esc(curUnit())],
  ];
  const summary =
    `<div class="table-wrap"><table class="kv"><tbody>` +
    rows.map(([k, v, priv]) => `<tr><th>${esc(k)}</th><td class="mono${priv ? " priv" : ""}">${v}</td></tr>`).join("") +
    `</tbody></table></div>`;
  const coins = acct.coin || [];
  // Per-coin balances (equity/wallet/available/PnL) are denominated in the
  // COIN's own units (e.g. BTC), so the ×94 INR lens only applies to the settle
  // coin (USDT). For other coins show the native amount unchanged. usdValue is a
  // USD-equivalent, so it converts for every row.
  const coinAmt = (c, v) => (c.coin === settleCoin() ? cvtCell(v, 2) : esc(cell(v)));
  const coinTable = coins.length
    ? buildTable(coins, [
        { label: "Coin", get: (c) => c.coin },
        { label: "Equity", raw: (c) => coinAmt(c, c.equity), priv: true },
        { label: "Wallet Bal", raw: (c) => coinAmt(c, c.walletBalance), priv: true },
        { label: "Available", raw: (c) => coinAmt(c, c.availableToWithdraw ?? c.availableToBorrow), priv: true },
        { label: "Unreal PnL", raw: (c) => coinAmt(c, c.unrealisedPnl), cls: (c) => pnlClass(c.unrealisedPnl), priv: true },
        { label: "Realised PnL", raw: (c) => coinAmt(c, c.cumRealisedPnl), cls: (c) => pnlClass(c.cumRealisedPnl), priv: true },
        { label: `Value (${curUnit()})`, get: (c) => c.usdValue, money: true, digits: 2, priv: true },
      ])
    : "";
  return summary + coinTable;
}

function renderAccountInfo(data) {
  return data && data.result ? buildKV(data.result) : autoRender(data);
}

// Withdrawable amounts are monetary (USDT) → convert in INR mode. Only fields
// whose key names a money amount are converted (defensive: never rescale a
// stray non-monetary number); everything else is shown raw + escaped.
const _MONEY_KEY = /amount|balance|withdraw|available|equity|margin|value|pnl/i;
function renderWithdrawable(data) {
  const r = data && data.result;
  if (!r || typeof r !== "object" || Array.isArray(r)) return autoRender(data);
  const kv = (obj) => {
    const rows = Object.entries(obj).map(([k, v]) => {
      const isNum = v !== "" && v !== null && typeof v !== "object" && isFinite(Number(v));
      const isMoney = isNum && _MONEY_KEY.test(k);
      const html = isMoney ? cvtCell(v, 2) : esc(cell(v));
      // Money amounts are private (masked by the privacy toggle); other fields stay.
      return `<tr><th>${esc(k)}</th><td class="mono${isMoney ? " priv" : ""}">${html}</td></tr>`;
    });
    return `<div class="table-wrap"><table class="kv"><tbody>${rows.join("")}</tbody></table></div>`;
  };
  return Array.isArray(r.list) ? r.list.map(kv).join("") : kv(r);
}

function renderServerTime(data) {
  const r = (data && data.result) || {};
  const sec = r.timeSecond ?? (data && data.time ? Number(data.time) / 1000 : null);
  const dt = sec != null && isFinite(Number(sec)) ? new Date(Number(sec) * 1000) : null;
  return buildKV({
    "timeSecond": r.timeSecond,
    "timeNano": r.timeNano,
    "Parsed (UTC)": dt ? dt.toISOString() : "—",
    "Local time": dt ? dt.toLocaleString() : "—",
  });
}

function renderInstruments(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No instruments");
  return buildTable(list, [
    { label: "Symbol", get: (i) => i.symbol },
    { label: "Status", get: (i) => i.status },
    { label: "Type", get: (i) => i.contractType },
    { label: "Base", get: (i) => i.baseCoin },
    { label: "Quote", get: (i) => i.quoteCoin },
    { label: "Settle", get: (i) => i.settleCoin },
    { label: "Tick Size", get: (i) => i.priceFilter && i.priceFilter.tickSize },
    { label: "Qty Step", get: (i) => i.lotSizeFilter && i.lotSizeFilter.qtyStep },
    { label: "Min Qty", get: (i) => i.lotSizeFilter && i.lotSizeFilter.minOrderQty },
    { label: "Max Qty", get: (i) => i.lotSizeFilter && i.lotSizeFilter.maxOrderQty },
    { label: "Max Lev", get: (i) => i.leverageFilter && i.leverageFilter.maxLeverage },
  ]);
}

// Cap the number of ROWS painted into the DOM for history tables. An "Overall"
// read can return up to 10k rows per mirror; rendering them all in one
// innerHTML janks for seconds (and can OOM a phone tab). Totals and analytics
// are always computed over the FULL list — only the visible rows are capped.
const HISTORY_RENDER_MAX = 500;

function _renderCapNote(total) {
  if (total <= HISTORY_RENDER_MAX) return "";
  return `<p class="muted" style="padding:8px 16px">Showing the ${HISTORY_RENDER_MAX} newest of ${total} records — totals above cover all of them. Narrow the range or filter by symbol to see older rows.</p>`;
}

function renderClosedPnl(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No closed PnL records");
  // The server merges several <=7-day windows (a month by default). `truncated`
  // means a safety cap stopped it short, so this total may be incomplete — say so
  // rather than presenting a partial figure as the full picture.
  const truncated = !!(data && data.result && data.result.truncated);
  const truncNote = truncated
    ? ` · <span class="neg" title="A fetch cap was hit; some older records may be missing.">⚠ partial</span>`
    : "";
  const total = list.reduce((s, r) => s + (Number(r.closedPnl) || 0), 0);
  const table = buildTable(list.slice(0, HISTORY_RENDER_MAX), [
    { label: "Closed At", get: (r) => fmtTime(r.updatedTime ?? r.createdTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Qty", get: (r) => r.qty ?? r.closedSize, priv: true },
    { label: "Entry", get: (r) => r.avgEntryPrice, money: true, priv: true },
    { label: "Exit", get: (r) => r.avgExitPrice, money: true, priv: true },
    { label: "Closed PnL", get: (r) => r.closedPnl, cls: (r) => pnlClass(r.closedPnl), money: true, digits: 2, priv: true },
    { label: "Leverage", get: (r) => r.leverage, priv: true },
  ]);
  return (
    `<div class="explorer-summary">Total closed PnL: <span class="${pnlClass(total)} priv">${fmtMoney(total)} ${esc(curUnit())}</span> · ${list.length} record(s)${truncNote}</div>` +
    table + _renderCapNote(list.length)
  );
}

function renderExecutions(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No trades");
  return buildTable(list.slice(0, HISTORY_RENDER_MAX), [
    { label: "Time", get: (r) => fmtTime(r.execTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Type", get: (r) => r.orderType },
    { label: "Exec Qty", get: (r) => r.execQty, priv: true },
    { label: "Exec Price", get: (r) => r.execPrice, money: true, priv: true },
    { label: "Exec Value", get: (r) => r.execValue, money: true, digits: 2, priv: true },
    { label: "Fee", get: (r) => r.execFee, money: true, digits: 4, priv: true },
    { label: "Maker", get: (r) => r.isMaker },
  ]) + _renderCapNote(list.length);
}

function renderTickers(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No tickers");
  return buildTable(list, [
    { label: "Symbol", get: (t) => t.symbol },
    { label: "Last", get: (t) => t.lastPrice, money: true },
    { label: "Mark", get: (t) => t.markPrice, money: true },
    { label: "Index", get: (t) => t.indexPrice, money: true },
    { label: "24h %", get: (t) => pct(t.price24hPcnt), cls: (t) => pnlClass(t.price24hPcnt) },
    { label: "24h High", get: (t) => t.highPrice24h, money: true },
    { label: "24h Low", get: (t) => t.lowPrice24h, money: true },
    { label: "Bid", get: (t) => t.bid1Price, money: true },
    { label: "Ask", get: (t) => t.ask1Price, money: true },
    { label: "Funding", raw: (t) => fmtFundingHTML(t.fundingRate) },
    { label: "Open Int", get: (t) => t.openInterest },
  ]);
}

function renderOrderBook(data) {
  const r = (data && data.result) || {};
  const bids = r.b || [];
  const asks = r.a || [];
  if (!bids.length && !asks.length) return autoRender(data);
  // Fall back to the generic renderer if the rows aren't [price, size] pairs.
  if (!bids.every(Array.isArray) || !asks.every(Array.isArray)) return autoRender(data);
  return (
    `<div class="explorer-summary">${esc(cell(r.s))} — order book (${esc(curUnit())})</div>` +
    `<div class="book-widget" style="padding:8px 0 12px">${renderBookLadder(data, { depth: 25, convert: true })}</div>`
  );
}

function renderPositionsTable(data) {
  const list = listOf(data).filter((p) => Number(p.size) !== 0);
  if (!list.length) return emptyMsg("No open positions");
  return buildTable(list, [
    { label: "Symbol", get: (p) => p.symbol },
    { label: "Side", get: (p) => p.side, cls: (p) => sideClass(p.side) },
    { label: "Size", get: (p) => p.size, priv: true },
    { label: "Entry", get: (p) => p.avgPrice, money: true, priv: true },
    { label: "Mark", get: (p) => p.markPrice, money: true },
    { label: "Lev", get: (p) => (p.leverage ? p.leverage + "x" : "—"), priv: true },
    { label: "Value", get: (p) => p.positionValue, money: true, priv: true },
    { label: "Unreal PnL", get: (p) => p.unrealisedPnl, cls: (p) => pnlClass(p.unrealisedPnl), money: true, digits: 2, priv: true },
  ]);
}

function renderOrdersTable(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No open orders");
  return buildTable(list, [
    { label: "Symbol", get: (o) => o.symbol },
    { label: "Side", get: (o) => o.side, cls: (o) => sideClass(o.side) },
    { label: "Type", get: (o) => o.orderType },
    { label: "Qty", get: (o) => o.qty, priv: true },
    { label: "Price", get: (o) => o.price, money: true, priv: true },
    { label: "Trigger", get: (o) => o.triggerPrice, money: true, priv: true },
    { label: "Status", get: (o) => o.orderStatus },
  ]);
}

const EXPLORER_QUERIES = [
  { label: "Wallet Balance", path: "/api/balance", render: renderWallet },
  { label: "Withdrawable", path: "/api/withdrawable", render: renderWithdrawable },
  { label: "Account Info", path: "/api/account-info", render: renderAccountInfo },
  { label: "Server Time", path: "/api/server-time", render: renderServerTime },
  { label: "Positions", path: "/api/positions", render: renderPositionsTable },
  { label: "Open Orders", path: "/api/orders", render: renderOrdersTable },
  { label: "Instruments", path: "/api/instruments", sym: true, render: renderInstruments },
  { label: "Tickers", path: "/api/tickers", sym: true, render: renderTickers },
  { label: "Order Book", path: "/api/orderbook", sym: true, symRequired: true, render: renderOrderBook },
  { label: "Closed PnL", path: "/api/closed-pnl", sym: true, render: renderClosedPnl },
  { label: "Trades History", path: "/api/executions", sym: true, render: renderExecutions },
];

// Render a formatted explorer result + its collapsible raw JSON. Shared by the
// query click handler and the currency-toggle re-render so they never diverge.
function renderExplorerOutput(out, render, data) {
  const raw = `<details class="raw-json"><summary>Raw JSON</summary><pre class="json-view">${esc(
    JSON.stringify(data, null, 2)
  )}</pre></details>`;
  out.innerHTML = (render || autoRender)(data) + raw;
}

function wireExplorer() {
  const container = $("#explorer-buttons");
  const out = $("#explorer-result");
  if (!container) return;

  EXPLORER_QUERIES.forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "btn-ghost sm";
    btn.textContent = q.label;
    btn.addEventListener("click", async () => {
      const symbol = $("#explorer-symbol").value.trim().toUpperCase();
      if (q.symRequired && !symbol) {
        out.innerHTML = errorMsg(`"${q.label}" requires a symbol.`);
        return;
      }
      let url = q.path;
      if (q.sym && symbol) url += `?symbol=${encodeURIComponent(symbol)}`;
      out.innerHTML = loadingMsg(`Loading ${q.label}…`);
      try {
        const data = await api(url);
        // Cache so a currency toggle can re-render this result in the new unit.
        state.lastExplorer = { render: q.render || autoRender, data };
        renderExplorerOutput(out, state.lastExplorer.render, data);
      } catch (err) {
        state.lastExplorer = null;
        out.innerHTML = errorMsg(err.message);
      }
    });
    container.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Tabs + Markets + History (read-only, available to both roles)
// ---------------------------------------------------------------------------
function wireTabs() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;
  const panes = document.querySelectorAll("main .pane");
  const show = (name, focus = false) => {
    // Keep the ARIA tab state and roving tabindex in lockstep with `active`, so a
    // screen reader announces the selected view and only the active tab is a Tab stop.
    tabs.querySelectorAll(".tab").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name !== "markets") clearInterval(_marketsTimer); // stop polling when away
    if (name === "markets") onMarketsActive();
    // Scanner: poll only while visible (its background alert tick, when armed,
    // is managed separately by scEnsureAlertTimer).
    if (name !== "scanner") clearInterval(_scTimer);
    if (name === "scanner") onScannerActive();
    // PnL tab (pnl.js): refetch its Redis-backed series only while visible
    // (the live current value rides the shared WS snapshot regardless).
    if (name !== "pnl") clearInterval(_pnTimer);
    if (name === "pnl") onPnlActive();
    // The "history" pane is the Trading Journal (journal.js) — the pane id is
    // kept for workspace-state continuity with saved layouts.
    if (name === "history") onJournalActive();
    if (name === "funding") onFundingActive();
    if (name === "ai") onAIActive();
    // Execution panel refreshes its day window only while the Trade tab shows.
    if (name === "dashboard") onExecActive();
    if (name === "account") onAccountActive();
    // Risk tab: refresh the daily history context while visible (the live
    // metrics themselves ride the shared WS snapshot, no extra polling).
    if (name === "risk") onRiskActive();
    // The order-book widget only polls while the dashboard is visible.
    if (name === "dashboard") { if (state.activeSymbol) startBookPolling(); }
    else stopBookPolling();
    // Live charts poll only while the dashboard is visible too.
    if (name === "dashboard") startChartPolling();
    else stopChartPolling();
  };
  tabs.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  // Arrow/Home/End roving expected of a tablist. Viewer-hidden tabs are removed
  // from the DOM (loadMe), so the live NodeList is already the reachable set.
  tabs.addEventListener("keydown", (e) => {
    // Up/Down mirror Left/Right: the nav renders as a VERTICAL rail on desktop
    // (aria-orientation=vertical) and horizontal on mobile — support both axes.
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const list = Array.from(tabs.querySelectorAll(".tab"));
    if (!list.length) return;
    const cur = list.indexOf(document.activeElement);
    let idx;
    if (e.key === "Home") idx = 0;
    else if (e.key === "End") idx = list.length - 1;
    else {
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      idx = ((cur < 0 ? 0 : cur) + fwd + list.length) % list.length;
    }
    e.preventDefault();
    show(list[idx].dataset.tab, true);
  });
}

// ===========================================================================
// WATCHLIST & MARKET MONITOR  (the "Watch" tab)
// ---------------------------------------------------------------------------
// A first-class market-monitoring surface built ON TOP of the existing
// /api/tickers snapshot poll — NO new backend endpoint and NO new polling
// loop: the same 15s Markets poll now also feeds the watchlist, builds a
// symbol→ticker index, appends a per-symbol tick history for sparklines, and
// evaluates price alerts. Sparklines are session-accumulated from observed
// ticks on purpose: the kline proxy is symbol-whitelisted + region-fragile, so
// it cannot serve arbitrary watchlist symbols — deriving trend from the ticks
// we already fetch is the correct reuse. Rows update IN PLACE (only changed
// cells repaint) so hundreds of symbols stay smooth and flash-free.
//
// Layout: a PURE, DOM-free core (top-level fns, unit-tested in test_snap.mjs)
// then the DOM manager. Everything here is display/navigation state — nothing
// can place, modify or cancel an order.
// ===========================================================================

const WL_STORE_KEY = "dma.watchlists.v1";
const WL_SCHEMA_VERSION = 1;
const WL_MAX_LISTS = 40;
const WL_MAX_SYMBOLS = 500;   // per list; also the render/perf ceiling
const WL_MAX_ALERTS = 100;
const WL_SPARK_POINTS = 40;   // tick-history depth per symbol
const WL_SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const WL_FILTERS = ["all", "fav", "gainers", "losers", "movers"];
const WL_SORTS = ["custom", "symbol", "price", "pct", "vol", "funding", "oi"];
const WL_ALERT_KINDS = ["above", "below", "pct_up", "pct_down", "funding_abs"];
const WL_MOVER_PCT = 0.05;    // |24h| ≥ 5% = "mover"

function wlId(prefix) {
  return (prefix || "wl") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function wlSanitizeSymbol(s) {
  const up = String(s == null ? "" : s).trim().toUpperCase();
  return WL_SYMBOL_RE.test(up) ? up : null;
}
function wlSanitizeSymbols(arr) {
  const out = [], seen = new Set();
  if (Array.isArray(arr)) {
    for (const s of arr) {
      const v = wlSanitizeSymbol(s);
      if (v && !seen.has(v)) { seen.add(v); out.push(v); if (out.length >= WL_MAX_SYMBOLS) break; }
    }
  }
  return out;
}
function wlSanitizeList(l) {
  if (!l || typeof l !== "object" || typeof l.id !== "string" || !l.id) return null;
  const now = Date.now();
  const symbols = wlSanitizeSymbols(l.symbols);
  const favs = wlSanitizeSymbols(l.favs).filter((s) => symbols.includes(s));
  return {
    id: l.id.slice(0, 40),
    name: String(l.name || "Watchlist").slice(0, 40),
    symbols, favs,
    createdAt: Number(l.createdAt) || now,
    updatedAt: Number(l.updatedAt) || now,
  };
}
function wlSanitizeAlert(a) {
  if (!a || typeof a !== "object") return null;
  const symbol = wlSanitizeSymbol(a.symbol);
  const value = Number(a.value);
  if (!symbol || !WL_ALERT_KINDS.includes(a.kind) || !isFinite(value)) return null;
  return {
    id: typeof a.id === "string" && a.id ? a.id.slice(0, 40) : wlId("al"),
    symbol, kind: a.kind, value,
    createdAt: Number(a.createdAt) || Date.now(),
    triggered: !!a.triggered,
  };
}
function wlNewDoc() {
  const fav = wlSanitizeList({ id: wlId("wl"), name: "Favorites", symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
  return { version: WL_SCHEMA_VERSION, activeId: fav.id, lists: [fav], alerts: [] };
}
// Parse storage into a guaranteed-valid doc. corrupt:true means the caller
// must quarantine the original blob (user data is never silently discarded);
// an unknown/future schema version is treated the same way.
function wlParseDoc(raw) {
  if (raw == null || raw === "") return { doc: wlNewDoc(), corrupt: false };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { doc: wlNewDoc(), corrupt: true }; }
  if (!parsed || typeof parsed !== "object" ||
      parsed.version !== WL_SCHEMA_VERSION || !Array.isArray(parsed.lists)) {
    return { doc: wlNewDoc(), corrupt: true };
  }
  const lists = parsed.lists.map(wlSanitizeList).filter(Boolean).slice(0, WL_MAX_LISTS);
  if (!lists.length) return { doc: wlNewDoc(), corrupt: true };
  const alerts = (Array.isArray(parsed.alerts) ? parsed.alerts : [])
    .map(wlSanitizeAlert).filter(Boolean).slice(0, WL_MAX_ALERTS);
  const activeId = lists.some((l) => l.id === parsed.activeId) ? parsed.activeId : lists[0].id;
  return { doc: { version: WL_SCHEMA_VERSION, activeId, lists, alerts }, corrupt: false };
}
// Accepts the export envelope ({kind:"watchlist", list:{…}}) or a bare list.
function wlValidateImport(obj) {
  let l = null;
  if (obj && typeof obj === "object") {
    if (obj.kind === "watchlist" && obj.list && typeof obj.list === "object") l = obj.list;
    else if (Array.isArray(obj.symbols)) l = obj;
  }
  if (!l) return null;
  return wlSanitizeList({ id: wlId("wl"), name: String(l.name || "Imported"), symbols: l.symbols, favs: l.favs });
}
function wlFindList(doc, id) { return doc.lists.find((l) => l.id === id) || null; }
function wlCreate(doc, name) {
  if (doc.lists.length >= WL_MAX_LISTS) return null;
  const l = wlSanitizeList({ id: wlId("wl"), name: name || `Watchlist ${doc.lists.length + 1}`, symbols: [] });
  doc.lists.push(l);
  doc.activeId = l.id;
  return l;
}
function wlRename(doc, id, name) {
  const l = wlFindList(doc, id);
  const clean = String(name || "").trim();
  if (!l || !clean) return false;
  l.name = clean.slice(0, 40); l.updatedAt = Date.now();
  return true;
}
function wlDuplicate(doc, id) {
  const base = wlFindList(doc, id);
  if (!base || doc.lists.length >= WL_MAX_LISTS) return null;
  const copy = wlSanitizeList({
    id: wlId("wl"), name: base.name.slice(0, 35) + " copy",
    symbols: base.symbols.slice(), favs: base.favs.slice(),
  });
  doc.lists.push(copy);
  doc.activeId = copy.id;
  return copy;
}
function wlDelete(doc, id) {
  if (doc.lists.length <= 1) return false; // last list is undeletable
  const before = doc.lists.length;
  doc.lists = doc.lists.filter((l) => l.id !== id);
  if (doc.lists.length === before) return false;
  if (doc.activeId === id) doc.activeId = doc.lists[0].id;
  return true;
}
function wlAddSymbol(doc, listId, sym) {
  const l = wlFindList(doc, listId);
  const v = wlSanitizeSymbol(sym);
  if (!l || !v || l.symbols.includes(v) || l.symbols.length >= WL_MAX_SYMBOLS) return false;
  l.symbols.push(v); l.updatedAt = Date.now();
  return true;
}
function wlRemoveSymbol(doc, listId, sym) {
  const l = wlFindList(doc, listId);
  const v = wlSanitizeSymbol(sym);
  if (!l || !v || !l.symbols.includes(v)) return false;
  l.symbols = l.symbols.filter((s) => s !== v);
  l.favs = l.favs.filter((s) => s !== v);
  l.updatedAt = Date.now();
  return true;
}
function wlReorder(doc, listId, sym, beforeSym) {
  const l = wlFindList(doc, listId);
  const v = wlSanitizeSymbol(sym);
  if (!l || !v || !l.symbols.includes(v)) return false;
  l.symbols = l.symbols.filter((s) => s !== v);
  const idx = beforeSym ? l.symbols.indexOf(wlSanitizeSymbol(beforeSym) || "") : -1;
  if (idx >= 0) l.symbols.splice(idx, 0, v); else l.symbols.push(v);
  l.updatedAt = Date.now();
  return true;
}
function wlMoveSymbol(doc, fromId, toId, sym) {
  if (fromId === toId) return false;
  const to = wlFindList(doc, toId);
  const v = wlSanitizeSymbol(sym);
  if (!to || !v) return false;
  if (!to.symbols.includes(v) && to.symbols.length < WL_MAX_SYMBOLS) { to.symbols.push(v); to.updatedAt = Date.now(); }
  wlRemoveSymbol(doc, fromId, sym);
  return true;
}
function wlToggleFav(doc, listId, sym) {
  const l = wlFindList(doc, listId);
  const v = wlSanitizeSymbol(sym);
  if (!l || !v || !l.symbols.includes(v)) return false;
  l.favs = l.favs.includes(v) ? l.favs.filter((s) => s !== v) : l.favs.concat([v]);
  l.updatedAt = Date.now();
  return true;
}
// Should this alert fire NOW, given the current ticker (and the previous last
// price for edge detection)? Pure — the same call the tests exercise. prev is
// used only to fire ONCE on the crossing tick for above/below.
function wlEvalAlert(alert, ticker, prevPrice) {
  if (!alert || !ticker) return false;
  const last = Number(ticker.lastPrice);
  const pct = Number(ticker.price24hPcnt) * 100;
  const funding = Math.abs(Number(ticker.fundingRate) * 100);
  const prev = Number(prevPrice);
  switch (alert.kind) {
    case "above": return isFinite(last) && last >= alert.value && (!isFinite(prev) || prev < alert.value);
    case "below": return isFinite(last) && last <= alert.value && (!isFinite(prev) || prev > alert.value);
    case "pct_up": return isFinite(pct) && pct >= alert.value;
    case "pct_down": return isFinite(pct) && pct <= alert.value;
    case "funding_abs": return isFinite(funding) && funding >= alert.value;
    default: return false;
  }
}
// Compute the ordered VISIBLE symbols for a list + view. Pure: `index` maps
// symbol → {price24hPcnt, lastPrice, turnover24h, fundingRate, openInterest}.
function wlComputeView(symbols, favs, index, opts) {
  const o = opts || {};
  const favSet = new Set(favs || []);
  const q = String(o.query || "").trim().toUpperCase();
  let out = (symbols || []).slice();
  if (q) out = out.filter((s) => s.includes(q));
  const met = (s) => index[s] || {};
  if (o.filter === "fav") out = out.filter((s) => favSet.has(s));
  else if (o.filter === "gainers") out = out.filter((s) => Number(met(s).price24hPcnt) > 0);
  else if (o.filter === "losers") out = out.filter((s) => Number(met(s).price24hPcnt) < 0);
  else if (o.filter === "movers") out = out.filter((s) => Math.abs(Number(met(s).price24hPcnt) || 0) >= WL_MOVER_PCT);
  const sort = WL_SORTS.includes(o.sort) ? o.sort : "custom";
  const dir = o.dir === "asc" ? 1 : -1;
  if (sort === "custom") {
    // Favorites float to the top, each group keeping its manual order.
    const fav = out.filter((s) => favSet.has(s));
    const rest = out.filter((s) => !favSet.has(s));
    out = fav.concat(rest);
  } else if (sort === "symbol") {
    out.sort((a, b) => a.localeCompare(b) * dir);
  } else {
    const keyOf = {
      price: (s) => Number(met(s).lastPrice) || 0,
      pct: (s) => Number(met(s).price24hPcnt) || 0,
      vol: (s) => Number(met(s).turnover24h) || 0,
      funding: (s) => Number(met(s).fundingRate) || 0,
      oi: (s) => Number(met(s).openInterest) || 0,
    }[sort];
    out.sort((a, b) => (keyOf(a) - keyOf(b)) * dir);
  }
  return out;
}

// ------------------------------ DOM manager -------------------------------

let _marketsData = null;         // kept name: raw /api/tickers envelope (ticker universe)
let _marketsTimer = null;        // kept name: the shared 15s poll interval id
let _wlDoc = null;
let _tickerIndex = {};           // symbol → ticker object (rebuilt each poll)
let _tickHistory = {};           // symbol → [last prices] (sparkline source)
let _wlView = { filter: "all", sort: "custom", dir: "desc", query: "" };
const _wlRowEls = {};            // symbol → row element (keyed, in-place patched)
let _wlPrevPrice = {};           // symbol → last price (direction flash + alert edges)
let _wlRenderedKey = "";         // signature of the last full render
let _wlSaveTimer = null;
let _wlStorageWarned = false;

function wlActiveList() {
  if (!_wlDoc) return null;
  return wlFindList(_wlDoc, _wlDoc.activeId) || _wlDoc.lists[0];
}
function wlPersist() {
  if (!_wlDoc) return;
  try { localStorage.setItem(WL_STORE_KEY, JSON.stringify(_wlDoc)); }
  catch (e) {
    if (!_wlStorageWarned) { _wlStorageWarned = true; toast("Could not persist watchlists (storage unavailable)", "warn"); }
  }
}
function wlLoad() {
  let raw = null;
  try { raw = localStorage.getItem(WL_STORE_KEY); } catch (e) {}
  const { doc, corrupt } = wlParseDoc(raw);
  _wlDoc = doc;
  if (corrupt && raw != null) {
    try { localStorage.setItem(WL_STORE_KEY + ".corrupt", raw); } catch (e) {}
    toast("Watchlist data was unreadable — reset to defaults (old data kept under …corrupt)", "warn", 8000);
  }
  wlPersist();
}

// Price decimals heuristic (tickers carry no tickSize): larger prices show
// fewer decimals, sub-dollar symbols show more.
function wlPriceDp(v) {
  const n = Math.abs(Number(v));
  if (!isFinite(n) || n === 0) return 2;
  if (n >= 1000) return 1;
  if (n >= 1) return 2;
  if (n >= 0.01) return 5;
  return 8;
}

function wlSparkline(sym) {
  const h = _tickHistory[sym];
  if (!h || h.length < 2) return "";
  const w = 60, ht = 20, pad = 2;
  let min = Infinity, max = -Infinity;
  for (const v of h) { if (v < min) min = v; if (v > max) max = v; }
  const span = (max - min) || 1;
  const dx = (w - pad * 2) / (h.length - 1);
  const pts = h.map((v, i) => `${(pad + i * dx).toFixed(1)},${(ht - pad - ((v - min) / span) * (ht - pad * 2)).toFixed(1)}`).join(" ");
  const up = h[h.length - 1] >= h[0];
  const col = up ? "var(--pos)" : "var(--neg)";
  return `<svg class="wl-spark" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${pts}" style="fill:none;stroke:${col};stroke-width:1.4;vector-effect:non-scaling-stroke"/></svg>`;
}

// Build a row skeleton once; dynamic cells are patched by wlPatchRow.
function wlBuildRow(sym) {
  const row = document.createElement("div");
  row.className = "wl-row";
  row.setAttribute("role", "listitem");
  row.dataset.sym = sym;
  row.tabIndex = 0;
  row.draggable = true;
  row.innerHTML =
    // Market data is PUBLIC — deliberately NOT `.priv`: privacy mode masks
    // account figures (balances/sizes/PnL), never public prices (consistent
    // with the charts, order book and old Markets tab).
    `<button class="wl-fav" type="button" tabindex="-1" aria-label="Toggle favorite ${esc(sym)}" title="Favorite">★</button>` +
    `<span class="wl-sym mono">${esc(sym)}</span>` +
    `<span class="wl-spark-cell"></span>` +
    `<span class="wl-last mono"></span>` +
    `<span class="wl-pct mono"></span>` +
    `<span class="wl-mark mono wl-opt"></span>` +
    `<span class="wl-index mono wl-opt"></span>` +
    `<span class="wl-funding mono wl-opt"></span>` +
    `<span class="wl-spread mono wl-opt"></span>` +
    `<span class="wl-vol mono wl-opt"></span>` +
    `<span class="wl-oi mono wl-opt"></span>` +
    `<button class="wl-more" type="button" tabindex="-1" aria-label="Actions for ${esc(sym)}" title="Actions (right-click or Menu key)">⋯</button>`;
  return row;
}

// Patch ONLY the changing cells of one row from the current ticker index.
function wlPatchRow(row, sym) {
  const t = _tickerIndex[sym];
  const q = (sel) => row.querySelector(sel);
  const active = wlActiveList();
  const isFav = active && active.favs.includes(sym);
  row.classList.toggle("is-fav", !!isFav);
  const favBtn = q(".wl-fav");
  if (favBtn) favBtn.classList.toggle("on", !!isFav);
  if (!t) {
    q(".wl-last").textContent = "—";
    q(".wl-pct").textContent = "";
    q(".wl-spark-cell").innerHTML = "";
    return;
  }
  const dp = wlPriceDp(t.lastPrice);
  const last = Number(t.lastPrice);
  const prev = _wlPrevPrice[sym];
  // Direction flash on a MEANINGFUL change only (subtle bg fade, not a blink).
  if (isFinite(last) && isFinite(prev) && last !== prev) {
    const cls = last > prev ? "tick-up" : "tick-down";
    row.classList.remove("tick-up", "tick-down");
    void row.offsetWidth;
    row.classList.add(cls);
  }
  q(".wl-last").textContent = fmtMoney(t.lastPrice, dp);
  const pctEl = q(".wl-pct");
  pctEl.textContent = pct(t.price24hPcnt);
  pctEl.className = "wl-pct mono " + pnlClass(t.price24hPcnt);
  q(".wl-mark").textContent = fmtMoney(t.markPrice, dp);
  q(".wl-index").textContent = t.indexPrice != null ? fmtMoney(t.indexPrice, dp) : "—";
  const fEl = q(".wl-funding");
  fEl.innerHTML = fmtFundingHTML(t.fundingRate);
  const bid = Number(t.bid1Price), ask = Number(t.ask1Price);
  q(".wl-spread").textContent = (isFinite(bid) && isFinite(ask) && ask >= bid)
    ? fmtMoney(ask - bid, wlPriceDp(ask - bid || ask)) : "—";
  q(".wl-vol").textContent = t.turnover24h != null ? fmtMoney(t.turnover24h, 0) : "—";
  q(".wl-oi").textContent = t.openInterest != null ? fmtNum(t.openInterest, 0) : "—";
  q(".wl-spark-cell").innerHTML = wlSparkline(sym);
}

function wlViewKey(visible) {
  return _wlDoc.activeId + "|" + _wlView.filter + "|" + _wlView.sort + "|" + _wlView.dir +
    "|" + _wlView.query + "|" + visible.join(",");
}

// Decide full re-layout vs cheap value patch. Called every poll and on any
// view/list change.
function wlSync() {
  if (!_wlDoc) return;
  const list = wlActiveList();
  const visible = list ? wlComputeView(list.symbols, list.favs, _tickerIndex, _wlView) : [];
  const key = wlViewKey(visible);
  if (key !== _wlRenderedKey) { _wlRenderFull(visible); _wlRenderedKey = key; }
  else { visible.forEach((s) => { const r = _wlRowEls[s]; if (r) wlPatchRow(r, s); }); }
  // Record prices AFTER patching so the next poll's direction flash is correct.
  visible.forEach((s) => { const t = _tickerIndex[s]; if (t && isFinite(Number(t.lastPrice))) _wlPrevPrice[s] = Number(t.lastPrice); });
  wlRenderSyncedLabel();
}

function _wlRenderFull(visible) {
  const rowsEl = document.getElementById("wl-rows");
  const emptyEl = document.getElementById("wl-empty");
  if (!rowsEl || !emptyEl) return;
  const list = wlActiveList();
  if (!list) return;
  if (!visible.length) {
    rowsEl.innerHTML = "";
    emptyEl.hidden = false;
    let title, hint, action;
    if (!list.symbols.length) { title = "This watchlist is empty"; hint = "Search a symbol above to add it, or import a list."; action = "add"; }
    else if (_wlView.query) { title = "No symbols match your search"; hint = `Nothing in “${esc(list.name)}” matches that filter.`; action = "clear"; }
    else if (_wlView.filter === "fav") { title = "No favorites yet"; hint = "Star a symbol to pin it here."; action = "allfilter"; }
    else { title = "Nothing matches this filter"; hint = "Try a different quick filter."; action = "allfilter"; }
    emptyEl.innerHTML =
      `<div class="wl-empty-glyph" aria-hidden="true">◵</div>` +
      `<p class="wl-empty-title">${esc(title)}</p>` +
      `<p class="wl-empty-hint">${esc(hint)}</p>` +
      `<div class="wl-empty-actions">` +
        (action === "add" ? `<button class="btn-primary sm" data-wlempty="add">Add a symbol</button>` : "") +
        (action === "clear" ? `<button class="btn-ghost sm" data-wlempty="clear">Clear search</button>` : "") +
        (action === "allfilter" ? `<button class="btn-ghost sm" data-wlempty="allfilter">Show all</button>` : "") +
      `</div>`;
    return;
  }
  emptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  visible.forEach((sym) => {
    let row = _wlRowEls[sym];
    if (!row) { row = wlBuildRow(sym); _wlRowEls[sym] = row; }
    frag.appendChild(row);
  });
  rowsEl.replaceChildren(frag);
  visible.forEach((s) => wlPatchRow(_wlRowEls[s], s));
  // Prune cached rows no longer in this list (bounded, but tidy).
  const live = new Set(list.symbols);
  Object.keys(_wlRowEls).forEach((s) => { if (!live.has(s)) delete _wlRowEls[s]; });
}

function wlRenderSyncedLabel() {
  const el = document.getElementById("wl-synced");
  if (!el) return;
  const list = wlActiveList();
  const n = list ? list.symbols.length : 0;
  el.textContent = _marketsData ? `${n} sym${n === 1 ? "bol" : "bols"} · live` : "connecting…";
}

// The list tab strip.
function wlRenderLists() {
  const el = document.getElementById("wl-lists");
  if (!el || !_wlDoc) return;
  el.innerHTML = _wlDoc.lists.map((l) => {
    const on = l.id === _wlDoc.activeId;
    return `<button type="button" class="wl-chip${on ? " active" : ""}" role="tab" aria-selected="${on}" ` +
      `data-wlid="${esc(l.id)}" title="${esc(l.name)} · ${l.symbols.length} symbols">` +
      `<span class="wl-chip-name">${esc(l.name)}</span><span class="wl-chip-n">${l.symbols.length}</span></button>`;
  }).join("") +
    `<button type="button" class="wl-chip wl-chip-new" id="wl-new" title="New watchlist" aria-label="New watchlist">＋</button>`;
}

function wlSwitchList(id) {
  if (!_wlDoc || !wlFindList(_wlDoc, id)) return;
  _wlDoc.activeId = id;
  _wlPrevPrice = {};                 // fresh direction baseline for the new list
  Object.keys(_wlRowEls).forEach((k) => delete _wlRowEls[k]);
  wlPersist();
  wlRenderLists();
  _wlRenderedKey = "";               // force a full re-layout
  wlSync();
  wsAutoSave();                      // the active list is part of the workspace
}

function wlAutoSaveView() {
  clearTimeout(_wlSaveTimer);
  _wlSaveTimer = setTimeout(() => { wsAutoSave(); }, 300);
}

// ---- data poll (reuses the existing 15s Markets cadence) ----
async function fetchMarkets() {
  try {
    _marketsData = await api("/api/tickers");
  } catch (e) {
    const rowsEl = document.getElementById("wl-rows");
    if (rowsEl && !Object.keys(_wlRowEls).length) rowsEl.innerHTML = errorMsg(e.message);
    return;
  }
  // Rebuild the symbol→ticker index + append tick history (bounded).
  const idx = {};
  listOf(_marketsData).forEach((t) => {
    const s = wlSanitizeSymbol(t.symbol);
    if (!s) return;
    idx[s] = t;
    const lp = Number(t.lastPrice);
    if (isFinite(lp)) {
      (_tickHistory[s] = _tickHistory[s] || []).push(lp);
      if (_tickHistory[s].length > WL_SPARK_POINTS) _tickHistory[s].shift();
    }
  });
  _tickerIndex = idx;
  wlEvaluateAlerts();
  wlSync();
}

// renderMarkets kept as an alias for the currency-lens re-render hook.
function renderMarkets() { _wlRenderedKey = ""; wlSync(); }

function onMarketsActive() {
  if (_wlDoc) { wlRenderLists(); wlSync(); }
  if (!_marketsData) fetchMarkets();
  clearInterval(_marketsTimer);
  const id = setInterval(() => {
    const pane = document.querySelector('[data-pane="markets"]');
    if (!pane || pane.hidden) { clearInterval(id); return; }
    if (!document.hidden) fetchMarkets();
  }, 15000);
  _marketsTimer = id;
}

// ---- alerts (client-side; notify only, never a trade) ----
function wlEvaluateAlerts() {
  if (!_wlDoc || !_wlDoc.alerts.length) return;
  let changed = false;
  _wlDoc.alerts.forEach((a) => {
    if (a.triggered) return;
    const t = _tickerIndex[a.symbol];
    if (t && wlEvalAlert(a, t, _wlPrevPrice[a.symbol])) {
      a.triggered = true;
      changed = true;
      toast(`Alert · ${a.symbol} ${wlAlertLabel(a)}`, "warn", 8000);
    }
  });
  if (changed) wlPersist();
}
function wlAlertLabel(a) {
  switch (a.kind) {
    case "above": return `rose above ${a.value}`;
    case "below": return `fell below ${a.value}`;
    case "pct_up": return `24h change ≥ ${a.value}%`;
    case "pct_down": return `24h change ≤ ${a.value}%`;
    case "funding_abs": return `|funding| ≥ ${a.value}%`;
    default: return "triggered";
  }
}

// Quick-trade integration: open a watchlist symbol in the trading surfaces.
// trade=true (admin) loads the full ticket (which fans out to chart/book/
// preview via its input handler); otherwise just points the order book at it.
function wlOpenSymbol(sym, opts) {
  const v = wlSanitizeSymbol(sym);
  if (!v) return;
  const trade = !opts || opts.trade !== false;
  const dashTab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
  if (dashTab) dashTab.click();
  if (trade && document.getElementById("order-form")) loadSymbolIntoTicket(v);
  else setActiveSymbol(v);
}

// ---- symbol search (add-to-list) ----
let _wlSearchSel = -1;
function wlSearchMatches(q) {
  const query = String(q || "").trim().toUpperCase();
  if (!query) return [];
  const list = wlActiveList();
  const inList = new Set(list ? list.symbols : []);
  const all = Object.keys(_tickerIndex);
  // Rank: startsWith first, then substring; already-in-list still shown (marked).
  const starts = [], contains = [];
  for (const s of all) {
    if (s === query) starts.unshift(s);
    else if (s.startsWith(query)) starts.push(s);
    else if (s.includes(query)) contains.push(s);
  }
  return starts.concat(contains).slice(0, 12).map((s) => ({ sym: s, inList: inList.has(s) }));
}
function wlRenderSearch() {
  const input = document.getElementById("wl-search");
  const box = document.getElementById("wl-search-results");
  if (!input || !box) return;
  const q = input.value;
  if (!q.trim()) { box.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
  const matches = wlSearchMatches(q);
  if (_wlSearchSel >= matches.length) _wlSearchSel = matches.length - 1;
  box.innerHTML = matches.length
    ? matches.map((m, i) => {
        const t = _tickerIndex[m.sym] || {};
        return `<div class="wl-sr-item${i === _wlSearchSel ? " sel" : ""}" role="option" aria-selected="${i === _wlSearchSel}" data-sym="${esc(m.sym)}">` +
          `<span class="wl-sr-sym mono">${esc(m.sym)}</span>` +
          `<span class="wl-sr-px mono ${pnlClass(t.price24hPcnt)}">${t.lastPrice != null ? esc(fmtNum(t.lastPrice, wlPriceDp(t.lastPrice))) : ""} <em>${t.price24hPcnt != null ? esc(pct(t.price24hPcnt)) : ""}</em></span>` +
          (m.inList ? `<span class="wl-sr-in">✓ in list</span>` : `<span class="wl-sr-add">＋ add</span>`) +
          `</div>`;
      }).join("")
    : `<div class="wl-sr-empty muted">No market matches “${esc(q.trim().toUpperCase())}”.</div>`;
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
}
function wlAddFromSearch(sym) {
  const v = wlSanitizeSymbol(sym);
  if (!v) return;
  const list = wlActiveList();
  if (!list) return;
  if (list.symbols.includes(v)) { toast(`${v} is already in “${list.name}”`, "info", 2000); return; }
  if (wlAddSymbol(_wlDoc, list.id, v)) {
    wlPersist(); wlRenderLists(); _wlRenderedKey = ""; wlSync();
    toast(`Added ${v} to “${list.name}”`, "pos", 2000);
  } else {
    toast(`Could not add ${v} (list full?)`, "warn");
  }
}

// ---- context menu ----
function wlCloseCtx() {
  const menu = document.getElementById("wl-ctx");
  if (menu) { menu.hidden = true; menu.innerHTML = ""; }
}
function wlOpenCtx(sym, x, y) {
  const menu = document.getElementById("wl-ctx");
  const list = wlActiveList();
  if (!menu || !list) return;
  const isAdmin = state.role === "admin" && !!document.getElementById("order-form");
  const isFav = list.favs.includes(sym);
  const others = _wlDoc.lists.filter((l) => l.id !== list.id);
  const item = (act, label, extra) => `<button class="wl-ctx-item" role="menuitem" tabindex="-1" data-act="${act}"${extra || ""}>${label}</button>`;
  menu.innerHTML =
    `<div class="wl-ctx-head mono">${esc(sym)}</div>` +
    (isAdmin ? item("trade", "Trade this symbol") : "") +
    item("chart", "Open chart &amp; book") +
    item("fav", isFav ? "★ Remove favorite" : "☆ Add favorite") +
    item("alert", "Set price alert…") +
    item("copy", "Copy symbol") +
    item("history", "Open journal") +
    (others.length ? `<div class="wl-ctx-sep"></div><div class="wl-ctx-label">Move to</div>` +
      others.slice(0, 6).map((l) => item("move", `→ ${esc(l.name)}`, ` data-listid="${esc(l.id)}"`)).join("") : "") +
    `<div class="wl-ctx-sep"></div>` +
    item("remove", "Remove from list");
  menu.dataset.sym = sym;
  menu.hidden = false;
  // Clamp to viewport.
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, vw - rect.width - 8) + "px";
  menu.style.top = Math.min(y, vh - rect.height - 8) + "px";
  const first = menu.querySelector(".wl-ctx-item");
  if (first) first.focus();
}
function wlCtxAction(act, sym, el) {
  const list = wlActiveList();
  if (!list) return;
  switch (act) {
    case "trade": wlOpenSymbol(sym, { trade: true }); break;
    case "chart": wlOpenSymbol(sym, { trade: false }); break;
    case "fav":
      if (wlToggleFav(_wlDoc, list.id, sym)) { wlPersist(); _wlRenderedKey = ""; wlSync(); }
      break;
    case "alert": wlOpenAlert(sym); break;
    case "copy":
      try { navigator.clipboard.writeText(sym); toast(`Copied ${sym}`, "info", 1500); }
      catch (e) { toast("Clipboard unavailable", "warn"); }
      break;
    case "history": {
      const t = document.querySelector('#tabs .tab[data-tab="history"]');
      if (t) t.click();
      break;
    }
    case "move": {
      const toId = el && el.dataset.listid;
      if (toId && wlMoveSymbol(_wlDoc, list.id, toId, sym)) {
        wlPersist(); wlRenderLists(); _wlRenderedKey = ""; wlSync();
        const dest = wlFindList(_wlDoc, toId);
        toast(`Moved ${sym} → “${dest ? dest.name : ""}”`, "pos", 2000);
      }
      break;
    }
    case "remove":
      if (wlRemoveSymbol(_wlDoc, list.id, sym)) { wlPersist(); wlRenderLists(); _wlRenderedKey = ""; wlSync(); }
      break;
  }
  wlCloseCtx();
}

// ---- price-alert modal ----
let _wlAlertSym = null;
function wlRenderAlertExisting() {
  const box = document.getElementById("alert-existing");
  if (!box || !_wlDoc) return;
  const mine = _wlDoc.alerts.filter((a) => a.symbol === _wlAlertSym);
  box.innerHTML = mine.length
    ? `<div class="ae-title">Active alerts</div>` + mine.map((a) =>
        `<div class="ae-row${a.triggered ? " done" : ""}"><span>${esc(wlAlertLabel(a))}${a.triggered ? " · fired" : ""}</span>` +
        `<button type="button" class="ws-act" data-alid="${esc(a.id)}" title="Remove alert" aria-label="Remove alert">✕</button></div>`
      ).join("")
    : `<div class="ae-empty muted">No alerts on ${esc(_wlAlertSym || "")} yet.</div>`;
}
function wlOpenAlert(sym) {
  const v = wlSanitizeSymbol(sym);
  if (!v) return;
  _wlAlertSym = v;
  const overlay = document.getElementById("alert-overlay");
  const ctx = document.getElementById("alert-context");
  const out = document.getElementById("alert-result");
  const valInput = document.getElementById("alert-value");
  if (!overlay) return;
  const t = _tickerIndex[v];
  if (ctx) ctx.textContent = t && t.lastPrice != null
    ? `${v} · last ${fmtNum(t.lastPrice, wlPriceDp(t.lastPrice))} · alerts notify only, never trade`
    : `${v} · alerts notify only, never trade`;
  if (out) { out.textContent = ""; out.className = "result-msg"; }
  if (valInput) valInput.value = "";
  wlRenderAlertExisting();
  overlay.hidden = false;
  if (valInput) valInput.focus();
}

// ---- list-chip inline rename ----
function wlStartRenameChip(chip) {
  if (!chip || !_wlDoc) return;
  const id = chip.dataset.wlid;
  const l = wlFindList(_wlDoc, id);
  if (!l) return;
  chip.innerHTML = `<input class="wl-chip-edit" type="text" value="${esc(l.name)}" maxlength="40" aria-label="Rename watchlist" />`;
  const input = chip.querySelector("input");
  input.focus(); input.select();
  const commit = () => {
    if (wlRename(_wlDoc, id, input.value)) wlPersist();
    wlRenderLists();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); wlRenderLists(); }
  });
  input.addEventListener("blur", commit);
}

function wlExportActive() {
  const list = wlActiveList();
  if (!list) return;
  const payload = {
    app: "dma-terminal", kind: "watchlist", version: WL_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    list: { name: list.name, symbols: list.symbols, favs: list.favs },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dma-watchlist-${list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list"}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wireWatchlist() {
  wlLoad();
  wlRenderLists();

  // ---- list chips: switch / new / rename (double-click) / drop-target ----
  const listsEl = document.getElementById("wl-lists");
  if (listsEl) {
    listsEl.addEventListener("click", (e) => {
      if (e.target.closest(".wl-chip-edit")) return;
      const newBtn = e.target.closest("#wl-new");
      if (newBtn) {
        const l = wlCreate(_wlDoc, `Watchlist ${_wlDoc.lists.length + 1}`);
        if (!l) { toast(`Watchlist limit reached (${WL_MAX_LISTS})`, "warn"); return; }
        wlPersist(); wlRenderLists();
        _wlPrevPrice = {}; Object.keys(_wlRowEls).forEach((k) => delete _wlRowEls[k]);
        _wlRenderedKey = ""; wlSync(); wsAutoSave();
        const chip = listsEl.querySelector(`.wl-chip[data-wlid="${CSS.escape(l.id)}"]`);
        if (chip) wlStartRenameChip(chip);
        return;
      }
      const chip = e.target.closest(".wl-chip[data-wlid]");
      if (chip) wlSwitchList(chip.dataset.wlid);
    });
    listsEl.addEventListener("dblclick", (e) => {
      const chip = e.target.closest(".wl-chip[data-wlid]");
      if (chip) wlStartRenameChip(chip);
    });
    // Symbols can be dropped onto a chip to MOVE them to that list.
    listsEl.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("application/x-wl-sym")) {
        e.preventDefault();
        const chip = e.target.closest(".wl-chip[data-wlid]");
        listsEl.querySelectorAll(".wl-chip.drop").forEach((c) => c.classList.remove("drop"));
        if (chip) chip.classList.add("drop");
      }
    });
    listsEl.addEventListener("dragleave", (e) => {
      const chip = e.target.closest(".wl-chip");
      if (chip) chip.classList.remove("drop");
    });
    listsEl.addEventListener("drop", (e) => {
      const chip = e.target.closest(".wl-chip[data-wlid]");
      listsEl.querySelectorAll(".wl-chip.drop").forEach((c) => c.classList.remove("drop"));
      if (!chip) return;
      const sym = e.dataTransfer.getData("application/x-wl-sym");
      const active = wlActiveList();
      if (sym && active && chip.dataset.wlid !== active.id && wlMoveSymbol(_wlDoc, active.id, chip.dataset.wlid, sym)) {
        e.preventDefault();
        wlPersist(); wlRenderLists(); _wlRenderedKey = ""; wlSync();
        toast(`Moved ${sym}`, "pos", 1500);
      }
    });
  }

  // ---- search ----
  const search = document.getElementById("wl-search");
  const results = document.getElementById("wl-search-results");
  if (search) {
    search.addEventListener("input", () => { _wlSearchSel = 0; wlRenderSearch(); });
    search.addEventListener("keydown", (e) => {
      const matches = wlSearchMatches(search.value);
      if (e.key === "ArrowDown") { e.preventDefault(); _wlSearchSel = Math.min(_wlSearchSel + 1, matches.length - 1); wlRenderSearch(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); _wlSearchSel = Math.max(_wlSearchSel - 1, 0); wlRenderSearch(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const pick = matches[_wlSearchSel] || matches[0];
        if (pick) { wlAddFromSearch(pick.sym); search.value = ""; wlRenderSearch(); }
      } else if (e.key === "Escape") { search.value = ""; wlRenderSearch(); search.blur(); }
    });
    search.addEventListener("blur", () => setTimeout(() => { if (results) results.hidden = true; }, 150));
  }
  if (results) {
    results.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".wl-sr-item[data-sym]");
      if (item) { e.preventDefault(); wlAddFromSearch(item.dataset.sym); if (search) { search.value = ""; wlRenderSearch(); search.focus(); } }
    });
  }

  // ---- filters + sort ----
  const filters = document.getElementById("wl-filters");
  if (filters) filters.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    _wlView.filter = WL_FILTERS.includes(b.dataset.filter) ? b.dataset.filter : "all";
    filters.querySelectorAll("button").forEach((x) => {
      const on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on));
    });
    _wlRenderedKey = ""; wlSync(); wlAutoSaveView();
  });
  const sortSel = document.getElementById("wl-sort");
  if (sortSel) sortSel.addEventListener("change", () => {
    _wlView.sort = WL_SORTS.includes(sortSel.value) ? sortSel.value : "custom";
    _wlRenderedKey = ""; wlSync(); wlAutoSaveView();
  });
  const dirBtn = document.getElementById("wl-sort-dir");
  if (dirBtn) dirBtn.addEventListener("click", () => {
    _wlView.dir = _wlView.dir === "asc" ? "desc" : "asc";
    dirBtn.textContent = _wlView.dir === "asc" ? "▴" : "▾";
    dirBtn.setAttribute("aria-label", `Sort ${_wlView.dir === "asc" ? "ascending" : "descending"}`);
    _wlRenderedKey = ""; wlSync(); wlAutoSaveView();
  });

  // ---- rows: click / fav / more / keyboard / drag ----
  const rowsEl = document.getElementById("wl-rows");
  if (rowsEl) {
    rowsEl.addEventListener("click", (e) => {
      const row = e.target.closest(".wl-row[data-sym]");
      if (!row) return;
      const sym = row.dataset.sym;
      if (e.target.closest(".wl-fav")) {
        const list = wlActiveList();
        if (list && wlToggleFav(_wlDoc, list.id, sym)) { wlPersist(); _wlRenderedKey = ""; wlSync(); }
        return;
      }
      if (e.target.closest(".wl-more")) {
        const r = e.target.getBoundingClientRect();
        wlOpenCtx(sym, r.left, r.bottom + 4);
        return;
      }
      wlOpenSymbol(sym, { trade: true });
    });
    rowsEl.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".wl-row[data-sym]");
      if (!row) return;
      e.preventDefault();
      wlOpenCtx(row.dataset.sym, e.clientX, e.clientY);
    });
    rowsEl.addEventListener("keydown", (e) => {
      const row = e.target.closest(".wl-row[data-sym]");
      if (!row || e.target !== row) return;
      const sym = row.dataset.sym;
      const list = wlActiveList();
      if (e.key === "Enter") { e.preventDefault(); wlOpenSymbol(sym, { trade: true }); }
      else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        if (list && wlToggleFav(_wlDoc, list.id, sym)) { wlPersist(); _wlRenderedKey = ""; wlSync(); focusWlRow(sym); }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const next = row.nextElementSibling || row.previousElementSibling;
        if (list && wlRemoveSymbol(_wlDoc, list.id, sym)) {
          wlPersist(); wlRenderLists(); _wlRenderedKey = ""; wlSync();
          if (next && next.dataset && next.dataset.sym) focusWlRow(next.dataset.sym);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); const n = row.nextElementSibling; if (n && n.classList.contains("wl-row")) n.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); const p = row.previousElementSibling; if (p && p.classList.contains("wl-row")) p.focus();
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault(); const r = row.getBoundingClientRect(); wlOpenCtx(sym, r.left + 40, r.top + 30);
      }
    });
    // Drag reorder (edits the list's custom order; switches sort→custom so the
    // change is visible). HTML5 DnD like the workspace panels.
    rowsEl.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".wl-row[data-sym]");
      if (!row) return;
      e.dataTransfer.setData("application/x-wl-sym", row.dataset.sym);
      e.dataTransfer.setData("text/plain", row.dataset.sym);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    rowsEl.addEventListener("dragend", (e) => {
      const row = e.target.closest(".wl-row");
      if (row) row.classList.remove("dragging");
    });
    rowsEl.addEventListener("dragover", (e) => {
      const dragging = rowsEl.querySelector(".wl-row.dragging");
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest(".wl-row[data-sym]");
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      rowsEl.insertBefore(dragging, before ? over : over.nextSibling);
    });
    rowsEl.addEventListener("drop", (e) => {
      const dragging = rowsEl.querySelector(".wl-row.dragging");
      if (!dragging) return;
      e.preventDefault();
      const list = wlActiveList();
      if (!list) return;
      const sym = dragging.dataset.sym;
      const beforeEl = dragging.nextElementSibling;
      const beforeSym = beforeEl && beforeEl.classList.contains("wl-row") ? beforeEl.dataset.sym : null;
      if (_wlView.sort !== "custom") {
        _wlView.sort = "custom";
        const sel = document.getElementById("wl-sort"); if (sel) sel.value = "custom";
      }
      if (wlReorder(_wlDoc, list.id, sym, beforeSym)) { wlPersist(); _wlRenderedKey = ""; wlSync(); wlAutoSaveView(); }
    });
  }

  // ---- empty-state quick actions ----
  const emptyEl = document.getElementById("wl-empty");
  if (emptyEl) emptyEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-wlempty]");
    if (!b) return;
    if (b.dataset.wlempty === "add") { if (search) search.focus(); }
    else if (b.dataset.wlempty === "clear") { if (search) { search.value = ""; wlRenderSearch(); } _wlView.query = ""; _wlRenderedKey = ""; wlSync(); }
    else if (b.dataset.wlempty === "allfilter") {
      _wlView.filter = "all";
      if (filters) filters.querySelectorAll("button").forEach((x) => {
        const on = x.dataset.filter === "all"; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on));
      });
      _wlRenderedKey = ""; wlSync();
    }
  });

  // ---- context menu global handlers ----
  const ctx = document.getElementById("wl-ctx");
  if (ctx) {
    ctx.addEventListener("click", (e) => {
      const item = e.target.closest(".wl-ctx-item[data-act]");
      if (item) wlCtxAction(item.dataset.act, ctx.dataset.sym, item);
    });
    ctx.addEventListener("keydown", (e) => {
      const items = Array.from(ctx.querySelectorAll(".wl-ctx-item"));
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      else if (e.key === "Enter" && i >= 0) { e.preventDefault(); wlCtxAction(items[i].dataset.act, ctx.dataset.sym, items[i]); }
      else if (e.key === "Escape") { e.preventDefault(); wlCloseCtx(); }
    });
    document.addEventListener("click", (e) => { if (!ctx.hidden && !ctx.contains(e.target)) wlCloseCtx(); });
    document.addEventListener("scroll", () => { if (!ctx.hidden) wlCloseCtx(); }, true);
  }

  // ---- alert modal ----
  const alertOverlay = document.getElementById("alert-overlay");
  if (alertOverlay) {
    const close = () => { alertOverlay.hidden = true; };
    const cancelBtn = document.getElementById("alert-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", close);
    alertOverlay.addEventListener("click", (e) => { if (e.target === alertOverlay) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !alertOverlay.hidden) close(); });
    const addBtn = document.getElementById("alert-add");
    if (addBtn) addBtn.addEventListener("click", () => {
      const kind = document.getElementById("alert-kind").value;
      const raw = document.getElementById("alert-value").value.trim();
      const out = document.getElementById("alert-result");
      const val = Number(raw);
      if (!raw || !isFinite(val)) { if (out) { out.textContent = "Enter a numeric value."; out.className = "result-msg neg"; } return; }
      if (_wlDoc.alerts.length >= WL_MAX_ALERTS) { if (out) { out.textContent = `Alert limit reached (${WL_MAX_ALERTS}).`; out.className = "result-msg neg"; } return; }
      const alert = wlSanitizeAlert({ symbol: _wlAlertSym, kind, value: val });
      if (!alert) { if (out) { out.textContent = "Invalid alert."; out.className = "result-msg neg"; } return; }
      _wlDoc.alerts.push(alert); wlPersist();
      if (out) { out.textContent = `✓ Alert set: ${_wlAlertSym} ${wlAlertLabel(alert)}`; out.className = "result-msg pos"; }
      document.getElementById("alert-value").value = "";
      wlRenderAlertExisting();
    });
    const existing = document.getElementById("alert-existing");
    if (existing) existing.addEventListener("click", (e) => {
      const b = e.target.closest("[data-alid]");
      if (!b) return;
      _wlDoc.alerts = _wlDoc.alerts.filter((a) => a.id !== b.dataset.alid);
      wlPersist(); wlRenderAlertExisting();
    });
  }
}

function focusWlRow(sym) {
  const row = _wlRowEls[sym];
  if (row && row.isConnected) { try { row.focus(); } catch (e) {} }
}

// (The old fetch/render plumbing of this tab now lives in journal.js — the
// Trading Journal owns its own range/filter model, fetch sequencing and cache.
// toDateInputValue and fmtSynced stay here: both predate the journal and are
// part of the shared formatting vocabulary it consumes.)
function toDateInputValue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtSynced(ms, serverNowMs) {
  // History is served from the server's MongoDB mirror (synced ~every minute).
  // Flag a stamp that has stopped advancing — stale data on a money view must
  // never look current. Staleness is measured against the SERVER's clock
  // (result.nowMs) so a skewed browser clock can't fake or mask it.
  if (!isFinite(ms) || ms <= 0) return "syncing…";
  const now = isFinite(serverNowMs) && serverNowMs > 0 ? serverNowMs : Date.now();
  const stale = now - ms > 15 * 60 * 1000;
  return fmtTime(ms) + (stale ? " ⚠ stale" : "");
}
function wireMarketsHistory() {
  // (The Markets tab is now the Watchlist — wired in wireWatchlist(); the
  // History tab is now the Trading Journal — wired in wireJournal().)
  const ar = document.getElementById("account-refresh");
  if (ar) ar.addEventListener("click", loadAccountOverview);
}

// ---------------------------------------------------------------------------
// Live WebSocket feed (with auto-reconnect)
// ---------------------------------------------------------------------------
// Adaptive staleness threshold derived from observed inter-frame gaps, so it
// adjusts to whatever POLL_INTERVAL the server actually uses (default ~5s).
function staleThreshold() {
  const g = state.frameGaps;
  if (g && g.length) {
    const s = g.slice().sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    return Math.max(8, med * 2.5);
  }
  return 14; // no samples yet; generous floor (~2.5× a 5s poll)
}

// Render the connection pill from the AGE of the last frame — not just from
// socket open/close. A silently half-open socket (onmessage simply stops, no
// close event) would otherwise keep showing "live" over frozen PnL; here the
// age keeps climbing until it crosses the threshold and flips to "stale".
function renderConn() {
  const el = $("#conn-status");
  if (!el) return;
  if (state.connState === "off") {
    el.className = "conn conn-off";
    el.textContent = "reconnecting…";
    document.body.classList.remove("stale-data");
    return;
  }
  if (state.lastFrameAt == null) {
    // Socket may be open but no frame has landed yet — keep label and colour
    // consistent ("connecting…", neutral) until the first frame arrives.
    el.className = "conn conn-off";
    el.textContent = "connecting…";
    document.body.classList.remove("stale-data");
    return;
  }
  const age = (Date.now() - state.lastFrameAt) / 1000;
  const stale = age > staleThreshold() || !!state.feedError;
  if (stale) {
    el.className = "conn conn-stale";
    el.textContent = state.feedError ? "stale · feed error" : `stale · ${fmtAge(age)} ago`;
    document.body.classList.add("stale-data");
  } else if (state.connDegraded) {
    el.className = "conn conn-stale";
    el.textContent = `degraded · ${fmtAge(age)} ago`;
    document.body.classList.remove("stale-data");
  } else {
    el.className = "conn conn-on";
    el.textContent = `live · ${fmtAge(age)} ago`;
    document.body.classList.remove("stale-data");
  }
}

let _connTimer = null;
function startConnWatchdog() {
  if (_connTimer) return;
  _connTimer = setInterval(renderConn, 1000);
}

// Record the arrival of a frame and the gap since the previous one.
function recordFrame() {
  const now = Date.now();
  if (state.lastFrameAt != null) {
    const gap = (now - state.lastFrameAt) / 1000;
    if (gap > 0 && gap < 600) {
      state.frameGaps.push(gap);
      if (state.frameGaps.length > 8) state.frameGaps.shift();
    }
  }
  state.lastFrameAt = now;
}

function connectWS() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
  let opened = false;

  ws.onopen = () => {
    opened = true;
    state.connState = "live";
    renderConn();
  };
  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    if (msg.type === "dashboard") {
      renderDashboard(msg);
      recordFrame();
      state.connState = "live";
      state.feedError = null;
      // If any upstream call failed this cycle, the tables may be incomplete —
      // flag it (degraded) rather than presenting it as fully "live".
      state.connDegraded = msg.errors && Object.keys(msg.errors).length > 0;
      renderConn();
    } else if (msg.type === "error") {
      // Whole refresh failed: keep last rows but flag clearly as stale.
      recordFrame();
      state.connState = "live";
      state.feedError = msg.error || "feed error";
      renderConn();
      const label = $("#positions-updated");
      label.textContent = "⚠ " + msg.error;
      label.classList.add("neg");
    }
  };
  ws.onclose = (evt) => {
    // 1008 = server explicitly revoked this (accepted) session — e.g. a newer
    // login evicted us under the single-session rule. Redirect to login.
    if (evt && evt.code === 1008) {
      window.location.href = "/login";
      return;
    }
    state.connState = "off";
    // Forget the last-frame time so the first frame after a reconnect starts a
    // fresh baseline — an outage gap must not be recorded as a normal poll gap
    // (which would inflate the adaptive stale threshold).
    state.lastFrameAt = null;
    // Reset the dashboard generation floor: a redeploy restarts the server-side
    // gen counter at 0, so a stale in-memory floor would otherwise drop every
    // frame from the new server and freeze the dashboard until a page reload.
    _lastDashSeq = 0;
    renderConn();
    if (!opened) {
      // The socket never upgraded. Browsers report an auth/handshake rejection
      // as 1006 (indistinguishable from a network drop), so don't blindly
      // reconnect-loop: probe /api/me — api() redirects to /login on 401, and
      // otherwise we reconnect. finally() reconnects on success/network errors;
      // on a 401 the redirect has already navigated away.
      api("/api/me").finally(() => setTimeout(connectWS, 3000));
      return;
    }
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------------------
// Order ticket: %-sizing, active symbol, instrument specs & order-book widget
// ---------------------------------------------------------------------------

// Debounced one-shot dashboard refresh after a write, so a closed/cancelled row
// disappears (and a new order/position appears) without waiting for the next WS
// tick. Read-only GET of the same snapshot the socket pushes.
let _refreshTimer = null;
function refreshDashboardSoon() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    // renderDashboard drops this snapshot if a newer-`gen` frame already rendered
    // (and renders it if it is the fresher one), so no ordering guard is needed here.
    try { renderDashboard(await api("/api/dashboard")); } catch (e) { /* WS will catch up */ }
  }, 150);
}

function updateSizingAvail() {
  const el = document.getElementById("sizing-avail");
  if (!el) return;
  el.textContent = state.available != null
    ? `avail ${fmtNum(state.available)} ${settleCoin()}`
    : "avail —";
}

// Copy a symbol into the order ticket and load its market data — the ⇄ button
// on a position row (row-to-action wiring).
function loadSymbolIntoTicket(sym) {
  const symbol = (sym || "").trim().toUpperCase();
  const form = document.getElementById("order-form");
  if (!form || !symbol) return;
  form.symbol.value = symbol;
  form.symbol.dispatchEvent(new Event("input", { bubbles: true })); // price+spec+book+preview
  setActiveSymbol(symbol);
  try { form.qty.focus({ preventScroll: true }); } catch (e) {}
  form.scrollIntoView({ block: "nearest" });
  toast(`Loaded ${symbol} into the order ticket`, "info", 2500);
}

// Load a (just-cancelled) order's parameters into the ticket for amend-style
// editing. Display/prefill only — the ticket's normal validate/confirm/submit
// path is unchanged and nothing is sent until the user submits.
function prefillTicketFromOrder(o) {
  const form = document.getElementById("order-form");
  if (!form) return;
  const hasPrice = o.price && Number(o.price) > 0;
  form.symbol.value = String(o.symbol || "").toUpperCase();
  form.side.value = String(o.side) === "Sell" ? "Sell" : "Buy";
  form.side.dispatchEvent(new Event("change", { bubbles: true }));
  form.orderType.value = hasPrice ? "Limit" : "Market";
  form.orderType.dispatchEvent(new Event("change", { bubbles: true }));
  if (form.sizeMode.value !== "qty") {
    form.sizeMode.value = "qty"; // amend edits an explicit qty, never margin-derived
    form.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
  }
  form.qty.value = o.qty != null ? String(o.qty) : "";
  form.price.value = hasPrice ? String(o.price) : "";
  form.symbol.dispatchEvent(new Event("input", { bubbles: true })); // spec+leverage+book+preview
  try { (hasPrice ? form.price : form.qty).focus({ preventScroll: true }); } catch (e) {}
  form.scrollIntoView({ block: "nearest" });
}

// --- instrument specs (tick/lot/leverage filters) ---
async function fetchInstrumentSpec(symbol) {
  const sym = (symbol || "").trim().toUpperCase();
  if (!sym) { renderSpecStrip(null); return; }
  if (state.specs[sym]) { renderSpecStrip(state.specs[sym]); return; }
  try {
    const data = await api(`/api/instruments?symbol=${encodeURIComponent(sym)}`);
    const i = ((data.result && data.result.list) || [])[0];
    if (!i) { renderSpecStrip(null); return; }
    state.specs[sym] = {
      symbol: sym,
      tickSize: i.priceFilter && i.priceFilter.tickSize,
      qtyStep: i.lotSizeFilter && i.lotSizeFilter.qtyStep,
      minOrderQty: i.lotSizeFilter && i.lotSizeFilter.minOrderQty,
      maxOrderQty: i.lotSizeFilter && i.lotSizeFilter.maxOrderQty,
      maxLeverage: i.leverageFilter && i.leverageFilter.maxLeverage,
    };
    renderSpecStrip(state.specs[sym]);
    // Re-run order-form sizing now the lot step is known, so a Margin-derived qty
    // snaps to the step as soon as the spec arrives (the first derive may have run
    // with an unsnapped value while this request was in flight).
    const oform = document.getElementById("order-form");
    if (oform && oform.symbol && oform.symbol.value.trim().toUpperCase() === sym) {
      oform.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (e) {
    renderSpecStrip(null); // never block trading on a spec-fetch failure
  }
}

function renderSpecStrip(spec) {
  const el = document.getElementById("order-spec");
  if (!el) return;
  if (!spec) { el.hidden = true; el.innerHTML = ""; return; }
  // Display only — show the instrument's filters as a reference strip. We do NOT
  // set min/step on the inputs: they are type=text (so those attrs are inert),
  // and the authoritative check is the non-blocking specWarnings shown in the
  // confirm modal (the server stays authoritative on acceptance).
  const parts = [];
  if (spec.tickSize != null) parts.push(`tick <b>${esc(spec.tickSize)}</b>`);
  if (spec.qtyStep != null) parts.push(`step <b>${esc(spec.qtyStep)}</b>`);
  if (spec.minOrderQty != null) parts.push(`min <b>${esc(spec.minOrderQty)}</b>`);
  if (spec.maxOrderQty != null) parts.push(`max <b>${esc(spec.maxOrderQty)}</b>`);
  if (spec.maxLeverage != null) parts.push(`maxLev <b>${esc(spec.maxLeverage)}x</b>`);
  el.innerHTML = parts.join("");
  el.hidden = parts.length === 0;
}

// --- active symbol + live order-book widget ---
function setActiveSymbol(sym) {
  const symbol = (sym || "").trim().toUpperCase();
  if (!symbol) return;
  if (symbol !== state.activeSymbol) {
    state.activeSymbol = symbol;
    const lbl = document.getElementById("book-symbol");
    if (lbl) lbl.textContent = symbol;
    // The ladder needs the instrument's tick size for decimals/grouping —
    // a workspace-restored symbol never passes through the ticket's own
    // spec fetch, so fetch it here (cache-first, so this is usually free).
    if (!state.specs[symbol]) fetchInstrumentSpec(symbol);
    loadBook();
    if (typeof exPaintQuickActions === "function") exPaintQuickActions();
    wsAutoSave(); // the book symbol is part of the active workspace
  }
  startBookPolling();
}

let _bookTimer = null;
function startBookPolling() {
  stopBookPolling();
  _bookTimer = setInterval(() => {
    const pane = document.querySelector('[data-pane="dashboard"]');
    if (!state.activeSymbol || !pane || pane.hidden) { stopBookPolling(); return; }
    if (document.hidden) return; // backgrounded browser tab: skip, don't cancel
    const bookSec = document.querySelector('[data-wpanel="book"]');
    if (bookSec && bookSec.classList.contains("collapsed")) return; // panel folded away
    loadBook();
  }, 4000);
}
function stopBookPolling() { if (_bookTimer) { clearInterval(_bookTimer); _bookTimer = null; } }

async function loadBook() {
  const el = document.getElementById("book-widget");
  if (!el || !state.activeSymbol) return;
  const requestedFor = state.activeSymbol; // supersede guard for racing loads
  try {
    // Deeper snapshot for the execution ladder (grouping needs raw levels);
    // one read either way. exec.js renders the professional ladder when
    // loaded; the legacy renderer stays as the fallback.
    const data = await api(`/api/orderbook?symbol=${encodeURIComponent(requestedFor)}&limit=200`);
    if (requestedFor !== state.activeSymbol) return; // a newer symbol owns the widget
    if (typeof exRenderLadder === "function") {
      exRenderLadder(data);
    } else {
      el.innerHTML = renderBookLadder(data, { clickable: true, depth: 8 });
    }
  } catch (e) {
    if (requestedFor !== state.activeSymbol) return;
    el.innerHTML = `<p class="muted book-empty">Order book unavailable: ${esc(e.message)}</p>`;
  }
}

// Shared depth-ladder renderer (rail widget + API explorer): cumulative-size
// shading + a spread/mid row. Bars are sized from coerced numbers only.
function renderBookLadder(data, opts = {}) {
  const depth = opts.depth || 12;
  const clickable = opts.clickable ? " clickable" : "";
  const r = (data && data.result) || {};
  const bids = (r.b || []).filter(Array.isArray).slice(0, depth);
  const asks = (r.a || []).filter(Array.isArray).slice(0, depth);
  if (!bids.length && !asks.length) return `<p class="muted book-empty">No depth.</p>`;
  const sz = (row) => Number(row[1]) || 0;
  const maxSz = Math.max(1, ...bids.map(sz), ...asks.map(sz));
  // data-px stays the RAW (USDT) price so click-to-fill always feeds the USDT
  // price input correctly; only the displayed price converts (explorer view).
  const pxDisp = (px) => (opts.convert ? cvtCell(px) : esc(px));
  const money = (v) => (opts.convert ? fmtMoney(v, 4) : fmtNum(v, 4));
  const rowHTML = (side, px, size) => {
    const w = (Number(size) || 0) / maxSz * 100;
    // When clickable, make each level keyboard-operable (role/tabindex + label)
    // so the price can be picked without a mouse. px is upstream data — escape it.
    const kb = opts.clickable ? ` role="button" tabindex="0" title="Click to fill the limit price" aria-label="Use price ${esc(px)}"` : "";
    return `<div class="book-row ${side}${clickable}" data-px="${esc(px)}"${kb}>` +
      `<span class="depth" style="width:${w.toFixed(1)}%"></span>` +
      `<span class="px">${pxDisp(px)}</span><span class="sz">${esc(size)}</span></div>`;
  };
  const asksHtml = asks.slice().reverse().map((a) => rowHTML("ask", a[0], a[1])).join("");
  const bidsHtml = bids.map((b) => rowHTML("bid", b[0], b[1])).join("");
  const bestBid = bids.length ? Number(bids[0][0]) : null;
  const bestAsk = asks.length ? Number(asks[0][0]) : null;
  let spread = "";
  if (bestBid && bestAsk && bestAsk >= bestBid) {
    const mid = (bestBid + bestAsk) / 2;
    const bps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0; // ratio: no convert
    spread = `<div class="book-spread"><span class="mid">${money(mid)}</span>` +
      `<span class="sp">spread ${money(bestAsk - bestBid)} · ${bps.toFixed(1)} bps</span></div>`;
  }
  return asksHtml + spread + bidsHtml;
}

// Pre-fill the limit price from a book level (switching to Limit if needed).
// Shared by pointer + keyboard so the two paths can never diverge.
function fillPriceFromBookRow(br) {
  const form = document.getElementById("order-form");
  if (!form) return;
  if (form.orderType.value !== "Limit") {
    form.orderType.value = "Limit";
    form.orderType.dispatchEvent(new Event("change", { bubbles: true }));
  }
  form.price.value = br.getAttribute("data-px");
  form.price.dispatchEvent(new Event("input", { bubbles: true }));
}
document.addEventListener("click", (e) => {
  const br = e.target.closest(".book-row.clickable[data-px]");
  if (br) fillPriceFromBookRow(br);
});
// Keyboard parity for clickable book rows (non-<button> elements made
// operable with role="button" tabindex="0"). Chart cards use real buttons.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  if (!e.target || !e.target.closest) return;
  const br = e.target.closest(".book-row.clickable[data-px]");
  if (br && e.target === br) { e.preventDefault(); fillPriceFromBookRow(br); }
});

// ---------------------------------------------------------------------------
// History analytics (CSP-safe inline SVG; built from data already fetched)
// ---------------------------------------------------------------------------
function svgAreaChart(values, opts = {}) {
  const w = opts.w || 320, h = opts.h || 90, pad = 6;
  if (!values || values.length < 2) return `<p class="muted" style="font-size:12px">Not enough data to chart.</p>`;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const dx = (w - pad * 2) / (values.length - 1);
  const x = (i) => pad + i * dx;
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `M${x(0).toFixed(1)},${(h - pad).toFixed(1)} L${pts.join(" L")} L${x(values.length - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const end = values[values.length - 1];
  // Colours via `style` (not presentation attributes) so CSS var() resolves.
  const col = end >= (values[0] || 0) ? "var(--pos)" : "var(--neg)";
  const zeroY = (min <= 0 && max >= 0) ? y(0).toFixed(1) : null;
  const zeroLine = zeroY ? `<line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" style="stroke:var(--border)" stroke-dasharray="3 3"/>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Cumulative PnL curve">` +
    `<path d="${area}" style="fill:${col};fill-opacity:0.12"/>` + zeroLine +
    `<path d="${line}" style="fill:none;stroke:${col};stroke-width:1.5"/>` +
    `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="2.6" style="fill:${col}"/></svg>`;
}

// Compact human duration for the journal's holding-time stat.
function fmtDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function renderHistoryAnalytics(closedList, fees, makerCount, takerCount) {
  const el = document.getElementById("history-analytics");
  if (!el) return;
  const list = (closedList || []).slice().sort(
    (a, b) => Number(a.updatedTime ?? a.createdTime) - Number(b.updatedTime ?? b.createdTime)
  );
  if (!list.length) { el.hidden = true; el.innerHTML = ""; return; }
  let cum = 0;
  let curve = list.map((r) => (cum += Number(r.closedPnl) || 0));
  // Max drawdown over the FULL cumulative series (before any downsampling):
  // deepest fall from a running equity peak, baseline 0.
  let peak = 0, maxDD = 0;
  curve.forEach((v) => {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  });
  // Downsample very long curves: a 10k-point SVG path janks layout for zero
  // visual gain in a ~320px-wide chart. Cumulative values are computed over
  // the FULL list first, so sampling changes resolution, never the shape/end.
  if (curve.length > 800) {
    const stride = Math.ceil(curve.length / 600);
    const lastIdx = curve.length - 1;
    curve = curve.filter((_, i) => i % stride === 0 || i === lastIdx);
  }
  const wins = list.filter((r) => (Number(r.closedPnl) || 0) > 0).length;
  const losses = list.length - wins;
  const winPct = list.length ? (wins / list.length) * 100 : 0;
  const total = curve[curve.length - 1] || 0;

  // Profit/loss BOOKED: split realised PnL by sign. grossLoss accumulates the
  // negative records (so it is ≤ 0). "Positive PnL %" is the share of profit in
  // the total gross flow (profit ÷ (profit + |loss|)) — the amount-weighted
  // analogue of win rate, so a few big losses pull it down even at a high win rate.
  let grossWin = 0, grossLoss = 0;
  list.forEach((r) => { const v = Number(r.closedPnl) || 0; if (v > 0) grossWin += v; else grossLoss += v; });
  const grossLossAbs = Math.abs(grossLoss);
  const flow = grossWin + grossLossAbs;
  const posPct = flow > 0 ? (grossWin / flow) * 100 : 0;

  // --- Journal statistics (all derived from the already-fetched list) ---
  const pnls = list.map((r) => Number(r.closedPnl) || 0);
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : (grossWin > 0 ? Infinity : 0);
  const expectancy = total / list.length;      // mean net PnL per closed trade
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0; // ≤ 0 by construction
  const largestWin = Math.max(0, ...pnls);
  const largestLoss = Math.min(0, ...pnls);
  // Holding time: closed-pnl rows carry createdTime (open) + updatedTime (close).
  let holdSum = 0, holdN = 0;
  list.forEach((r) => {
    const a = Number(r.createdTime), b = Number(r.updatedTime);
    if (isFinite(a) && isFinite(b) && b > a) { holdSum += b - a; holdN++; }
  });
  const avgHoldMs = holdN ? holdSum / holdN : NaN;

  // Risk-adjusted statistics — PER-TRADE variants (each closed trade is one
  // observation; not annualized, and labeled as such). All guarded against
  // zero-variance/zero-loss degenerate cases: null renders as "—".
  const meanPnl = total / list.length;
  const variance = pnls.reduce((s, v) => s + (v - meanPnl) * (v - meanPnl), 0) / list.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? meanPnl / stdev : null;
  const downside = pnls.filter((v) => v < 0);
  const downsideDev = Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / list.length);
  const sortino = downsideDev > 0 ? meanPnl / downsideDev : null;
  const winRate = wins / list.length;
  const winLossRatio = avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null;
  const kelly = winLossRatio && winLossRatio > 0
    ? Math.max(-100, Math.min(100, (winRate - (1 - winRate) / winLossRatio) * 100))
    : null;
  const recovery = maxDD > 0 ? total / maxDD : null;

  // Breakdowns for the journal: PnL by symbol (top 5 by magnitude) + weekday.
  const bySymbol = {};
  list.forEach((r) => {
    const sym = String(r.symbol || "?");
    (bySymbol[sym] = bySymbol[sym] || { pnl: 0, n: 0 });
    bySymbol[sym].pnl += Number(r.closedPnl) || 0;
    bySymbol[sym].n++;
  });
  const topSymbols = Object.entries(bySymbol)
    .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
    .slice(0, 5);
  const weekday = Array.from({ length: 7 }, () => 0);
  list.forEach((r) => {
    const t = Number(r.updatedTime ?? r.createdTime);
    if (isFinite(t)) weekday[new Date(t).getDay()] += Number(r.closedPnl) || 0;
  });
  const weekdayMax = Math.max(1e-9, ...weekday.map(Math.abs));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const coin = curUnit();
  const feeStr = fees != null && isFinite(fees) ? `${fmtMoney(fees)} ${coin}` : "—";
  const mt = (makerCount != null && takerCount != null) ? `${makerCount} / ${takerCount}` : "—";
  el.hidden = false;
  // Every `.v` (and the bars/curve, handled in CSS) is a private account figure,
  // masked by the privacy toggle; the `.k` labels stay readable.
  el.innerHTML =
    `<div class="chart-card"><div class="chart-title">Cumulative closed PnL (recent ${list.length})</div>${svgAreaChart(curve)}</div>` +
    `<div class="stat-figs">` +
      `<div class="figrow"><span class="k">Net realised</span><span class="v priv ${pnlClass(total)}">${fmtMoneySigned(total)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Win rate</span><span class="v priv">${winPct.toFixed(0)}%</span></div>` +
      `<div class="wl-bar" role="img" aria-label="${wins} wins, ${losses} losses"><span class="w" style="width:${winPct.toFixed(1)}%"></span><span class="l" style="width:${(100 - winPct).toFixed(1)}%"></span></div>` +
      `<div class="figrow"><span class="k">Wins / Losses</span><span class="v priv">${wins} / ${losses}</span></div>` +
      `<div class="figrow"><span class="k">Profit booked</span><span class="v priv pos">${fmtMoneySigned(grossWin)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Loss booked</span><span class="v priv neg">${fmtMoneySigned(grossLoss)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Positive PnL %</span><span class="v priv">${posPct.toFixed(0)}%</span></div>` +
      `<div class="posneg-bar" role="img" aria-label="${posPct.toFixed(0)}% of booked PnL is profit"><span class="p" style="width:${posPct.toFixed(1)}%"></span><span class="n" style="width:${(100 - posPct).toFixed(1)}%"></span></div>` +
      `<div class="figrow"><span class="k">Fees (maker/taker)</span><span class="v priv">${esc(mt)}</span></div>` +
      `<div class="figrow"><span class="k">Total fees</span><span class="v priv neg">${esc(feeStr)}</span></div>` +
    `</div>` +
    // Journal tiles: the derived performance statistics a trading journal is
    // expected to carry. Every value is money-derived, so all are `priv`.
    `<div class="journal-grid">` +
      jTile("Profit factor", profitFactor === Infinity ? "∞" : profitFactor.toFixed(2),
        profitFactor >= 1 ? "pos" : "neg") +
      jTile("Expectancy / trade", `${fmtMoneySigned(expectancy)}`, pnlClass(expectancy)) +
      jTile("Avg win", fmtMoneySigned(avgWin), "pos") +
      jTile("Avg loss", fmtMoneySigned(avgLoss), "neg") +
      jTile("Largest win", fmtMoneySigned(largestWin), "pos") +
      jTile("Largest loss", fmtMoneySigned(largestLoss), "neg") +
      jTile("Max drawdown", fmtMoneySigned(-maxDD), maxDD > 0 ? "neg" : "flat") +
      jTile("Avg hold time", esc(fmtDuration(avgHoldMs)), "flat") +
      jTile("Sharpe (per-trade)", sharpe != null ? sharpe.toFixed(2) : "—", sharpe != null ? pnlClass(sharpe) : "flat") +
      jTile("Sortino (per-trade)", sortino != null ? sortino.toFixed(2) : "—", sortino != null ? pnlClass(sortino) : "flat") +
      jTile("Kelly %", kelly != null ? `${kelly.toFixed(0)}%` : "—", kelly != null ? pnlClass(kelly) : "flat") +
      jTile("Recovery factor", recovery != null ? recovery.toFixed(2) : "—", recovery != null ? pnlClass(recovery) : "flat") +
    `</div>` +
    // Breakdown row: where the PnL came from (symbols) and when (weekdays).
    `<div class="journal-breakdown">` +
      `<div class="jb-card"><div class="chart-title">PnL by symbol · top ${topSymbols.length}</div>` +
        topSymbols.map(([sym, s]) =>
          `<div class="jb-row"><span class="jb-sym mono">${esc(sym)}</span>` +
          `<span class="jb-n muted">${s.n}×</span>` +
          `<span class="jb-v priv ${pnlClass(s.pnl)}">${fmtMoneySigned(s.pnl)}</span></div>`
        ).join("") +
      `</div>` +
      `<div class="jb-card"><div class="chart-title">PnL by weekday</div><div class="wd-bars">` +
        weekday.map((v, i) => {
          const h = Math.max(3, (Math.abs(v) / weekdayMax) * 46);
          return `<div class="wd-col" title="${weekdayNames[i]}">` +
            `<i class="${v >= 0 ? "up" : "down"}" style="height:${h.toFixed(0)}px"></i>` +
            `<span>${weekdayNames[i][0]}</span></div>`;
        }).join("") +
      `</div></div>` +
    `</div>`;
}

// One journal statistic tile (label + masked value). Values arrive from fmt*
// helpers (plain text) or pre-escaped strings — never raw exchange data.
function jTile(label, value, cls) {
  return `<div class="j-tile"><div class="k">${esc(label)}</div><div class="v priv ${cls || ""}">${value}</div></div>`;
}

// ---------------------------------------------------------------------------
// FUNDING TAB — funding-fee analytics over the Trades mirror (execType =
// "Funding"). Aggregates (Σ execFee, avg feeRate) are computed SERVER-side
// over every matching document; the table shows only the newest rows, and the
// note under it says so whenever the two differ. Filters: symbol + "since"
// (inclusive >= date-time). Read-only, no polling — fetches on tab activation
// and on Apply.
// ---------------------------------------------------------------------------
let _fdWired = false;

function onFundingActive() {
  if (!_fdWired) {
    _fdWired = true;
    fdWire();
  }
  fdLoad(); // refetch on every visit: cheap Mongo read, keeps the lens fresh
}

function fdWire() {
  // Prefill defaults (still freely editable): the fund-tracking baseline
  // date-time and the primary traded symbol.
  const since = document.getElementById("fd-since");
  if (since && !since.value) since.value = "2026-08-22T00:00";
  const symbol = document.getElementById("fd-symbol");
  if (symbol && !symbol.value) symbol.value = "SOLUSDT";
  const apply = () => fdLoad();
  document.getElementById("fd-apply")?.addEventListener("click", apply);
  document.getElementById("fd-symbol")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
  since?.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
}

async function fdLoad() {
  const synced = document.getElementById("fd-synced");
  const rowsEl = document.getElementById("fd-rows");
  if (!rowsEl) return;
  const sym = (document.getElementById("fd-symbol")?.value || "").trim().toUpperCase();
  const sinceRaw = document.getElementById("fd-since")?.value || "";
  const params = new URLSearchParams();
  if (sym) params.set("symbol", sym);
  if (sinceRaw) {
    const ms = Date.parse(sinceRaw); // local time, per datetime-local semantics
    if (isFinite(ms)) params.set("startTime", String(ms));
  }
  if (synced) synced.textContent = "Loading…";
  let r;
  try {
    r = (await api(`/api/funding?${params.toString()}`)).result || {};
  } catch (err) {
    if (synced) synced.textContent = err.message || "Failed to load funding data";
    return;
  }
  fdRender(r);
}

function fdRender(r) {
  const feeEl = document.getElementById("fd-fee-sum");
  const rateEl = document.getElementById("fd-rate-avg");
  const rateRaw = document.getElementById("fd-rate-raw");
  const countEl = document.getElementById("fd-count");
  const rangeEl = document.getElementById("fd-range");
  const synced = document.getElementById("fd-synced");
  const rowsEl = document.getElementById("fd-rows");
  const note = document.getElementById("fd-note");

  const feeSum = Number(r.feeSum);
  if (feeEl) {
    feeEl.textContent = isFinite(feeSum)
      ? `${fmtMoneySigned(feeSum, 4)} ${curUnit()}` : "—";
    // A paid fee (positive) is a cost, a negative one is income — color accordingly.
    feeEl.classList.remove("pos", "neg");
    if (isFinite(feeSum) && feeSum !== 0) feeEl.classList.add(feeSum > 0 ? "neg" : "pos");
  }
  const rateAvg = r.rateAvg === null || r.rateAvg === undefined ? null : Number(r.rateAvg);
  if (rateEl) rateEl.textContent = rateAvg !== null && isFinite(rateAvg)
    ? `${(rateAvg * 100).toFixed(4)}%` : "—";
  if (rateRaw) rateRaw.textContent = rateAvg !== null && isFinite(rateAvg)
    ? `raw ${rateAvg}` : "no parseable rates in range";
  if (countEl) countEl.textContent = isFinite(Number(r.count)) ? String(r.count) : "—";
  if (rangeEl) rangeEl.textContent = r.startMs ? `since ${fmtTime(r.startMs)}` : "";
  if (synced) {
    synced.textContent = r.lastSyncedMs
      ? `data synced ${fmtTime(r.lastSyncedMs)}` : "mirror not synced yet";
  }

  const rows = Array.isArray(r.rows) ? r.rows : [];
  if (rowsEl) {
    if (!rows.length) {
      rowsEl.innerHTML = '<tr><td colspan="4" class="muted">No funding events in this range.</td></tr>';
    } else {
      rowsEl.innerHTML = rows.map((row) => {
        const fee = Number(row.execFee);
        const feeCls = isFinite(fee) && fee !== 0 ? (fee > 0 ? "neg" : "pos") : "flat";
        const rate = Number(row.feeRate);
        return `<tr>
          <td>${fmtTime(row.execTime)}</td>
          <td>${esc(row.symbol || "—")}</td>
          <td>${isFinite(rate) ? esc((rate * 100).toFixed(4)) + "%" : "—"}</td>
          <td class="${feeCls}">${cvtCell(row.execFee)}</td>
        </tr>`;
      }).join("");
    }
  }
  if (note) {
    const truncated = isFinite(Number(r.count)) && rows.length < Number(r.count);
    note.hidden = !truncated;
    if (truncated) {
      note.textContent = `Showing the newest ${rows.length} of ${r.count} events — the totals above cover all ${r.count}.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Account & risk overview (folds the explorer's wallet/account reads into a
// first-class, glanceable section). Read-only.
// ---------------------------------------------------------------------------
let _accountLoaded = false;
function onAccountActive() { if (!_accountLoaded) { _accountLoaded = true; loadAccountOverview(); } }

async function loadAccountOverview() {
  const el = document.getElementById("account-overview");
  if (!el) return;
  el.innerHTML = loadingMsg("Loading account…");
  try {
    const [bal, info, withdraw] = await Promise.all([
      api("/api/balance").catch(() => null),
      api("/api/account-info").catch(() => null),
      api("/api/withdrawable").catch(() => null),
    ]);
    const acct = listOf(bal)[0];
    const coin = curUnit();
    const num = (v) => (v !== undefined && v !== "" && isFinite(Number(v)) ? Number(v) : null);
    const cards = [];
    if (acct) {
      const mb = num(acct.totalMarginBalance);
      const mm = num(acct.totalMaintenanceMargin);
      const im = num(acct.totalInitialMargin);
      const avail = num(acct.totalAvailableBalance);
      const util = (im != null && mb && mb > 0) ? (im / mb) * 100 : null;
      const mmRate = num(acct.accountMMRate);
      const ratio = mmRate != null ? mmRate * 100 : (mm != null && mb && mb > 0 ? (mm / mb) * 100 : null);
      // Every account-overview card is a private money/ratio figure → `priv`.
      const card = (k, v, cls) => cards.push(`<div class="acct-card"><div class="k">${esc(k)}</div><div class="v priv ${cls || ""}">${v}</div></div>`);
      card("Equity", `${fmtMoney(num(acct.totalEquity))} ${esc(coin)}`);
      card("Available", `${fmtMoney(avail)} ${esc(coin)}`);
      card("Unrealised PnL", `${fmtMoneySigned(acct.totalPerpUPL)} ${esc(coin)}`, pnlClass(acct.totalPerpUPL));
      card("Margin used (IM)", `${fmtMoney(im)} ${esc(coin)}`);
      card("Maint. margin", `${fmtMoney(mm)} ${esc(coin)}`);
      if (util != null) card("Margin utilization", fmtPct(util, false), util >= 80 ? "neg" : util >= 50 ? "warn" : "");
      if (ratio != null) card("Account margin ratio", fmtPct(ratio, false), ratio >= 80 ? "neg" : ratio >= 50 ? "warn" : "");
    }
    const head = cards.length ? `<div class="acct-grid">${cards.join("")}</div>` : "";
    const walletTbl = bal ? renderWallet(bal) : "";
    const infoTbl = (info && info.result) ? `<div class="explorer-summary">Account info</div>${renderAccountInfo(info)}` : "";
    const wdTbl = withdraw ? `<div class="explorer-summary">Withdrawable (${esc(curUnit())})</div>${renderWithdrawable(withdraw)}` : "";
    el.innerHTML = (head + walletTbl + infoTbl + wdTbl) || emptyMsg("No account data");
  } catch (e) {
    el.innerHTML = errorMsg(e.message);
  }
}

// ---------------------------------------------------------------------------
// Privacy toggle — hide every account figure (balances, sizes, PnL, performance)
// behind a fixed **** mask. A DISPLAY-ONLY lens: it flips body.privacy-on, which
// CSS uses to mask `.priv` elements + neutralise their gauges. It never touches
// the data model (state.available, sizing math, confirms, submissions all read
// real numbers from JS), so there is no monetary/security impact. Public market
// data (Markets, Live Charts, order book, tickers) is unmarked and stays visible.
// Preference persists in localStorage (like the currency lens); never the token.
// ---------------------------------------------------------------------------
function wirePrivacyToggle() {
  const btn = document.getElementById("privacy-toggle");
  if (!btn) return;
  let on = false;
  try { on = localStorage.getItem("dma.privacy") === "on"; } catch (e) {}
  const apply = () => {
    document.body.classList.toggle("privacy-on", on);
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "Show account figures" : "Hide account figures";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    // The tab title carries live PnL (see renderSummary) — scrub it the moment
    // privacy turns on; the next snapshot restores it after privacy turns off.
    if (on) document.title = "DMA Terminal — Dashboard";
  };
  apply(); // restore saved state before the first snapshot renders (no flash)
  btn.addEventListener("click", () => {
    on = !on;
    try { localStorage.setItem("dma.privacy", on ? "on" : "off"); } catch (e) {}
    apply();
  });
}

// ---------------------------------------------------------------------------
// Theme toggle (dark / light) — pure display state, next to the privacy eye.
// theme.js (loaded in <head>) already stamped the stored theme before first
// paint and owns persistence; this only wires the button and keeps its label
// truthful. No re-render is needed anywhere: every surface is CSS tokens, the
// live charts are class-styled SVG, and the one <canvas> (charts.js PNG
// export) samples the palette at capture time. Modules that ever DO need to
// repaint imperatively can listen for the window `themechange` event.
// ---------------------------------------------------------------------------
function wireThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn || !window.Theme) return;
  const paint = () => {
    const light = window.Theme.get() === "light";
    // The label describes what the click DOES, not the current state.
    const label = light ? "Switch to dark theme" : "Switch to light theme";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", String(light));
  };
  paint();
  btn.addEventListener("click", () => {
    window.Theme.toggle();
    paint();
  });
  // Keep the label right when the OS flips the theme under a "system" pref.
  window.addEventListener("themechange", paint);
}

// ---------------------------------------------------------------------------
// Currency display toggle (USDT / INR) — read-only display lens
// ---------------------------------------------------------------------------
function wireCurrencyToggle() {
  const seg = document.getElementById("ccy-toggle");
  if (!seg) return;
  let saved = null;
  try { saved = localStorage.getItem("dma.currency"); } catch (e) {}
  if (saved === "INR" || saved === "USDT") state.currency = saved;
  const paint = () => {
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.ccy === state.currency;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  };
  seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.currency === b.dataset.ccy) return;
      state.currency = b.dataset.ccy;
      try { localStorage.setItem("dma.currency", state.currency); } catch (e) {}
      paint();
      rerenderForCurrency();
    })
  );
  paint();
}

// Re-render every loaded read-only view in the newly selected currency. Write
// surfaces (order ticket, modals, rail order book) are USDT and need no redraw.
function rerenderForCurrency() {
  if (state.lastDashboard) renderDashboard(state.lastDashboard);
  if (_marketsData) renderMarkets();
  if (_scData) scRerender();
  // Execution panel (fees/volume tiles honor the lens; the rail ladder stays
  // USDT per the write-surface contract).
  exRerenderCurrency();
  // Re-render the journal from its cached payloads — a currency flip is a pure
  // display change and must not refetch (an "Overall" read is ~10k rows/mirror).
  jnRerenderCurrency();
  if (_accountLoaded) loadAccountOverview();
  if (state.lastExplorer) {
    const out = document.getElementById("explorer-result");
    if (out) renderExplorerOutput(out, state.lastExplorer.render, state.lastExplorer.data);
  }
}

// Keep the sticky order-rail's offset in sync with the ACTUAL header height, so
// a taller/wrapped header (narrow window) never overlaps the rail. Display-only.
function syncHeaderHeight() {
  const el = document.querySelector(".sticky-top");
  if (el) document.documentElement.style.setProperty("--header-h", el.offsetHeight + "px");
}

// ---------------------------------------------------------------------------
// Live charts — the multi-chart workspace now lives in charts.js (loaded
// before this file). It preserves this module's contracts: wireCharts(),
// startChartPolling()/stopChartPolling() (tab switch, panel collapse and
// visibility hooks below call them), the /api/klines polling economics, and
// the CSP-safe hand-drawn SVG renderer. Workspace persistence goes through
// mcCaptureState()/mcApplyState()/mcSanitizeCharts() from that file.
// ---------------------------------------------------------------------------

// ===========================================================================
// MARKET SCANNER  (the "Scan" tab)
// ---------------------------------------------------------------------------
// A live market-intelligence dashboard over the whole tradable universe:
// overview cards (movers / losers / volume / volatility / funding / activity /
// watchlist / alerts) + a virtualized, sortable, rule-filterable screener.
//
// Data: /api/scanner — a snapshot the BACKEND sampler maintains from ONE
// shared ticker poll (app/scanner.py). This tab polls that in-memory endpoint
// on the Watch tab's cadence while visible (plus a slow background tick only
// while alerts are armed), so N tabs never add upstream exchange calls.
// Honesty rule inherited from the backend: a metric whose window hasn't
// warmed up (or that the exchange doesn't supply) arrives as null and renders
// as "—" — nothing is ever fabricated.
//
// Layout mirrors the watchlist module: a PURE, DOM-free core first (top-level
// functions + one-line consts so tests/test_snap.mjs can extract and unit-test
// them), then the DOM manager. Everything here is display/navigation state —
// nothing in this module can place, modify or cancel an order, and scanner
// alerts only ever notify (toast + notification center).
// ===========================================================================

const SC_STORE_KEY = "dma.scanner.v1";
const SC_SCHEMA_VERSION = 1;
const SC_MAX_SCANS = 20;
const SC_MAX_RULES = 8;
const SC_MAX_ALERTS = 50;
const SC_MAX_LOG = 50;
const SC_MAX_FAVS = 200;
const SC_SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const SC_TOP_N = 10;
// Metrics the rule engine, sorting and filters can reference. Derived ones
// (funding as %, distance to 24h high/low, spread) are computed on demand by
// scMetric so new server fields plug in without touching the engine.
const SC_METRICS = ["last", "pct5m", "pct15m", "pct1h", "pct24h", "range24hPct", "vol15mPct", "turnover24h", "turnoverDelta15m", "fundingPct", "fundingDelta1hPct", "openInterestValue", "distHigh24hPct", "distLow24hPct", "spreadPct"];
const SC_OPS = ["gt", "gte", "lt", "lte", "absGte", "absLte"];
const SC_SORTS = SC_METRICS.concat(["symbol"]);
const SC_PRESETS = ["all", "favorites", "gainers", "losers", "momentum", "breakout", "meanrevert", "highvolume", "largecaps", "smallcaps", "active", "watchlist"];
const SC_SECTION_IDS = ["movers", "losers", "volume", "volatility", "funding", "active", "watchlist", "alerts"];
const SC_ALERT_KINDS = ["top_mover", "vol_double", "vol15m", "move15m", "funding_abs"];
const SC_ALERT_COOLDOWN_MS = 30 * 60000;

function scId(prefix) {
  return (prefix || "sc") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Metric accessor — the single place a metric name becomes a number. Returns a
// FINITE number or null; null means "not available", which no rule, filter or
// rank may ever satisfy (missing data must not fake a match).
function scMetric(row, key) {
  if (!row) return null;
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  switch (key) {
    case "fundingPct": {
      const f = num(row.fundingRate);
      return f === null ? null : f * 100;
    }
    case "fundingDelta1hPct": {
      const f = num(row.fundingDelta1h);
      return f === null ? null : f * 100;
    }
    case "distHigh24hPct": {
      const h = num(row.high24h), l = num(row.last);
      return h !== null && h > 0 && l !== null ? ((h - l) / h) * 100 : null;
    }
    case "distLow24hPct": {
      const lo = num(row.low24h), l = num(row.last);
      return lo !== null && lo > 0 && l !== null ? ((l - lo) / lo) * 100 : null;
    }
    case "spreadPct": {
      const b = num(row.bid1), a = num(row.ask1), l = num(row.last);
      return b !== null && a !== null && l !== null && l > 0 && a >= b ? ((a - b) / l) * 100 : null;
    }
    default:
      return num(row[key]);
  }
}

// ---- rule engine (custom scans) ----
function scSanitizeRule(r) {
  if (!r || typeof r !== "object") return null;
  const value = Number(r.value);
  if (!SC_METRICS.includes(r.metric) || !SC_OPS.includes(r.op) || !isFinite(value)) return null;
  return { metric: r.metric, op: r.op, value };
}
function scEvalRule(rule, row) {
  if (!rule) return false;
  const v = scMetric(row, rule.metric);
  if (v === null) return false; // missing data never satisfies a rule
  switch (rule.op) {
    case "gt": return v > rule.value;
    case "gte": return v >= rule.value;
    case "lt": return v < rule.value;
    case "lte": return v <= rule.value;
    case "absGte": return Math.abs(v) >= rule.value;
    case "absLte": return Math.abs(v) <= rule.value;
    default: return false;
  }
}
function scScanMatches(scan, row) {
  if (!scan || !Array.isArray(scan.rules) || !scan.rules.length) return false;
  return scan.mode === "or"
    ? scan.rules.some((r) => scEvalRule(r, row))
    : scan.rules.every((r) => scEvalRule(r, row));
}
function scSanitizeScan(s) {
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id) return null;
  const rules = (Array.isArray(s.rules) ? s.rules : [])
    .map(scSanitizeRule).filter(Boolean).slice(0, SC_MAX_RULES);
  if (!rules.length) return null; // a scan with no valid rules matches nothing useful
  return {
    id: s.id.slice(0, 40),
    name: String(s.name || "Scan").slice(0, 40),
    mode: s.mode === "or" ? "or" : "and",
    rules,
    createdAt: Number(s.createdAt) || Date.now(),
  };
}

// ---- alerts (notify-only; evaluated against each snapshot) ----
function scSanitizeAlert(a) {
  if (!a || typeof a !== "object" || !SC_ALERT_KINDS.includes(a.kind)) return null;
  const kind = a.kind;
  const rawSym = typeof a.symbol === "string" ? a.symbol.trim().toUpperCase() : "";
  let symbol = rawSym === "*" ? "*" : (SC_SYMBOL_RE.test(rawSym) ? rawSym : null);
  let value = Number(a.value);
  let baseline = Number(a.baseline);
  if (kind === "vol_double") {
    // Needs a concrete baseline captured at creation; a universe-wide "volume
    // doubled vs when?" has no honest meaning.
    if (!symbol || symbol === "*" || !isFinite(baseline) || baseline <= 0) return null;
    value = null;
  } else if (kind === "top_mover") {
    if (!symbol) symbol = "*";
    value = isFinite(value) ? Math.round(value) : SC_TOP_N;
    if (value < 3 || value > 25) value = SC_TOP_N;
    baseline = null;
  } else {
    if (!symbol) return null;
    if (!isFinite(value) || value <= 0) return null;
    baseline = null;
  }
  const lastFired = {};
  if (a.lastFired && typeof a.lastFired === "object") {
    Object.keys(a.lastFired).slice(0, 200).forEach((s) => {
      const t = Number(a.lastFired[s]);
      if (isFinite(t)) lastFired[s] = t;
    });
  }
  return {
    id: typeof a.id === "string" && a.id ? a.id.slice(0, 40) : scId("al"),
    kind, symbol, value, baseline,
    createdAt: Number(a.createdAt) || Date.now(),
    lastFired,
  };
}
function scAlertLabel(a) {
  if (!a) return "";
  const sym = a.symbol === "*" ? "Any market" : a.symbol;
  switch (a.kind) {
    case "top_mover": return sym + " enters the top " + a.value + " movers";
    case "vol_double": return sym + " 24h volume doubles";
    case "vol15m": return sym + " 15m volatility ≥ " + a.value + "%";
    case "move15m": return sym + " |15m move| ≥ " + a.value + "%";
    case "funding_abs": return sym + " |funding| ≥ " + a.value + "%";
    default: return sym;
  }
}
// Ranked top movers (24h gainers) — feeds the movers card + top_mover alerts.
function scTopMovers(rows, n) {
  return (rows || [])
    .filter((r) => r && scMetric(r, "pct24h") !== null && scMetric(r, "pct24h") > 0)
    .sort((a, b) => scMetric(b, "pct24h") - scMetric(a, "pct24h") || a.symbol.localeCompare(b.symbol))
    .slice(0, n || SC_TOP_N)
    .map((r) => r.symbol);
}
// Evaluate every alert against a snapshot. PURE: reads alert.lastFired but
// mutates nothing; returns [{alert, symbol, message}]. ctx: {index (symbol →
// row), topMovers, prevTopMovers (null on the very first snapshot — top_mover
// alerts are skipped then, otherwise boot would report the whole leaderboard
// as "new entries")}.
function scEvalAlerts(alerts, ctx, now) {
  const fired = [];
  const idx = (ctx && ctx.index) || {};
  const topNow = (ctx && ctx.topMovers) || [];
  const prevTopArr = ctx && Array.isArray(ctx.prevTopMovers) ? ctx.prevTopMovers : null;
  (alerts || []).forEach((a) => {
    if (!a) return;
    const cooling = (sym) => {
      const t = a.lastFired && Number(a.lastFired[sym]);
      return isFinite(t) && now - t < SC_ALERT_COOLDOWN_MS;
    };
    if (a.kind === "top_mover") {
      if (prevTopArr === null) return; // no baseline yet — entering vs booting is indistinguishable
      const rank = a.value || SC_TOP_N;
      // Compare boards at THIS alert's rank: rising from #15 to #8 must count
      // as entering a top-10 board even though #15 was on the deeper list.
      const prevSet = new Set(prevTopArr.slice(0, rank));
      topNow.slice(0, rank).forEach((sym) => {
        if (prevSet.has(sym)) return; // must ENTER the board, not sit on it
        if (a.symbol !== "*" && a.symbol !== sym) return;
        if (cooling(sym)) return;
        fired.push({ alert: a, symbol: sym, message: sym + " entered the top " + rank + " movers" });
      });
      return;
    }
    const evalSym = (sym) => {
      const row = idx[sym];
      if (!row || cooling(sym)) return;
      let ok = false, message = "";
      if (a.kind === "vol_double") {
        const v = scMetric(row, "turnover24h");
        ok = v !== null && a.baseline > 0 && v >= a.baseline * 2;
        message = sym + " 24h volume doubled since the alert was set";
      } else if (a.kind === "vol15m") {
        const v = scMetric(row, "vol15mPct");
        ok = v !== null && v >= a.value;
        if (ok) message = sym + " 15m volatility " + v.toFixed(2) + "% ≥ " + a.value + "%";
      } else if (a.kind === "move15m") {
        const v = scMetric(row, "pct15m");
        ok = v !== null && Math.abs(v) >= a.value;
        if (ok) message = sym + " moved " + v.toFixed(2) + "% in 15m (≥ " + a.value + "%)";
      } else if (a.kind === "funding_abs") {
        const v = scMetric(row, "fundingPct");
        ok = v !== null && Math.abs(v) >= a.value;
        if (ok) message = sym + " funding " + v.toFixed(4) + "% ≥ ±" + a.value + "%";
      }
      if (ok) fired.push({ alert: a, symbol: sym, message });
    };
    if (a.symbol === "*") Object.keys(idx).forEach(evalSym);
    else evalSym(a.symbol);
  });
  return fired;
}

// ---- persisted document ({favs, scans, alerts, log}) ----
function scSanitizeLogEntry(e) {
  if (!e || typeof e !== "object") return null;
  const msg = String(e.msg || "").slice(0, 140);
  if (!msg) return null;
  const rawSym = typeof e.symbol === "string" ? e.symbol.trim().toUpperCase() : "";
  return {
    ts: Number(e.ts) || Date.now(),
    msg,
    symbol: SC_SYMBOL_RE.test(rawSym) ? rawSym : "",
  };
}
function scNewDoc() {
  return { version: SC_SCHEMA_VERSION, favs: [], scans: [], alerts: [], log: [] };
}
// Parse storage into a guaranteed-valid doc; corrupt:true = caller quarantines
// the original blob (user data is never silently discarded), same contract as
// the watchlist/workspace stores.
function scParseDoc(raw) {
  if (raw === null || raw === undefined || raw === "") return { doc: scNewDoc(), corrupt: false };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { doc: scNewDoc(), corrupt: true }; }
  if (!parsed || typeof parsed !== "object" || parsed.version !== SC_SCHEMA_VERSION) {
    return { doc: scNewDoc(), corrupt: true };
  }
  const favs = [];
  const seen = new Set();
  (Array.isArray(parsed.favs) ? parsed.favs : []).forEach((s) => {
    const up = String(s === null || s === undefined ? "" : s).trim().toUpperCase();
    if (SC_SYMBOL_RE.test(up) && !seen.has(up) && favs.length < SC_MAX_FAVS) { seen.add(up); favs.push(up); }
  });
  return {
    doc: {
      version: SC_SCHEMA_VERSION,
      favs,
      scans: (Array.isArray(parsed.scans) ? parsed.scans : []).map(scSanitizeScan).filter(Boolean).slice(0, SC_MAX_SCANS),
      alerts: (Array.isArray(parsed.alerts) ? parsed.alerts : []).map(scSanitizeAlert).filter(Boolean).slice(0, SC_MAX_ALERTS),
      log: (Array.isArray(parsed.log) ? parsed.log : []).map(scSanitizeLogEntry).filter(Boolean).slice(0, SC_MAX_LOG),
    },
    corrupt: false,
  };
}

// ---- per-workspace view state (what §Workspaces persists for this tab) ----
function scSanitizeViewState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const fsrc = src.filters && typeof src.filters === "object" ? src.filters : {};
  const fnum = (x) => {
    if (x === null || x === undefined || x === "") return null;
    const n = Number(x);
    return isFinite(n) ? n : null;
  };
  const secsrc = src.sections && typeof src.sections === "object" ? src.sections : {};
  const order = Array.isArray(secsrc.order)
    ? secsrc.order.filter((id, i) => SC_SECTION_IDS.includes(id) && secsrc.order.indexOf(id) === i)
    : [];
  SC_SECTION_IDS.forEach((id) => { if (!order.includes(id)) order.push(id); }); // future sections append
  const collapsed = {};
  SC_SECTION_IDS.forEach((id) => { if (secsrc.collapsed && secsrc.collapsed[id]) collapsed[id] = true; });
  const preset = typeof src.preset === "string" &&
    (SC_PRESETS.includes(src.preset) || /^scan:[A-Za-z0-9_]{1,40}$/.test(src.preset)) ? src.preset : "all";
  const sel = typeof src.sel === "string" && SC_SYMBOL_RE.test(src.sel) ? src.sel : "";
  return {
    preset,
    sort: SC_SORTS.includes(src.sort) ? src.sort : "pct24h",
    dir: src.dir === "asc" ? "asc" : "desc",
    pinFavs: !!src.pinFavs,
    cards: src.cards !== false,
    filters: {
      priceMin: fnum(fsrc.priceMin), priceMax: fnum(fsrc.priceMax),
      pct24hAbsMin: fnum(fsrc.pct24hAbsMin), turnoverMin: fnum(fsrc.turnoverMin),
      vol15mMin: fnum(fsrc.vol15mMin), fundingAbsMin: fnum(fsrc.fundingAbsMin),
    },
    sections: { order, collapsed },
    sel,
    scroll: Math.max(0, Number(src.scroll) || 0),
  };
}

// ---- fuzzy search: 3 = prefix, 2 = substring, 1 = in-order subsequence ----
function scFuzzyScore(symbol, query) {
  const s = String(symbol || "").toUpperCase();
  const q = String(query || "").trim().toUpperCase();
  if (!q) return 0;
  if (s.startsWith(q)) return 3;
  if (s.includes(q)) return 2;
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length ? 1 : 0;
}

// ---- the view pipeline: preset/scan → numeric filters → search → sort ----
// rows: server snapshot rows; view: scSanitizeViewState shape (+ query);
// ctx: {favs, watch, scans}. Pure; returns a NEW ordered array of rows.
function scComputeView(rows, view, ctx) {
  const v = view || {};
  const c = ctx || {};
  const favSet = new Set(c.favs || []);
  const watchSet = new Set(c.watch || []);
  const m = scMetric;
  const universe = (rows || []).filter(Boolean);
  let out = universe.slice();

  // Quantile over the FULL universe so "high volume"/"caps" presets keep one
  // meaning regardless of the other active filters.
  const quantile = (key, q) => {
    const vals = [];
    universe.forEach((r) => { const x = m(r, key); if (x !== null) vals.push(x); });
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * (vals.length - 1))))];
  };
  // Size proxy: open-interest value when the venue provides it, else turnover.
  const capsKey = universe.some((r) => m(r, "openInterestValue") !== null) ? "openInterestValue" : "turnover24h";

  const preset = typeof v.preset === "string" ? v.preset : "all";
  if (preset === "favorites") out = out.filter((r) => favSet.has(r.symbol));
  else if (preset === "watchlist") out = out.filter((r) => watchSet.has(r.symbol));
  else if (preset === "gainers") out = out.filter((r) => { const p = m(r, "pct24h"); return p !== null && p > 0; });
  else if (preset === "losers") out = out.filter((r) => { const p = m(r, "pct24h"); return p !== null && p < 0; });
  else if (preset === "momentum") out = out.filter((r) => {
    const p15 = m(r, "pct15m"), p1h = m(r, "pct1h");
    return p15 !== null && p1h !== null && ((p15 >= 0.5 && p1h >= 1) || (p15 <= -0.5 && p1h <= -1));
  });
  else if (preset === "breakout") out = out.filter((r) => {
    const dh = m(r, "distHigh24hPct"), dl = m(r, "distLow24hPct");
    return (dh !== null && dh <= 0.5) || (dl !== null && dl <= 0.5);
  });
  else if (preset === "meanrevert") out = out.filter((r) => {
    const p24 = m(r, "pct24h"), p15 = m(r, "pct15m");
    return p24 !== null && p15 !== null && Math.abs(p24) >= 8 &&
      Math.abs(p15) >= 0.3 && (p15 > 0) !== (p24 > 0);
  });
  else if (preset === "highvolume") {
    const q = quantile("turnover24h", 0.9);
    out = q === null ? [] : out.filter((r) => { const t = m(r, "turnover24h"); return t !== null && t >= q; });
  } else if (preset === "largecaps") {
    const q = quantile(capsKey, 0.8);
    out = q === null ? [] : out.filter((r) => { const t = m(r, capsKey); return t !== null && t >= q; });
  } else if (preset === "smallcaps") {
    const q = quantile(capsKey, 0.5);
    out = q === null ? [] : out.filter((r) => { const t = m(r, capsKey); return t !== null && t <= q; });
  } else if (preset === "active") {
    out = out.filter((r) => { const p = m(r, "pct15m"); return p !== null && Math.abs(p) >= 0.3; });
  } else if (preset.indexOf("scan:") === 0) {
    const scan = (c.scans || []).find((s) => "scan:" + s.id === preset);
    if (scan) out = out.filter((r) => scScanMatches(scan, r));
  }

  // Numeric filters combine (AND) with whatever preset/scan is active. A row
  // missing a FILTERED metric is excluded — an unknown value can't pass a bound.
  const f = v.filters || {};
  const fnum = (x) => {
    if (x === null || x === undefined || x === "") return null;
    const n = Number(x);
    return isFinite(n) ? n : null;
  };
  [["priceMin", "last", (mv, fv) => mv >= fv],
   ["priceMax", "last", (mv, fv) => mv <= fv],
   ["pct24hAbsMin", "pct24h", (mv, fv) => Math.abs(mv) >= fv],
   ["turnoverMin", "turnover24h", (mv, fv) => mv >= fv],
   ["vol15mMin", "vol15mPct", (mv, fv) => mv >= fv],
   ["fundingAbsMin", "fundingPct", (mv, fv) => Math.abs(mv) >= fv],
  ].forEach(([fk, mk, test]) => {
    const fv = fnum(f[fk]);
    if (fv === null) return;
    out = out.filter((r) => { const mv = m(r, mk); return mv !== null && test(mv, fv); });
  });

  // Fuzzy search; matches also rank the results (prefix > substring > subsequence).
  const q = String(v.query || "").trim().toUpperCase();
  let scores = null;
  if (q) {
    scores = {};
    out = out.filter((r) => {
      const s = scFuzzyScore(r.symbol, q);
      if (s > 0) { scores[r.symbol] = s; return true; }
      return false;
    });
  }

  const sortKey = SC_SORTS.includes(v.sort) ? v.sort : "pct24h";
  const dir = v.dir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    if (scores) {
      const d = (scores[b.symbol] || 0) - (scores[a.symbol] || 0);
      if (d) return d;
    }
    if (v.pinFavs) {
      const d = (favSet.has(b.symbol) ? 1 : 0) - (favSet.has(a.symbol) ? 1 : 0);
      if (d) return d;
    }
    if (sortKey === "symbol") {
      const d = a.symbol.localeCompare(b.symbol) * dir;
      if (d) return d;
    } else {
      const av = m(a, sortKey), bv = m(b, sortKey);
      if (av === null && bv !== null) return 1;  // unknowns sink, either direction
      if (bv === null && av !== null) return -1;
      if (av !== null && bv !== null && av !== bv) return (av - bv) * dir;
    }
    return a.symbol.localeCompare(b.symbol);     // total order => stable resorts
  });
  return out;
}

// ---- overview-card ranking (pure) ----
// Returns {rows, metric} — `metric` tells the renderer which value the card
// features (volatility falls back to 24h range while the 15m window warms).
function scSectionRows(rows, id, ctx) {
  const c = ctx || {};
  const limit = c.limit || 6;
  const m = scMetric;
  const has = (r, k) => m(r, k) !== null;
  const desc = (k) => (a, b) => m(b, k) - m(a, k) || a.symbol.localeCompare(b.symbol);
  const absDesc = (k) => (a, b) => Math.abs(m(b, k)) - Math.abs(m(a, k)) || a.symbol.localeCompare(b.symbol);
  const list = (rows || []).filter(Boolean);
  switch (id) {
    case "movers":
      return { rows: list.filter((r) => has(r, "pct24h") && m(r, "pct24h") > 0).sort(desc("pct24h")).slice(0, limit), metric: "pct24h" };
    case "losers":
      return { rows: list.filter((r) => has(r, "pct24h") && m(r, "pct24h") < 0).sort((a, b) => m(a, "pct24h") - m(b, "pct24h") || a.symbol.localeCompare(b.symbol)).slice(0, limit), metric: "pct24h" };
    case "volume":
      return { rows: list.filter((r) => has(r, "turnover24h")).sort(desc("turnover24h")).slice(0, limit), metric: "turnover24h" };
    case "volatility": {
      const live = list.filter((r) => has(r, "vol15mPct"));
      if (live.length) return { rows: live.sort(desc("vol15mPct")).slice(0, limit), metric: "vol15mPct" };
      return { rows: list.filter((r) => has(r, "range24hPct")).sort(desc("range24hPct")).slice(0, limit), metric: "range24hPct" };
    }
    case "funding": {
      const f = list.filter((r) => has(r, "fundingPct"));
      const mode = c.fundingMode || "pos";
      if (mode === "neg") return { rows: f.sort((a, b) => m(a, "fundingPct") - m(b, "fundingPct") || a.symbol.localeCompare(b.symbol)).slice(0, limit), metric: "fundingPct" };
      if (mode === "delta") return { rows: f.filter((r) => has(r, "fundingDelta1hPct")).sort(absDesc("fundingDelta1hPct")).slice(0, limit), metric: "fundingDelta1hPct" };
      return { rows: f.sort(desc("fundingPct")).slice(0, limit), metric: "fundingPct" };
    }
    case "active":
      return { rows: list.filter((r) => has(r, "pct15m")).sort(absDesc("pct15m")).slice(0, limit), metric: "pct15m" };
    case "watchlist": {
      const set = new Set(c.watch || []);
      return { rows: list.filter((r) => set.has(r.symbol) && has(r, "pct24h")).sort(absDesc("pct24h")).slice(0, limit), metric: "pct24h" };
    }
    default:
      return { rows: [], metric: null };
  }
}

// ------------------------------ DOM manager -------------------------------

let _scData = null;            // last /api/scanner envelope
let _scIndex = {};             // symbol → row (rebuilt each poll)
let _scTimer = null;           // visible-tab poll
let _scBgTimer = null;         // slow background tick, only while alerts armed
let _scDoc = null;             // persisted doc (favs/scans/alerts/log)
let _scView = scSanitizeViewState(null); // per-workspace view (preset/sort/…)
let _scQuery = "";             // live search text (session-only by design)
let _scVisible = [];           // computed, ordered row list for the table
let _scSel = "";               // selected symbol (kept per workspace)
let _scPrevTop = null;         // previous top-movers board (null until 2nd poll)
let _scPrevPrice = {};         // symbol → last painted price (tick flash)
let _scRowEls = {};            // symbol → row element (keyed, in-place patched)
let _scRowH = 0;               // measured row height for virtualization
let _scFundingMode = "pos";    // funding card mode: pos | neg | delta
let _scPendingScroll = 0;      // scroll restored after the first data render
let _scStorageWarned = false;
let _scSaveTimer = null;
let _scLastSyncTs = 0;         // wall time of the last applied snapshot

function scPersist() {
  if (!_scDoc) return;
  try { localStorage.setItem(SC_STORE_KEY, JSON.stringify(_scDoc)); }
  catch (e) {
    if (!_scStorageWarned) { _scStorageWarned = true; toast("Could not persist scanner data (storage unavailable)", "warn"); }
  }
}
function scLoad() {
  let raw = null;
  try { raw = localStorage.getItem(SC_STORE_KEY); } catch (e) {}
  const { doc, corrupt } = scParseDoc(raw);
  _scDoc = doc;
  if (corrupt && raw !== null) {
    try { localStorage.setItem(SC_STORE_KEY + ".corrupt", raw); } catch (e) {}
    toast("Scanner data was unreadable — reset to defaults (old data kept under …corrupt)", "warn", 8000);
  }
  scPersist();
}
function scAutoSaveView() {
  clearTimeout(_scSaveTimer);
  _scSaveTimer = setTimeout(() => { wsAutoSave(); }, 300);
}

// Union of every watchlist's symbols (the scanner's "Watchlist" surfaces).
function scWatchSymbols() {
  if (!_wlDoc) return [];
  const seen = new Set();
  _wlDoc.lists.forEach((l) => l.symbols.forEach((s) => seen.add(s)));
  return Array.from(seen);
}

// ---- formatting ----
function scFmtPct(v, digits) {
  if (v === null || v === undefined || !isFinite(Number(v))) return "—";
  const n = Number(v);
  const d = digits === undefined ? 2 : digits;
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d) + "%";
}
function scFmtPrice(v) {
  if (v === null || v === undefined || !isFinite(Number(v))) return "—";
  return fmtMoney(v, wlPriceDp(v));
}
// Compact money (respects the INR display lens like every read-only surface).
function scFmtCompact(v, signed) {
  if (v === null || v === undefined || !isFinite(Number(v))) return "—";
  const n = cvtNum(v);
  if (!isFinite(n)) return "—";
  const sign = signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : (n < 0 ? "−" : "");
  const a = Math.abs(n);
  const body = a >= 1e9 ? (a / 1e9).toFixed(2) + "B"
    : a >= 1e6 ? (a / 1e6).toFixed(1) + "M"
    : a >= 1e3 ? (a / 1e3).toFixed(1) + "K"
    : a.toFixed(a >= 1 ? 1 : 4);
  return sign + body;
}
// Graded heat tint behind % cells — magnitude readable at a glance without
// hue-only encoding (the signed number stays the primary carrier).
function scHeatStyle(v, fullAt) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return "";
  const alpha = Math.min(0.26, (Math.abs(n) / (fullAt || 10)) * 0.26);
  return "background:" + (n > 0 ? "rgba(0,201,141," : "rgba(255,77,103,") + alpha.toFixed(3) + ")";
}
function scSparkSVG(series, cls) {
  if (!Array.isArray(series) || series.length < 2) return "";
  const w = 60, ht = 20, pad = 2;
  let min = Infinity, max = -Infinity;
  for (const v of series) { if (v < min) min = v; if (v > max) max = v; }
  const span = (max - min) || 1;
  const dx = (w - pad * 2) / (series.length - 1);
  const pts = series.map((v, i) =>
    `${(pad + i * dx).toFixed(1)},${(ht - pad - ((v - min) / span) * (ht - pad * 2)).toFixed(1)}`).join(" ");
  const up = series[series.length - 1] >= series[0];
  const col = up ? "var(--pos)" : "var(--neg)";
  return `<svg class="${cls || "wl-spark"}" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${pts}" style="fill:none;stroke:${col};stroke-width:1.4;vector-effect:non-scaling-stroke"/></svg>`;
}

// ---- data poll ----
async function fetchScanner() {
  let data;
  try {
    data = await api("/api/scanner");
  } catch (e) {
    // First-load failure: show a real error state (the empty-state element sits
    // in normal flow; the virtualized rows container does not). With data
    // already on screen, keep the last snapshot and let the status line warn.
    const emptyEl = document.getElementById("sc-empty");
    if (emptyEl && !_scData) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = errorMsg(e.message);
      const rowsEl = document.getElementById("sc-rows");
      if (rowsEl) rowsEl.replaceChildren();
    }
    scRenderStatus();
    return;
  }
  _scData = data;
  _scLastSyncTs = Date.now();
  const idx = {};
  (data.rows || []).forEach((r) => { if (r && SC_SYMBOL_RE.test(String(r.symbol))) idx[r.symbol] = r; });
  _scIndex = idx;
  scRunAlerts();
  scSyncAll();
}

function scPaneVisible() {
  const pane = document.querySelector('[data-pane="scanner"]');
  return !!pane && !pane.hidden;
}

function onScannerActive() {
  if (!_scData) { scRenderLoading(); fetchScanner(); }
  else scSyncAll();
  clearInterval(_scTimer);
  // Same visible-tab cadence + self-cancel discipline as the Watch tab poll;
  // the endpoint is served from backend memory, so this costs the exchange
  // nothing regardless of how many viewers poll it.
  const id = setInterval(() => {
    if (!scPaneVisible()) { clearInterval(id); return; }
    if (!document.hidden) fetchScanner();
  }, 10000);
  _scTimer = id;
}

// Slow background tick ONLY while alerts are armed, so alerts keep working
// from any tab. Skipped when the scanner pane's own poll is running or the
// browser tab is hidden.
function scEnsureAlertTimer() {
  clearInterval(_scBgTimer);
  _scBgTimer = null;
  if (!_scDoc || !_scDoc.alerts.length) return;
  _scBgTimer = setInterval(() => {
    if (document.hidden || scPaneVisible()) return;
    fetchScanner();
  }, 45000);
}

// ---- alerts runtime ----
function scRunAlerts() {
  if (!_scData) return;
  // Depth 25 = the deepest rank an alert may watch (sanitizer clamps to ≤25);
  // each alert compares boards truncated to its own rank.
  const topNow = scTopMovers(Object.values(_scIndex), 25);
  if (_scDoc && _scDoc.alerts.length) {
    const fired = scEvalAlerts(_scDoc.alerts, {
      index: _scIndex, topMovers: topNow, prevTopMovers: _scPrevTop,
    }, Date.now());
    if (fired.length) {
      const now = Date.now();
      fired.forEach((f) => {
        f.alert.lastFired[f.symbol] = now;
        _scDoc.log.unshift({ ts: now, msg: f.message, symbol: f.symbol });
        toast("Scanner · " + f.message, "warn", 8000);
      });
      if (_scDoc.log.length > SC_MAX_LOG) _scDoc.log.length = SC_MAX_LOG;
      scPersist();
    }
  }
  _scPrevTop = topNow;
}

// ---- status line ----
function scRenderStatus() {
  const el = document.getElementById("sc-status");
  if (!el) return;
  if (!_scData) { el.textContent = "connecting…"; el.classList.remove("sc-stale"); return; }
  const d = _scData;
  if (d.enabled === false) { el.textContent = "scanner disabled on the server"; return; }
  const parts = [];
  parts.push(d.universe + " markets");
  if (d.asOfMs && d.nowMs) {
    const age = Math.max(0, Math.round((d.nowMs - d.asOfMs) / 1000)) + Math.max(0, Math.round((Date.now() - _scLastSyncTs) / 1000));
    parts.push("updated " + fmtAge(age) + " ago");
    const stale = (d.nowMs - d.asOfMs) > Math.max(30000, (d.intervalMs || 10000) * 3);
    el.classList.toggle("sc-stale", stale);
    if (stale) parts.push("⚠ stale");
  }
  const hist = Number(d.historyMs) || 0;
  const warm = [];
  if (hist < 15 * 60000 * 0.85) warm.push("15m");
  if (hist < 60 * 60000 * 0.85 && !(d.capabilities && d.capabilities.pct1h)) warm.push("1h");
  if (warm.length) parts.push(warm.join("/") + " metrics warming (" + Math.round(hist / 60000) + "m)");
  if (d.error) parts.push("⚠ " + d.error);
  el.textContent = parts.join(" · ");
}

// ---- presets strip ----
const SC_PRESET_DEFS = [
  { id: "all", label: "All" },
  { id: "favorites", label: "★ Favorites" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "momentum", label: "Momentum", title: "15m and 1h moving the same way (±0.5% / ±1%)" },
  { id: "breakout", label: "Breakouts", title: "Within 0.5% of the 24h high or low" },
  { id: "meanrevert", label: "Mean-revert", title: "|24h| ≥ 8% with the last 15m pulling the other way" },
  { id: "highvolume", label: "High volume", title: "Top 10% by 24h turnover" },
  { id: "largecaps", label: "Large caps", title: "Top 20% by open-interest value (turnover when OI is unavailable)" },
  { id: "smallcaps", label: "Small caps", title: "Bottom half by open-interest value (turnover when OI is unavailable)" },
  { id: "active", label: "Active now", title: "|15m move| ≥ 0.3%" },
  { id: "watchlist", label: "Watchlist", title: "Symbols from all your watchlists" },
];
function scRenderPresets() {
  const el = document.getElementById("sc-presets");
  if (!el || !_scDoc) return;
  const chips = SC_PRESET_DEFS.map((p) => {
    const on = _scView.preset === p.id;
    return `<button type="button" class="sc-chip${on ? " active" : ""}" role="tab" aria-selected="${on}"` +
      ` data-preset="${p.id}"${p.title ? ` title="${esc(p.title)}"` : ""}>${esc(p.label)}</button>`;
  });
  _scDoc.scans.forEach((s) => {
    const pid = "scan:" + s.id;
    const on = _scView.preset === pid;
    chips.push(`<button type="button" class="sc-chip sc-chip-scan${on ? " active" : ""}" role="tab" aria-selected="${on}"` +
      ` data-preset="${esc(pid)}" title="Custom scan · ${s.mode.toUpperCase()} of ${s.rules.length} condition${s.rules.length === 1 ? "" : "s"} · click again to edit">` +
      `<span class="sc-chip-name">${esc(s.name)}</span><span class="sc-chip-edit" aria-hidden="true">✎</span></button>`);
  });
  el.innerHTML = chips.join("");
}
function scSetPreset(id) {
  if (_scView.preset === id) return;
  _scView.preset = id;
  scRenderPresets();
  scSyncTable();
  scAutoSaveView();
}

// ---- screener table (virtualized) ----
const SC_COLUMNS = [
  { key: "fav", cls: "sc-c-fav", label: "" },
  { key: "symbol", cls: "sc-c-sym", label: "Symbol", sortable: true },
  { key: "spark", cls: "sc-c-spark", label: "Trend", title: "Sampled trend over the rolling history (≤1h)" },
  { key: "last", cls: "sc-c-num", label: "Last", sortable: true },
  { key: "pct5m", cls: "sc-c-num sc-opt2", label: "5m %", sortable: true },
  { key: "pct15m", cls: "sc-c-num", label: "15m %", sortable: true },
  { key: "pct1h", cls: "sc-c-num sc-opt", label: "1h %", sortable: true },
  { key: "pct24h", cls: "sc-c-num", label: "24h %", sortable: true },
  { key: "range24hPct", cls: "sc-c-num sc-opt", label: "Range", sortable: true, title: "24h high−low as % of price" },
  { key: "vol15mPct", cls: "sc-c-num sc-opt2", label: "Vol 15m", sortable: true, title: "Realized 15-minute range %" },
  { key: "turnover24h", cls: "sc-c-num", label: "Volume", sortable: true, title: "24h turnover" },
  { key: "turnoverDelta15m", cls: "sc-c-num sc-opt", label: "ΔVol 15m", sortable: true, title: "Change of the rolling 24h turnover over the last 15m" },
  { key: "fundingPct", cls: "sc-c-num sc-opt", label: "Funding", sortable: true, title: "Current funding rate (Δ1h below when available)" },
  { key: "openInterestValue", cls: "sc-c-num sc-opt2", label: "OI", sortable: true, title: "Open-interest value" },
  { key: "act", cls: "sc-c-act", label: "" },
];
function scRenderHead() {
  const el = document.getElementById("sc-head");
  if (!el) return;
  el.innerHTML = SC_COLUMNS.map((c) => {
    if (!c.sortable) return `<span class="${c.cls}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.label)}</span>`;
    const on = _scView.sort === c.key;
    const arrow = on ? (_scView.dir === "asc" ? " ▴" : " ▾") : "";
    return `<button type="button" class="sc-th ${c.cls}${on ? " on" : ""}" data-sort="${c.key}"` +
      ` aria-sort="${on ? (_scView.dir === "asc" ? "ascending" : "descending") : "none"}"` +
      `${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.label)}${arrow}</button>`;
  }).join("");
}
function scBuildRow(sym) {
  const row = document.createElement("div");
  row.className = "sc-row";
  row.id = "sc-row-" + sym;
  row.dataset.sym = sym;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  row.innerHTML = SC_COLUMNS.map((c) => {
    if (c.key === "fav") return `<button class="sc-fav" type="button" tabindex="-1" aria-label="Toggle scanner favorite ${esc(sym)}" title="Favorite">★</button>`;
    if (c.key === "symbol") return `<span class="sc-c-sym mono">${esc(sym)}</span>`;
    if (c.key === "spark") return `<span class="sc-c-spark sc-spark-cell"></span>`;
    if (c.key === "act") return `<button class="sc-more" type="button" tabindex="-1" aria-label="Actions for ${esc(sym)}" title="Actions (right-click or Menu key)">⋯</button>`;
    return `<span class="${c.cls} sc-cell" data-k="${c.key}"></span>`;
  }).join("");
  return row;
}
// Patch ONLY changed cells (each row caches what it last painted) so a poll
// touches a handful of text nodes, not the DOM tree.
function scPatchRow(row, r) {
  const sym = r.symbol;
  const cache = row._v || (row._v = {});
  const isFav = _scDoc && _scDoc.favs.includes(sym);
  row.classList.toggle("is-fav", !!isFav);
  const favBtn = row.querySelector(".sc-fav");
  if (favBtn) favBtn.classList.toggle("on", !!isFav);
  const selected = _scSel === sym;
  row.classList.toggle("sel", selected);
  row.setAttribute("aria-selected", String(selected));

  const last = scMetric(r, "last");
  const prev = _scPrevPrice[sym];
  if (last !== null && isFinite(prev) && last !== prev) {
    const cls = last > prev ? "tick-up" : "tick-down";
    row.classList.remove("tick-up", "tick-down");
    void row.offsetWidth;
    row.classList.add(cls);
  }

  const set = (key, text, cls, style) => {
    const sig = text + "|" + (cls || "") + "|" + (style || "");
    if (cache[key] === sig) return;
    cache[key] = sig;
    const el = row.querySelector(`[data-k="${key}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = el.className.replace(/\s*(pos|neg|flat|sc-hot)\b/g, "") + (cls ? " " + cls : "");
    el.style.cssText = style || "";
  };
  set("last", scFmtPrice(last));
  [["pct5m", 8], ["pct15m", 8], ["pct1h", 8], ["pct24h", 12]].forEach(([k, fullAt]) => {
    const v = scMetric(r, k);
    set(k, scFmtPct(v), pnlClass(v), scHeatStyle(v, fullAt));
  });
  const range = scMetric(r, "range24hPct");
  set("range24hPct", range === null ? "—" : range.toFixed(2) + "%");
  const v15 = scMetric(r, "vol15mPct");
  set("vol15mPct", v15 === null ? "—" : v15.toFixed(2) + "%", v15 !== null && v15 >= 1.5 ? "sc-hot" : "");
  set("turnover24h", scFmtCompact(scMetric(r, "turnover24h")));
  const dv = scMetric(r, "turnoverDelta15m");
  set("turnoverDelta15m", dv === null ? "—" : scFmtCompact(dv, true), pnlClass(dv));
  const fp = scMetric(r, "fundingPct");
  set("fundingPct", fp === null ? "—" : scFmtPct(fp, 4), fp === null ? "" : (fp > 0 ? "pos" : fp < 0 ? "neg" : "flat"));
  set("openInterestValue", scFmtCompact(scMetric(r, "openInterestValue")));

  const sparkSig = Array.isArray(r.spark) ? r.spark.length + ":" + r.spark[0] + ":" + r.spark[r.spark.length - 1] : "";
  if (cache.spark !== sparkSig) {
    cache.spark = sparkSig;
    const cell = row.querySelector(".sc-spark-cell");
    if (cell) cell.innerHTML = scSparkSVG(r.spark);
  }
  if (last !== null) _scPrevPrice[sym] = last;
}

function scRowH() {
  if (_scRowH) return _scRowH;
  const probe = document.querySelector("#sc-rows .sc-row");
  if (probe && probe.offsetHeight) _scRowH = probe.offsetHeight;
  return _scRowH || 34;
}

// Windowed render: only the rows near the viewport exist in the DOM, so the
// table stays smooth with the entire universe loaded (§performance).
function scRenderTable() {
  const vp = document.getElementById("sc-viewport");
  const spacer = document.getElementById("sc-spacer");
  const rowsEl = document.getElementById("sc-rows");
  const emptyEl = document.getElementById("sc-empty");
  if (!vp || !spacer || !rowsEl || !emptyEl) return;

  const total = _scVisible.length;
  if (!total) {
    rowsEl.replaceChildren();
    spacer.style.height = "0px";
    if (_scData) {
      emptyEl.hidden = false;
      const hasQuery = !!_scQuery.trim();
      const filtered = _scView.preset !== "all" || scActiveFilterCount() > 0 || hasQuery;
      emptyEl.innerHTML =
        `<div class="wl-empty-glyph" aria-hidden="true">◎</div>` +
        `<p class="wl-empty-title">${_scData.rows && _scData.rows.length ? "No markets match" : "Waiting for market data…"}</p>` +
        `<p class="wl-empty-hint">${filtered ? "Loosen the preset, filters or search to see more." : "The scanner feed will populate this table shortly."}</p>` +
        (filtered ? `<div class="wl-empty-actions"><button class="btn-ghost sm" data-scempty="reset">Show all markets</button></div>` : "");
    }
    return;
  }
  emptyEl.hidden = true;

  const rowH = scRowH();
  spacer.style.height = (total * rowH) + "px";
  const buffer = 8;
  const first = Math.max(0, Math.floor(vp.scrollTop / rowH) - buffer);
  const count = Math.ceil(vp.clientHeight / rowH) + buffer * 2;
  const slice = _scVisible.slice(first, first + count);
  rowsEl.style.transform = `translateY(${first * rowH}px)`;

  const frag = document.createDocumentFragment();
  slice.forEach((r) => {
    let row = _scRowEls[r.symbol];
    if (!row) { row = _scRowEls[r.symbol] = scBuildRow(r.symbol); }
    frag.appendChild(row);
  });
  rowsEl.replaceChildren(frag);
  slice.forEach((r) => scPatchRow(_scRowEls[r.symbol], r));

  // Bound the element pool to the current universe.
  if (Object.keys(_scRowEls).length > (_scData ? (_scData.rows || []).length : 0) + 50) {
    const live = new Set(Object.keys(_scIndex));
    Object.keys(_scRowEls).forEach((s) => { if (!live.has(s)) delete _scRowEls[s]; });
  }
}

function scActiveFilterCount() {
  const f = _scView.filters || {};
  return ["priceMin", "priceMax", "pct24hAbsMin", "turnoverMin", "vol15mMin", "fundingAbsMin"]
    .filter((k) => f[k] !== null && f[k] !== undefined).length;
}
function scRenderFilterBadge() {
  const n = scActiveFilterCount();
  const badge = document.getElementById("sc-filter-count");
  const btn = document.getElementById("sc-filter-btn");
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  if (btn) btn.classList.toggle("on", n > 0);
}

function scRenderLoading() {
  const rowsEl = document.getElementById("sc-rows");
  if (!rowsEl || _scData) return;
  rowsEl.innerHTML = new Array(12).fill('<div class="sc-row sc-row-skel"><span class="skel"></span></div>').join("");
  // The rows layer is absolutely positioned; give the spacer real height so
  // the skeletons are visible before the first snapshot sizes it.
  const spacer = document.getElementById("sc-spacer");
  if (spacer) spacer.style.height = (12 * 36) + "px";
  const cardsEl = document.getElementById("sc-sections");
  if (cardsEl && !cardsEl.children.length) {
    cardsEl.innerHTML = new Array(4).fill('<section class="sc-card sc-card-skel"><span class="skel"></span><span class="skel"></span><span class="skel"></span></section>').join("");
  }
}

// Recompute the table view from the latest snapshot + view state.
function scSyncTable() {
  if (!_scData) return;
  _scRowH = 0; // re-measure once per sync (density toggles change row height)
  _scVisible = scComputeView(_scData.rows || [], {
    preset: _scView.preset, query: _scQuery, sort: _scView.sort, dir: _scView.dir,
    pinFavs: _scView.pinFavs, filters: _scView.filters,
  }, { favs: _scDoc ? _scDoc.favs : [], watch: scWatchSymbols(), scans: _scDoc ? _scDoc.scans : [] });
  scRenderHead();
  scRenderTable();
  scRenderFilterBadge();
}

// ---- overview cards ----
const SC_SECTION_DEFS = {
  movers: { title: "Top Movers", meta: "24h gainers" },
  losers: { title: "Top Losers", meta: "24h decliners" },
  volume: { title: "Highest Volume", meta: "24h turnover" },
  volatility: { title: "Volatility", meta: "biggest ranges" },
  funding: { title: "Funding", meta: "perp funding rates" },
  active: { title: "Recently Active", meta: "largest 15m moves" },
  watchlist: { title: "Watchlist Movers", meta: "across your lists" },
  alerts: { title: "Recent Alerts", meta: "scanner alerts" },
};
function scBuildCard(id) {
  const def = SC_SECTION_DEFS[id];
  const card = document.createElement("section");
  card.className = "sc-card";
  card.dataset.scsec = id;
  const fundingSeg = id === "funding"
    ? `<div class="segment sc-fmode" role="group" aria-label="Funding view">` +
      `<button type="button" data-fmode="pos" class="seg-neutral active" title="Highest funding" aria-label="Highest positive funding" aria-pressed="true">+</button>` +
      `<button type="button" data-fmode="neg" class="seg-neutral" title="Lowest funding" aria-label="Most negative funding" aria-pressed="false">−</button>` +
      `<button type="button" data-fmode="delta" class="seg-neutral" title="Biggest 1h change" aria-label="Biggest funding change in the last hour" aria-pressed="false">Δ1h</button></div>`
    : "";
  card.innerHTML =
    `<div class="sc-card-head">` +
      `<button class="sc-card-drag" type="button" title="Drag to rearrange · arrow keys move" aria-label="Move ${esc(def.title)} card">⠿</button>` +
      `<h3>${esc(def.title)}</h3>` +
      `<span class="sc-card-meta muted">${esc(def.meta)}</span>` +
      fundingSeg +
      `<button class="sc-card-collapse" type="button" aria-expanded="true" title="Collapse">▾</button>` +
    `</div>` +
    `<div class="sc-card-body"></div>`;
  return card;
}
function scCardEmpty(text) {
  return `<p class="sc-card-empty muted">${esc(text)}</p>`;
}
function scPatchCard(card, id) {
  const body = card.querySelector(".sc-card-body");
  if (!body) return;
  const collapsed = !!_scView.sections.collapsed[id];
  card.classList.toggle("collapsed", collapsed);
  const colBtn = card.querySelector(".sc-card-collapse");
  if (colBtn) { colBtn.setAttribute("aria-expanded", String(!collapsed)); colBtn.textContent = collapsed ? "▸" : "▾"; }
  if (collapsed) return;

  if (id === "alerts") {
    const log = _scDoc ? _scDoc.log.slice(0, 6) : [];
    const armed = _scDoc ? _scDoc.alerts.length : 0;
    const metaEl = card.querySelector(".sc-card-meta");
    if (metaEl) metaEl.textContent = armed ? armed + " armed" : "scanner alerts";
    const sig = log.map((l) => l.ts + l.msg).join("|") + "#" + armed;
    if (body.dataset.sig === sig) return;
    body.dataset.sig = sig;
    body.innerHTML = (log.length
      ? log.map((l) =>
          `<div class="sc-alert-row" ${l.symbol ? `data-sym="${esc(l.symbol)}" role="button" tabindex="0"` : ""}>` +
          `<span class="sc-alert-msg">${esc(l.msg)}</span>` +
          `<span class="sc-alert-t muted">${new Date(l.ts).toLocaleTimeString()}</span></div>`).join("")
      : scCardEmpty("No alerts fired yet.")) +
      `<button class="btn-ghost sm sc-card-btn" data-scact="newalert" type="button">＋ New alert</button>`;
    return;
  }

  if (id === "funding" && _scData && _scData.capabilities && !_scData.capabilities.funding) {
    // The venue doesn't supply funding: keep the card (the metric slots in
    // later without layout changes) but say why it is empty. Never fake rates.
    if (body.dataset.sig !== "nofunding") {
      body.dataset.sig = "nofunding";
      body.innerHTML = scCardEmpty("Funding rates are not provided by this exchange feed.");
    }
    return;
  }

  const res = scSectionRows(_scData ? _scData.rows || [] : [], id,
    { limit: 6, fundingMode: _scFundingMode, watch: scWatchSymbols() });
  if (!res.rows.length) {
    const msg = id === "active" ? "Warming up — 15m activity appears a few minutes after the feed starts."
      : id === "watchlist" ? "No watchlist symbols in the current universe."
      : "Nothing to rank yet.";
    if (body.dataset.sig !== "empty:" + id) { body.dataset.sig = "empty:" + id; body.innerHTML = scCardEmpty(msg); }
    return;
  }
  const syms = res.rows.map((r) => r.symbol).join(",");
  if (body.dataset.sig !== syms) {
    body.dataset.sig = syms;
    body.innerHTML = res.rows.map((r, i) =>
      `<div class="sc-mini" data-sym="${esc(r.symbol)}" role="button" tabindex="0" title="Click to select · Enter to open chart & book">` +
      `<span class="sc-mini-rank muted">${i + 1}</span>` +
      `<span class="sc-mini-sym mono">${esc(r.symbol)}</span>` +
      `<span class="sc-mini-spark"></span>` +
      `<span class="sc-mini-price mono"></span>` +
      `<span class="sc-mini-val mono"></span></div>`).join("");
  }
  res.rows.forEach((r) => {
    const rowEl = body.querySelector(`.sc-mini[data-sym="${CSS.escape(r.symbol)}"]`);
    if (!rowEl) return;
    rowEl.classList.toggle("sel", _scSel === r.symbol);
    const priceEl = rowEl.querySelector(".sc-mini-price");
    if (priceEl) priceEl.textContent = scFmtPrice(scMetric(r, "last"));
    const valEl = rowEl.querySelector(".sc-mini-val");
    if (valEl) {
      const v = scMetric(r, res.metric);
      let text, cls = "";
      if (res.metric === "turnover24h") text = scFmtCompact(v);
      else if (res.metric === "fundingPct" || res.metric === "fundingDelta1hPct") { text = scFmtPct(v, 4); cls = pnlClass(v); }
      else { text = scFmtPct(v); cls = pnlClass(v); }
      valEl.textContent = text;
      valEl.className = "sc-mini-val mono " + cls;
    }
    const sparkEl = rowEl.querySelector(".sc-mini-spark");
    if (sparkEl) {
      const sig = Array.isArray(r.spark) ? r.spark.length + ":" + r.spark[r.spark.length - 1] : "";
      if (sparkEl.dataset.sig !== sig) { sparkEl.dataset.sig = sig; sparkEl.innerHTML = scSparkSVG(r.spark); }
    }
  });
  // Volatility card: surface which metric is being ranked while 15m warms.
  if (id === "volatility") {
    const metaEl = card.querySelector(".sc-card-meta");
    if (metaEl) metaEl.textContent = res.metric === "vol15mPct" ? "15m realized range" : "24h range (15m warming)";
  }
}
function scRenderSections() {
  const wrap = document.getElementById("sc-sections");
  if (!wrap) return;
  wrap.hidden = !_scView.cards;
  const tgl = document.getElementById("sc-cards-toggle");
  if (tgl) tgl.setAttribute("aria-pressed", String(_scView.cards));
  if (!_scView.cards) return;
  // Create/reorder card elements to match the workspace's saved order.
  const want = _scView.sections.order;
  const have = {};
  Array.from(wrap.querySelectorAll(":scope > .sc-card[data-scsec]")).forEach((el) => { have[el.dataset.scsec] = el; });
  if (want.some((sid) => !have[sid]) || Object.keys(have).length !== want.length) {
    wrap.replaceChildren();
    want.forEach((sid) => { wrap.appendChild(have[sid] || scBuildCard(sid)); });
  } else {
    want.forEach((sid) => wrap.appendChild(have[sid]));
  }
  want.forEach((sid) => {
    const card = wrap.querySelector(`:scope > .sc-card[data-scsec="${sid}"]`);
    if (card) scPatchCard(card, sid);
  });
}

function scSyncAll() {
  if (!scPaneVisible()) { scRenderStatus(); return; }
  scRenderStatus();
  scRenderPresets();
  scSyncTable();
  scRenderSections();
  if (_scPendingScroll) {
    const vp = document.getElementById("sc-viewport");
    if (vp && _scVisible.length) { vp.scrollTop = _scPendingScroll; _scPendingScroll = 0; scRenderTable(); }
  }
}
// Currency-lens re-render hook (mirrors renderMarkets for the Watch tab).
function scRerender() {
  Object.values(_scRowEls).forEach((row) => { row._v = {}; });
  const wrap = document.getElementById("sc-sections");
  if (wrap) wrap.querySelectorAll(".sc-card-body").forEach((b) => { b.dataset.sig = ""; });
  scSyncAll();
}

// ---- workspace integration (view state captured/applied per workspace) ----
function scCaptureViewState() {
  const vp = document.getElementById("sc-viewport");
  return {
    preset: _scView.preset, sort: _scView.sort, dir: _scView.dir,
    pinFavs: _scView.pinFavs, cards: _scView.cards, filters: _scView.filters,
    sections: _scView.sections, sel: _scSel,
    scroll: vp ? Math.round(vp.scrollTop) : _scView.scroll,
  };
}
function scApplyViewState(raw) {
  const st = scSanitizeViewState(raw);
  _scView = st;
  _scSel = st.sel || "";
  _scPendingScroll = st.scroll || 0;
  // Reflect toolbar controls.
  const pin = document.getElementById("sc-pin-favs");
  if (pin) { pin.setAttribute("aria-pressed", String(st.pinFavs)); pin.classList.toggle("on", st.pinFavs); }
  document.querySelectorAll("#sc-filter-pop [data-scfilter]").forEach((inp) => {
    const v = st.filters[inp.dataset.scfilter];
    inp.value = v === null || v === undefined ? "" : String(v);
  });
  if (_scData) scSyncAll(); else scRenderPresets();
}

// ---- selection / navigation ----
function scSelect(sym, opts) {
  _scSel = sym || "";
  const o = opts || {};
  if (_scSel && !o.silent) scAutoSaveView();
  // Patch selection classes in place (cheap; no recompute).
  Object.keys(_scRowEls).forEach((s) => {
    _scRowEls[s].classList.toggle("sel", s === _scSel);
    _scRowEls[s].setAttribute("aria-selected", String(s === _scSel));
  });
  const wrap = document.getElementById("sc-sections");
  if (wrap) wrap.querySelectorAll(".sc-mini").forEach((el) => el.classList.toggle("sel", el.dataset.sym === _scSel));
  const vp = document.getElementById("sc-viewport");
  if (vp && _scSel) vp.setAttribute("aria-activedescendant", "sc-row-" + _scSel);
}
function scScrollToSelected() {
  const vp = document.getElementById("sc-viewport");
  if (!vp || !_scSel) return;
  const idx = _scVisible.findIndex((r) => r.symbol === _scSel);
  if (idx < 0) return;
  const rowH = scRowH();
  const top = idx * rowH;
  if (top < vp.scrollTop) vp.scrollTop = top;
  else if (top + rowH > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + rowH - vp.clientHeight;
  scRenderTable();
}
function scMoveSelection(delta, absolute) {
  if (!_scVisible.length) return;
  let idx = _scVisible.findIndex((r) => r.symbol === _scSel);
  if (absolute === "home") idx = 0;
  else if (absolute === "end") idx = _scVisible.length - 1;
  else idx = idx < 0 ? (delta > 0 ? 0 : _scVisible.length - 1) : Math.max(0, Math.min(_scVisible.length - 1, idx + delta));
  scSelect(_scVisible[idx].symbol);
  scScrollToSelected();
}
function scPageSize() {
  const vp = document.getElementById("sc-viewport");
  return vp ? Math.max(1, Math.floor(vp.clientHeight / scRowH()) - 1) : 20;
}

// ---- context menu (navigation/display/list edits only — never a trade) ----
function scCloseCtx() {
  const menu = document.getElementById("sc-ctx");
  if (menu) { menu.hidden = true; menu.innerHTML = ""; }
}
function scOpenCtx(sym, x, y) {
  const menu = document.getElementById("sc-ctx");
  if (!menu || !_scDoc) return;
  const isAdmin = state.role === "admin" && !!document.getElementById("order-form");
  const isFav = _scDoc.favs.includes(sym);
  const lists = _wlDoc ? _wlDoc.lists.slice(0, 6) : [];
  const item = (act, label, extra) => `<button class="wl-ctx-item" role="menuitem" tabindex="-1" data-act="${act}"${extra || ""}>${label}</button>`;
  menu.innerHTML =
    `<div class="wl-ctx-head mono">${esc(sym)}</div>` +
    (isAdmin ? item("trade", "Trade this symbol") : "") +
    item("chart", "Open chart &amp; book") +
    item("fav", isFav ? "★ Remove scanner favorite" : "☆ Add scanner favorite") +
    item("alert", "Scanner alert…") +
    item("copy", "Copy symbol") +
    item("journal", "Open journal") +
    (lists.length ? `<div class="wl-ctx-sep"></div><div class="wl-ctx-label">Add to watchlist</div>` +
      lists.map((l) => item("watch", `→ ${esc(l.name)}`, ` data-listid="${esc(l.id)}"`)).join("") : "");
  menu.dataset.sym = sym;
  menu.hidden = false;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, vw - rect.width - 8) + "px";
  menu.style.top = Math.min(y, vh - rect.height - 8) + "px";
  const first = menu.querySelector(".wl-ctx-item");
  if (first) first.focus();
}
function scCtxAction(act, sym, el) {
  switch (act) {
    case "trade": wlOpenSymbol(sym, { trade: true }); break;
    case "chart": wlOpenSymbol(sym, { trade: false }); break;
    case "fav": scToggleFav(sym); break;
    case "alert": scOpenAlert(sym); break;
    case "copy":
      try { navigator.clipboard.writeText(sym); toast(`Copied ${sym}`, "info", 1500); }
      catch (e) { toast("Clipboard unavailable", "warn"); }
      break;
    case "journal": {
      const t = document.querySelector('#tabs .tab[data-tab="history"]');
      const search = document.getElementById("jn-search");
      if (search) { search.value = sym; search.dispatchEvent(new Event("input", { bubbles: true })); }
      if (t) t.click();
      if (typeof jnSwitchView === "function") jnSwitchView("trades");
      break;
    }
    case "watch": {
      const listId = el && el.dataset.listid;
      if (listId && _wlDoc && wlAddSymbol(_wlDoc, listId, sym)) {
        wlPersist();
        const l = wlFindList(_wlDoc, listId);
        toast(`Added ${sym} to “${l ? l.name : "watchlist"}”`, "pos", 2000);
      } else toast(`${sym} is already there (or the list is full)`, "info", 2000);
      break;
    }
  }
}
function scToggleFav(sym) {
  if (!_scDoc || !SC_SYMBOL_RE.test(sym)) return;
  if (_scDoc.favs.includes(sym)) _scDoc.favs = _scDoc.favs.filter((s) => s !== sym);
  else if (_scDoc.favs.length < SC_MAX_FAVS) _scDoc.favs.push(sym);
  scPersist();
  scSyncTable();
  scRenderSections();
}

// ---- scanner alert composer ----
let _scAlertSym = null; // symbol context, or null = universe-wide
function scRenderAlertExisting() {
  const box = document.getElementById("sc-alert-existing");
  if (!box || !_scDoc) return;
  const rel = _scDoc.alerts.filter((a) => !_scAlertSym || a.symbol === _scAlertSym || a.symbol === "*");
  box.innerHTML = rel.length
    ? `<div class="ae-title">Active alerts</div>` + rel.map((a) =>
        `<div class="ae-row"><span>${esc(scAlertLabel(a))}</span>` +
        `<button class="btn-ghost sm" data-alid="${esc(a.id)}" title="Delete alert" aria-label="Delete alert">✕</button></div>`).join("")
    : `<div class="ae-empty muted">No scanner alerts yet. Alerts notify only — they never place or modify an order.</div>`;
}
function scAlertSyncInputs() {
  const kind = document.getElementById("sc-alert-kind").value;
  const valWrap = document.getElementById("sc-alert-value-wrap");
  const valInput = document.getElementById("sc-alert-value");
  const anyWrap = document.getElementById("sc-alert-any-wrap");
  const anyCheck = document.getElementById("sc-alert-any");
  if (valWrap) {
    valWrap.hidden = kind === "vol_double";
    const label = valWrap.firstChild;
    if (label && label.nodeType === 3) {
      label.textContent = kind === "top_mover" ? "Top-N rank (3–25) " : "Threshold (%) ";
    }
    if (valInput) valInput.placeholder = kind === "top_mover" ? "10" : kind === "funding_abs" ? "0.05" : "2";
  }
  if (anyWrap && anyCheck) {
    const forced = !_scAlertSym;            // opened without a symbol => universe-wide
    const disallowed = kind === "vol_double"; // needs a concrete baseline symbol
    anyWrap.hidden = disallowed;
    anyCheck.disabled = forced || disallowed;
    if (forced) anyCheck.checked = true;
    if (disallowed) anyCheck.checked = false;
  }
}
function scOpenAlert(sym) {
  const overlay = document.getElementById("sc-alert-overlay");
  if (!overlay || !_scDoc) return;
  _scAlertSym = sym && SC_SYMBOL_RE.test(sym) ? sym : null;
  const ctxEl = document.getElementById("sc-alert-context");
  if (ctxEl) {
    if (_scAlertSym) {
      const r = _scIndex[_scAlertSym];
      ctxEl.textContent = _scAlertSym + (r ? " · last " + scFmtPrice(scMetric(r, "last")) + " · 24h " + scFmtPct(scMetric(r, "pct24h")) : "");
    } else ctxEl.textContent = "Universe-wide alert — watches every market in the scanner.";
  }
  const kindSel = document.getElementById("sc-alert-kind");
  const dbl = kindSel ? kindSel.querySelector('option[value="vol_double"]') : null;
  if (dbl) dbl.disabled = !_scAlertSym;
  if (kindSel && !_scAlertSym && kindSel.value === "vol_double") kindSel.value = "top_mover";
  const res = document.getElementById("sc-alert-result");
  if (res) { res.textContent = ""; res.className = "result-msg"; }
  scAlertSyncInputs();
  scRenderAlertExisting();
  overlay.hidden = false;
  const kindEl = document.getElementById("sc-alert-kind");
  if (kindEl) kindEl.focus();
}
function scAddAlertFromModal() {
  if (!_scDoc) return;
  const res = document.getElementById("sc-alert-result");
  const say = (msg, ok) => { if (res) { res.textContent = msg; res.className = "result-msg " + (ok ? "ok" : "err"); } };
  if (_scDoc.alerts.length >= SC_MAX_ALERTS) { say(`Alert limit reached (${SC_MAX_ALERTS})`, false); return; }
  const kind = document.getElementById("sc-alert-kind").value;
  const anyCheck = document.getElementById("sc-alert-any");
  const useAny = !_scAlertSym || (anyCheck && anyCheck.checked && kind !== "vol_double");
  const symbol = useAny ? "*" : _scAlertSym;
  const raw = { kind, symbol, value: (document.getElementById("sc-alert-value") || {}).value };
  if (kind === "vol_double") {
    const r = _scIndex[_scAlertSym];
    const baseline = r ? scMetric(r, "turnover24h") : null;
    if (baseline === null) { say("No live volume for this symbol yet — try again once the feed shows it.", false); return; }
    raw.baseline = baseline;
  }
  const alert = scSanitizeAlert(raw);
  if (!alert) { say(kind === "top_mover" ? "Rank must be a number from 3 to 25." : "Enter a positive numeric threshold.", false); return; }
  _scDoc.alerts.push(alert);
  scPersist();
  scEnsureAlertTimer();
  scRenderAlertExisting();
  scRenderSections();
  say("Alert added — you'll be notified here and in the notification center.", true);
}

// ---- custom scan builder ----
let _scEditScanId = null;
const SC_METRIC_LABELS = {
  last: "Price", pct5m: "5m %", pct15m: "15m %", pct1h: "1h %", pct24h: "24h %",
  range24hPct: "24h range %", vol15mPct: "15m volatility %", turnover24h: "24h volume",
  turnoverDelta15m: "Δ volume 15m", fundingPct: "Funding %", fundingDelta1hPct: "Funding Δ1h %",
  openInterestValue: "Open interest", distHigh24hPct: "Distance to 24h high %",
  distLow24hPct: "Distance to 24h low %", spreadPct: "Spread %",
};
const SC_OP_LABELS = { gt: ">", gte: "≥", lt: "<", lte: "≤", absGte: "|x| ≥", absLte: "|x| ≤" };
function scScanRuleRow(rule) {
  const r = rule || { metric: "pct24h", op: "gte", value: "" };
  return `<div class="sc-rule">` +
    `<select class="sc-rule-metric" aria-label="Metric">` +
    SC_METRICS.map((k) => `<option value="${k}"${k === r.metric ? " selected" : ""}>${esc(SC_METRIC_LABELS[k] || k)}</option>`).join("") +
    `</select>` +
    `<select class="sc-rule-op" aria-label="Comparison">` +
    SC_OPS.map((o) => `<option value="${o}"${o === r.op ? " selected" : ""}>${esc(SC_OP_LABELS[o])}</option>`).join("") +
    `</select>` +
    `<input class="sc-rule-value" type="text" inputmode="decimal" autocomplete="off" placeholder="value" value="${r.value === "" ? "" : esc(String(r.value))}" aria-label="Value" />` +
    `<button class="icon-btn sc-rule-del" type="button" title="Remove condition" aria-label="Remove condition">✕</button></div>`;
}
function scScanCollect() {
  const rules = [];
  document.querySelectorAll("#sc-scan-rules .sc-rule").forEach((row) => {
    rules.push({
      metric: row.querySelector(".sc-rule-metric").value,
      op: row.querySelector(".sc-rule-op").value,
      value: row.querySelector(".sc-rule-value").value,
    });
  });
  const modeBtn = document.querySelector("#sc-scan-mode button.active");
  return {
    id: _scEditScanId || scId("scan"),
    name: (document.getElementById("sc-scan-name") || {}).value,
    mode: modeBtn ? modeBtn.dataset.val : "and",
    rules,
  };
}
function scScanPreview() {
  const el = document.getElementById("sc-scan-preview");
  if (!el) return;
  const scan = scSanitizeScan(scScanCollect());
  if (!scan) { el.textContent = "Add at least one complete condition (metric, comparison, numeric value)."; return; }
  if (_scData) {
    const n = (_scData.rows || []).filter((r) => scScanMatches(scan, r)).length;
    el.textContent = `Matches ${n} of ${(_scData.rows || []).length} markets right now.`;
  } else el.textContent = "";
}
function scOpenScanBuilder(scanId) {
  const overlay = document.getElementById("sc-scan-overlay");
  if (!overlay || !_scDoc) return;
  _scEditScanId = null;
  let scan = null;
  if (scanId) {
    scan = _scDoc.scans.find((s) => s.id === scanId) || null;
    if (scan) _scEditScanId = scan.id;
  }
  const name = document.getElementById("sc-scan-name");
  if (name) name.value = scan ? scan.name : "";
  document.querySelectorAll("#sc-scan-mode button").forEach((b) => {
    const on = b.dataset.val === (scan ? scan.mode : "and");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const rulesEl = document.getElementById("sc-scan-rules");
  if (rulesEl) rulesEl.innerHTML = (scan ? scan.rules : [null]).map(scScanRuleRow).join("");
  const del = document.getElementById("sc-scan-delete");
  if (del) del.hidden = !scan;
  const res = document.getElementById("sc-scan-result");
  if (res) { res.textContent = ""; res.className = "result-msg"; }
  scScanPreview();
  overlay.hidden = false;
  if (name) name.focus();
}
function scSaveScanFromModal() {
  if (!_scDoc) return;
  const res = document.getElementById("sc-scan-result");
  const say = (msg) => { if (res) { res.textContent = msg; res.className = "result-msg err"; } };
  const scan = scSanitizeScan(scScanCollect());
  if (!scan) { say("A scan needs a name-able rule set: every condition must have a numeric value."); return; }
  if (!String(scan.name).trim() || scan.name === "Scan") scan.name = "Scan " + (_scDoc.scans.length + 1);
  const existing = _scDoc.scans.findIndex((s) => s.id === scan.id);
  if (existing >= 0) _scDoc.scans[existing] = scan;
  else {
    if (_scDoc.scans.length >= SC_MAX_SCANS) { say(`Scan limit reached (${SC_MAX_SCANS}).`); return; }
    _scDoc.scans.push(scan);
  }
  scPersist();
  document.getElementById("sc-scan-overlay").hidden = true;
  scSetPresetForce("scan:" + scan.id);
  toast(`Saved scan “${scan.name}”`, "pos", 2000);
}
function scSetPresetForce(id) {
  _scView.preset = id;
  scRenderPresets();
  scSyncTable();
  scAutoSaveView();
}

// ---- wiring ----
function wireScanner() {
  scLoad();
  const pane = document.querySelector('[data-pane="scanner"]');
  if (!pane) return;
  scRenderHead();
  scRenderPresets();
  scEnsureAlertTimer();

  // Presets strip (click chip = activate; click ACTIVE custom chip = edit).
  const presetsEl = document.getElementById("sc-presets");
  presetsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-preset]");
    if (!chip) return;
    const id = chip.dataset.preset;
    if (id === _scView.preset && id.indexOf("scan:") === 0) { scOpenScanBuilder(id.slice(5)); return; }
    scSetPreset(id);
  });

  // Search (instant, debounce-free — the compute is cheap and pure).
  const search = document.getElementById("sc-search");
  const searchClear = document.getElementById("sc-search-clear");
  const paintClear = () => { if (searchClear) searchClear.hidden = !search.value; };
  search.addEventListener("input", () => { _scQuery = search.value; paintClear(); scSyncTable(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; _scQuery = ""; paintClear(); scSyncTable(); search.blur(); }
    else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const vp = document.getElementById("sc-viewport");
      if (_scVisible.length) { scSelect(_scVisible[0].symbol); scScrollToSelected(); }
      if (vp) vp.focus();
    }
  });
  if (searchClear) searchClear.addEventListener("click", () => {
    search.value = ""; _scQuery = ""; paintClear(); scSyncTable(); search.focus();
  });

  // Filters popover.
  const filterBtn = document.getElementById("sc-filter-btn");
  const filterPop = document.getElementById("sc-filter-pop");
  const closePop = () => { filterPop.hidden = true; filterBtn.setAttribute("aria-expanded", "false"); };
  filterBtn.addEventListener("click", () => {
    const open = filterPop.hidden;
    filterPop.hidden = !open;
    filterBtn.setAttribute("aria-expanded", String(open));
    if (open) { const f = filterPop.querySelector("input"); if (f) f.focus(); }
  });
  filterPop.addEventListener("input", (e) => {
    const inp = e.target.closest("[data-scfilter]");
    if (!inp) return;
    const v = inp.value.trim();
    const n = Number(v);
    _scView.filters[inp.dataset.scfilter] = v !== "" && isFinite(n) ? n : null;
    scSyncTable();
    scAutoSaveView();
  });
  document.getElementById("sc-filter-clear").addEventListener("click", () => {
    Object.keys(_scView.filters).forEach((k) => { _scView.filters[k] = null; });
    filterPop.querySelectorAll("[data-scfilter]").forEach((inp) => { inp.value = ""; });
    scSyncTable();
    scAutoSaveView();
  });
  document.addEventListener("click", (e) => {
    if (!filterPop.hidden && !filterPop.contains(e.target) && !filterBtn.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !filterPop.hidden) closePop(); });

  // Favorites pin + overview toggle.
  const pin = document.getElementById("sc-pin-favs");
  pin.addEventListener("click", () => {
    _scView.pinFavs = !_scView.pinFavs;
    pin.setAttribute("aria-pressed", String(_scView.pinFavs));
    pin.classList.toggle("on", _scView.pinFavs);
    scSyncTable();
    scAutoSaveView();
  });
  document.getElementById("sc-cards-toggle").addEventListener("click", () => {
    _scView.cards = !_scView.cards;
    scRenderSections();
    scAutoSaveView();
  });

  // Header sort.
  document.getElementById("sc-head").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (_scView.sort === key) _scView.dir = _scView.dir === "asc" ? "desc" : "asc";
    else { _scView.sort = key; _scView.dir = key === "symbol" ? "asc" : "desc"; }
    scSyncTable();
    scAutoSaveView();
  });

  // Table interactions: virtual scroll, click-select, dblclick-open, context menu.
  const vp = document.getElementById("sc-viewport");
  let scrollTick = false;
  vp.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => { scrollTick = false; scRenderTable(); });
    scAutoSaveView(); // scroll position is part of the workspace
  });
  vp.addEventListener("click", (e) => {
    const fav = e.target.closest(".sc-fav");
    const more = e.target.closest(".sc-more");
    const row = e.target.closest(".sc-row[data-sym]");
    if (!row) return;
    const sym = row.dataset.sym;
    if (fav) { scToggleFav(sym); return; }
    if (more) { const r = row.getBoundingClientRect(); scSelect(sym); scOpenCtx(sym, r.right - 180, r.bottom); return; }
    scSelect(sym);
  });
  vp.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".sc-row[data-sym]");
    if (row) wlOpenSymbol(row.dataset.sym, { trade: false });
  });
  vp.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".sc-row[data-sym]");
    if (!row) return;
    e.preventDefault();
    scSelect(row.dataset.sym);
    scOpenCtx(row.dataset.sym, e.clientX, e.clientY);
  });
  // Full keyboard navigation (never a trade: Enter opens chart & book only).
  vp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); scMoveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); scMoveSelection(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); scMoveSelection(scPageSize()); }
    else if (e.key === "PageUp") { e.preventDefault(); scMoveSelection(-scPageSize()); }
    else if (e.key === "Home") { e.preventDefault(); scMoveSelection(0, "home"); }
    else if (e.key === "End") { e.preventDefault(); scMoveSelection(0, "end"); }
    else if (e.key === "Enter" && _scSel) { e.preventDefault(); wlOpenSymbol(_scSel, { trade: false }); }
    else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && _scSel) {
      e.preventDefault();
      const row = _scRowEls[_scSel];
      const r = row ? row.getBoundingClientRect() : vp.getBoundingClientRect();
      scOpenCtx(_scSel, r.left + 120, r.bottom);
    }
  });
  window.addEventListener("resize", () => { if (scPaneVisible()) scRenderTable(); });

  // Empty-state reset.
  document.getElementById("sc-empty").addEventListener("click", (e) => {
    if (!e.target.closest('[data-scempty="reset"]')) return;
    _scQuery = "";
    search.value = "";
    paintClear();
    Object.keys(_scView.filters).forEach((k) => { _scView.filters[k] = null; });
    filterPop.querySelectorAll("[data-scfilter]").forEach((inp) => { inp.value = ""; });
    scSetPresetForce("all");
  });

  // Overview cards: select/open, funding mode, collapse, drag + keyboard move.
  const sections = document.getElementById("sc-sections");
  sections.addEventListener("click", (e) => {
    const fmode = e.target.closest("[data-fmode]");
    if (fmode) {
      _scFundingMode = fmode.dataset.fmode;
      fmode.parentElement.querySelectorAll("button").forEach((b) => {
        const on = b === fmode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      scRenderSections();
      return;
    }
    const collapse = e.target.closest(".sc-card-collapse");
    if (collapse) {
      const card = collapse.closest(".sc-card");
      const id = card.dataset.scsec;
      if (_scView.sections.collapsed[id]) delete _scView.sections.collapsed[id];
      else _scView.sections.collapsed[id] = true;
      scPatchCard(card, id);
      scAutoSaveView();
      return;
    }
    if (e.target.closest('[data-scact="newalert"]')) { scOpenAlert(null); return; }
    const mini = e.target.closest(".sc-mini[data-sym], .sc-alert-row[data-sym]");
    if (mini) scSelect(mini.dataset.sym);
  });
  sections.addEventListener("dblclick", (e) => {
    const mini = e.target.closest(".sc-mini[data-sym]");
    if (mini) wlOpenSymbol(mini.dataset.sym, { trade: false });
  });
  sections.addEventListener("keydown", (e) => {
    const mini = e.target.closest(".sc-mini[data-sym], .sc-alert-row[data-sym]");
    if (mini && e.key === "Enter") { e.preventDefault(); scSelect(mini.dataset.sym); wlOpenSymbol(mini.dataset.sym, { trade: false }); }
    const drag = e.target.closest(".sc-card-drag");
    if (drag && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const card = drag.closest(".sc-card");
      const id = card.dataset.scsec;
      const order = _scView.sections.order;
      const i = order.indexOf(id);
      const j = e.key === "ArrowLeft" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= order.length) return;
      order.splice(i, 1);
      order.splice(j, 0, id);
      scRenderSections();
      const nd = sections.querySelector(`.sc-card[data-scsec="${id}"] .sc-card-drag`);
      if (nd) nd.focus();
      scAutoSaveView();
    }
  });
  // HTML5 drag-to-rearrange (initiated from the ⠿ handle only).
  let dragCard = null;
  sections.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".sc-card-drag");
    const card = handle && handle.closest(".sc-card");
    sections.querySelectorAll(".sc-card").forEach((c) => { c.draggable = c === card; });
  });
  sections.addEventListener("dragstart", (e) => {
    dragCard = e.target.closest(".sc-card");
    if (dragCard) dragCard.classList.add("dragging");
  });
  sections.addEventListener("dragover", (e) => {
    if (!dragCard) return;
    e.preventDefault();
    const over = e.target.closest(".sc-card");
    if (!over || over === dragCard) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    sections.insertBefore(dragCard, before ? over : over.nextSibling);
  });
  sections.addEventListener("dragend", () => {
    if (!dragCard) return;
    dragCard.classList.remove("dragging");
    dragCard.draggable = false;
    dragCard = null;
    _scView.sections.order = Array.from(sections.querySelectorAll(":scope > .sc-card[data-scsec]")).map((c) => c.dataset.scsec);
    scAutoSaveView();
  });

  // Context menu plumbing (mirrors the watchlist menu).
  const ctx = document.getElementById("sc-ctx");
  ctx.addEventListener("click", (e) => {
    const item = e.target.closest(".wl-ctx-item");
    if (!item) return;
    const sym = ctx.dataset.sym;
    scCloseCtx();
    scCtxAction(item.dataset.act, sym, item);
  });
  ctx.addEventListener("keydown", (e) => {
    const items = Array.from(ctx.querySelectorAll(".wl-ctx-item"));
    const cur = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); scCloseCtx(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (items[cur + 1] || items[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (items[cur - 1] || items[items.length - 1]).focus(); }
  });
  document.addEventListener("click", (e) => { if (!ctx.hidden && !ctx.contains(e.target)) scCloseCtx(); });

  // Alert modal.
  const alertOverlay = document.getElementById("sc-alert-overlay");
  document.getElementById("sc-alert-btn").addEventListener("click", () => scOpenAlert(_scSel || null));
  document.getElementById("sc-alert-kind").addEventListener("change", scAlertSyncInputs);
  document.getElementById("sc-alert-add").addEventListener("click", scAddAlertFromModal);
  document.getElementById("sc-alert-cancel").addEventListener("click", () => { alertOverlay.hidden = true; });
  alertOverlay.addEventListener("click", (e) => { if (e.target === alertOverlay) alertOverlay.hidden = true; });
  document.getElementById("sc-alert-existing").addEventListener("click", (e) => {
    const del = e.target.closest("[data-alid]");
    if (!del || !_scDoc) return;
    _scDoc.alerts = _scDoc.alerts.filter((a) => a.id !== del.dataset.alid);
    scPersist();
    scEnsureAlertTimer();
    scRenderAlertExisting();
    scRenderSections();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !alertOverlay.hidden) alertOverlay.hidden = true; });

  // Scan builder modal.
  const scanOverlay = document.getElementById("sc-scan-overlay");
  document.getElementById("sc-scan-new").addEventListener("click", () => scOpenScanBuilder(null));
  document.getElementById("sc-scan-addrule").addEventListener("click", () => {
    const rulesEl = document.getElementById("sc-scan-rules");
    if (rulesEl.querySelectorAll(".sc-rule").length >= SC_MAX_RULES) return;
    rulesEl.insertAdjacentHTML("beforeend", scScanRuleRow(null));
    scScanPreview();
  });
  document.getElementById("sc-scan-rules").addEventListener("click", (e) => {
    const del = e.target.closest(".sc-rule-del");
    if (del) { del.closest(".sc-rule").remove(); scScanPreview(); }
  });
  document.getElementById("sc-scan-rules").addEventListener("input", scScanPreview);
  document.getElementById("sc-scan-rules").addEventListener("change", scScanPreview);
  document.querySelectorAll("#sc-scan-mode button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#sc-scan-mode button").forEach((x) => {
      const on = x === b;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", String(on));
    });
    scScanPreview();
  }));
  document.getElementById("sc-scan-save").addEventListener("click", scSaveScanFromModal);
  document.getElementById("sc-scan-cancel").addEventListener("click", () => { scanOverlay.hidden = true; });
  document.getElementById("sc-scan-delete").addEventListener("click", () => {
    if (!_scEditScanId || !_scDoc) return;
    _scDoc.scans = _scDoc.scans.filter((s) => s.id !== _scEditScanId);
    scPersist();
    scanOverlay.hidden = true;
    if (_scView.preset === "scan:" + _scEditScanId) scSetPresetForce("all");
    else scRenderPresets();
    toast("Scan deleted", "info", 1800);
  });
  scanOverlay.addEventListener("click", (e) => { if (e.target === scanOverlay) scanOverlay.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !scanOverlay.hidden) scanOverlay.hidden = true; });
}

// ===========================================================================
// WORKSPACES — a workspace is a complete named trading environment (panel
// order + collapsed state, table density, chart view/interval/symbol, active
// tab, order-book symbol). Any number of them; switching restores everything
// instantly. Storage: localStorage `dma.workspace.v2` (versioned; migrates
// v1 + the old density key; corrupt/future blobs are PRESERVED under a
// `.corrupt` key, never silently discarded). Everything here is DISPLAY
// STATE ONLY: applying a workspace re-clicks existing controls and toggles
// classes — it can never touch trading state or issue a write.
//
// Layout: a PURE, DOM-free document-ops core first (top-level functions so
// tests/test_snap.mjs can extract and unit-test them), then the DOM manager.
// ===========================================================================

const WS_STORE_KEY = "dma.workspace.v2";
const WS_LEGACY_KEY = "dma.workspace.v1";
const WS_SCHEMA_VERSION = 2;
const WS_MAX = 20;
// Allowlists for sanitizing stored/imported state (one-line consts so the
// test harness can extract them alongside the functions).
const WS_PANEL_IDS = ["risk", "positions", "orders", "charts", "exec", "token", "quick", "ticket", "book", "rk-head", "rk-exposure", "rk-conc", "rk-liq", "rk-margin", "rk-positions", "rk-daily", "rk-timeline", "rk-history"];
const WS_TABS = ["dashboard", "risk", "pnl", "scanner", "markets", "history", "ai", "account", "tools"];
const WS_SYMBOL_RE = /^[A-Z0-9]{1,20}$/;

function wsId() {
  return "ws_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Coerce ANY value into a valid workspace state (unknown fields dropped,
// invalid values replaced by defaults). This is the single trust boundary for
// storage and imports: everything rendered later is either from these
// allowlists or additionally escaped at render time.
function wsSanitizeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const collapsed = {};
  if (src.collapsed && typeof src.collapsed === "object") {
    WS_PANEL_IDS.forEach((id) => { if (src.collapsed[id]) collapsed[id] = true; });
  }
  const order = Array.isArray(src.order)
    ? src.order.filter((id, i) => WS_PANEL_IDS.includes(id) && src.order.indexOf(id) === i)
    : [];
  const book = String(src.bookSymbol || "").toUpperCase();
  const watch = src.watch && typeof src.watch === "object" ? src.watch : {};
  return {
    order: order.length ? order : ["risk", "positions", "orders", "charts"],
    collapsed,
    density: src.density === "compact" ? "compact" : "comfortable",
    // Multi-chart workspace (layout/slots/links/zoom/fullscreen/track sizes).
    // Sanitized by the chart module's own pure sanitizer; the second argument
    // migrates the pre-multi-chart shape ({view,interval,single}) losslessly.
    charts: mcSanitizeCharts(src.charts, src.chart),
    tab: WS_TABS.includes(src.tab) ? src.tab : "dashboard",
    bookSymbol: WS_SYMBOL_RE.test(book) ? book : "",
    // Watchlist VIEW the workspace remembers (which list is selected, plus its
    // sort/filter). The watchlists themselves live in their own store; the
    // workspace only points at one and remembers how it was being viewed.
    watch: {
      listId: typeof watch.listId === "string" ? watch.listId.slice(0, 40) : "",
      filter: WL_FILTERS.includes(watch.filter) ? watch.filter : "all",
      sort: WL_SORTS.includes(watch.sort) ? watch.sort : "custom",
      dir: watch.dir === "asc" ? "asc" : "desc",
    },
    // Scanner VIEW (preset/sort/filters/card layout/selection/scroll) — the
    // scans/alerts/favorites themselves live in the scanner's own store; the
    // workspace only remembers how the tab was being viewed (§same contract
    // as `watch` above). Sanitized by the scanner's own pure sanitizer.
    scanner: scSanitizeViewState(src.scanner),
    // Risk-tab VIEW (allocation chart type, table sort, history metric) —
    // same contract; the alert-armed switch is account-level and lives in
    // its own store, not the workspace.
    risk: rkSanitizeViewState(src.risk),
    // Journal VIEW (sub-view, range, search, filters, sort, calendar month) —
    // same contract; the entries/catalogs themselves live in MongoDB, the
    // workspace only remembers how the journal was being looked at.
    journal: jnSanitizeViewState(src.journal),
    // AI coach VIEW (sub-view, analysis range, review period, conv search) —
    // same contract; conversations/insights live server-side.
    ai: aiSanitizeViewState(src.ai),
    // Execution-workspace VIEW (ladder grouping/rows/follow + orders filter).
    exec: exSanitizeViewState(src.exec),
  };
}

function wsMakeWorkspace(name, state, description) {
  const now = Date.now();
  return {
    id: wsId(),
    name: String(name || "Workspace").slice(0, 40),
    description: typeof description === "string" ? description.slice(0, 140) : "",
    createdAt: now,
    updatedAt: now,
    state: wsSanitizeState(state),
    snapshot: null,
  };
}

function wsSanitizeWorkspace(w) {
  if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) return null;
  const now = Date.now();
  return {
    id: w.id.slice(0, 40),
    name: String(w.name || "Workspace").slice(0, 40),
    description: typeof w.description === "string" ? w.description.slice(0, 140) : "",
    createdAt: Number(w.createdAt) || now,
    updatedAt: Number(w.updatedAt) || now,
    state: wsSanitizeState(w.state),
    snapshot: w.snapshot && typeof w.snapshot === "object"
      ? { savedAt: Number(w.snapshot.savedAt) || now, state: wsSanitizeState(w.snapshot.state) }
      : null,
  };
}

function wsNewDoc() {
  const w = wsMakeWorkspace("Default");
  return { version: WS_SCHEMA_VERSION, activeId: w.id, workspaces: [w] };
}

// v1 ({order, collapsed}) + the old standalone density key become the state
// of the initial "Default" workspace.
function wsMigrateFromV1(v1, legacyDensity) {
  const doc = wsNewDoc();
  doc.workspaces[0].state = wsSanitizeState({
    order: v1 && v1.order,
    collapsed: v1 && v1.collapsed,
    density: legacyDensity,
  });
  return doc;
}

// Parse whatever is in storage into a guaranteed-valid document.
// corrupt:true means the caller must PRESERVE the original blob (quarantine
// key) — user layouts are never silently discarded. An unknown/future schema
// version is treated the same way rather than half-read.
function wsParseDoc(rawV2, rawV1, legacyDensity) {
  if (rawV2 == null || rawV2 === "") {
    if (rawV1) {
      try {
        return { doc: wsMigrateFromV1(JSON.parse(rawV1), legacyDensity), migrated: true, corrupt: false };
      } catch (e) {
        return { doc: wsNewDoc(), migrated: false, corrupt: true };
      }
    }
    return { doc: wsNewDoc(), migrated: false, corrupt: false };
  }
  let parsed;
  try { parsed = JSON.parse(rawV2); } catch (e) {
    return { doc: wsNewDoc(), migrated: false, corrupt: true };
  }
  if (!parsed || typeof parsed !== "object" ||
      parsed.version !== WS_SCHEMA_VERSION || !Array.isArray(parsed.workspaces)) {
    return { doc: wsNewDoc(), migrated: false, corrupt: true };
  }
  const workspaces = parsed.workspaces.map(wsSanitizeWorkspace).filter(Boolean).slice(0, WS_MAX);
  if (!workspaces.length) return { doc: wsNewDoc(), migrated: false, corrupt: true };
  const activeId = workspaces.some((w) => w.id === parsed.activeId) ? parsed.activeId : workspaces[0].id;
  return { doc: { version: WS_SCHEMA_VERSION, activeId, workspaces }, migrated: false, corrupt: false };
}

// Accepts our export envelope ({kind:"workspace", workspace:{…}}) or a bare
// workspace object; returns a FRESH workspace (new id/timestamps) or null.
function wsValidateImport(obj) {
  let w = null;
  if (obj && typeof obj === "object") {
    if (obj.kind === "workspace" && obj.workspace && typeof obj.workspace === "object") w = obj.workspace;
    else if (obj.state && typeof obj.state === "object") w = obj;
  }
  if (!w) return null;
  return wsMakeWorkspace(String(w.name || "Imported"), w.state, w.description);
}

function wsCreate(doc, name, state) {
  if (doc.workspaces.length >= WS_MAX) return null;
  const w = wsMakeWorkspace(name, state);
  doc.workspaces.push(w);
  doc.activeId = w.id;
  return w;
}

function wsDuplicate(doc, id) {
  const base = doc.workspaces.find((w) => w.id === id);
  if (!base) return null;
  const copy = wsCreate(doc, base.name.slice(0, 35) + " copy", base.state);
  if (copy && base.snapshot) {
    copy.snapshot = { savedAt: base.snapshot.savedAt, state: wsSanitizeState(base.snapshot.state) };
  }
  return copy;
}

function wsRename(doc, id, name) {
  const w = doc.workspaces.find((x) => x.id === id);
  const clean = String(name || "").trim();
  if (!w || !clean) return false;
  w.name = clean.slice(0, 40);
  w.updatedAt = Date.now();
  return true;
}

function wsDelete(doc, id) {
  if (doc.workspaces.length <= 1) return false; // the last workspace is undeletable
  const before = doc.workspaces.length;
  doc.workspaces = doc.workspaces.filter((w) => w.id !== id);
  if (doc.workspaces.length === before) return false;
  if (doc.activeId === id) doc.activeId = doc.workspaces[0].id;
  return true;
}

// ------------------------------ DOM manager -------------------------------

let _wsDoc = null;
let _wsSaveTimer = null;
let _wsStorageWarned = false;
let _wsEditId = null;    // row currently in inline-rename mode
let _wsDeleteId = null;  // row currently showing the delete confirm
const _wsPanelCtl = {};  // panel id -> { setCollapsed(on) }

function wsActive() {
  if (!_wsDoc) return null;
  return _wsDoc.workspaces.find((w) => w.id === _wsDoc.activeId) || _wsDoc.workspaces[0];
}

function wsPersist() {
  if (!_wsDoc) return;
  try {
    localStorage.setItem(WS_STORE_KEY, JSON.stringify(_wsDoc));
  } catch (e) {
    // Quota/private-mode: warn ONCE — layouts keep working for the session.
    if (!_wsStorageWarned) {
      _wsStorageWarned = true;
      toast("Could not persist workspace layouts (storage unavailable)", "warn");
    }
  }
}

// Read the CURRENT display state from the live DOM. Starts from the saved
// state so information about panels absent from this DOM (e.g. the rail for
// a viewer session) is preserved rather than dropped.
function wsCaptureState() {
  const active = wsActive();
  const st = wsSanitizeState(active ? active.state : null);
  const main = document.querySelector(".workspace-main");
  if (main) {
    st.order = Array.from(main.querySelectorAll(":scope > [data-wpanel]")).map((s) => s.dataset.wpanel);
  }
  document.querySelectorAll("[data-wpanel]").forEach((sec) => {
    st.collapsed[sec.dataset.wpanel] = sec.classList.contains("collapsed");
  });
  st.density = document.body.classList.contains("density-compact") ? "compact" : "comfortable";
  st.charts = mcCaptureState();
  const activeTab = document.querySelector("#tabs .tab.active");
  if (activeTab && activeTab.dataset.tab) st.tab = activeTab.dataset.tab;
  st.bookSymbol = state.activeSymbol || "";
  st.watch = {
    listId: _wlDoc ? _wlDoc.activeId : "",
    filter: _wlView.filter, sort: _wlView.sort, dir: _wlView.dir,
  };
  st.scanner = scCaptureViewState();
  st.risk = rkCaptureViewState();
  st.journal = jnCaptureViewState();
  st.ai = aiCaptureViewState();
  st.exec = exCaptureViewState();
  return wsSanitizeState(st);
}

// Apply a state to the live UI. The multi-chart module applies its own state
// (mcApplyState — sanitize, rebuild, restart polling); the tab is applied by
// CLICKING the existing control; everything else is class/DOM order.
function wsApplyState(rawState, opts = {}) {
  const st = wsSanitizeState(rawState);
  const main = document.querySelector(".workspace-main");
  if (main) {
    st.order.forEach((id) => {
      const sec = main.querySelector(`:scope > [data-wpanel="${CSS.escape(id)}"]`);
      if (sec) main.appendChild(sec);
    });
    const empty = document.getElementById("ws-empty");
    if (empty) main.appendChild(empty); // the empty-state banner stays last
  }
  Object.keys(_wsPanelCtl).forEach((id) => _wsPanelCtl[id].setCollapsed(!!st.collapsed[id]));
  document.body.classList.toggle("density-compact", st.density === "compact");
  mcApplyState(st.charts);
  const tabBtn = document.querySelector(`#tabs .tab[data-tab="${st.tab}"]`);
  if (tabBtn && !tabBtn.classList.contains("active")) tabBtn.click();
  if (st.bookSymbol && st.bookSymbol !== state.activeSymbol) setActiveSymbol(st.bookSymbol);
  // Restore the watchlist view this workspace remembers (list + sort/filter),
  // then reflect it in the toolbar controls and re-render.
  if (_wlDoc) {
    if (st.watch.listId && wlFindList(_wlDoc, st.watch.listId)) _wlDoc.activeId = st.watch.listId;
    _wlView = { filter: st.watch.filter, sort: st.watch.sort, dir: st.watch.dir, query: "" };
    const sortSel = document.getElementById("wl-sort"); if (sortSel) sortSel.value = _wlView.sort;
    const dirBtn = document.getElementById("wl-sort-dir"); if (dirBtn) dirBtn.textContent = _wlView.dir === "asc" ? "▴" : "▾";
    const filters = document.getElementById("wl-filters");
    if (filters) filters.querySelectorAll("button").forEach((x) => {
      const on = x.dataset.filter === _wlView.filter; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on));
    });
    Object.keys(_wlRowEls).forEach((k) => delete _wlRowEls[k]);
    _wlRenderedKey = "";
    wlRenderLists();
    wlSync();
  }
  // Restore this workspace's scanner view (preset/sort/filters/cards/scroll).
  scApplyViewState(st.scanner);
  // Restore this workspace's risk view (allocation/sort/history metric).
  rkApplyViewState(st.risk);
  // Restore this workspace's journal view (sub-view/range/filters/sort).
  jnApplyViewState(st.journal);
  // Restore this workspace's AI coach view (sub-view/range/period).
  aiApplyViewState(st.ai);
  // Restore this workspace's execution view (ladder settings/order filters).
  exApplyViewState(st.exec);
  wsUpdateEmptyState();
  if (!opts.noAnim) {
    const pane = document.querySelector("main .pane:not([hidden])");
    if (pane) {
      pane.classList.remove("ws-anim");
      void pane.offsetWidth; // restart the entrance animation
      pane.classList.add("ws-anim");
    }
  }
}

// Debounced auto-save: EVERY layout-affecting interaction funnels through
// here (collapse, reorder, density, chart controls, tab, book symbol) — there
// is no Save button anywhere.
function wsAutoSave() {
  if (!_wsDoc) return;
  clearTimeout(_wsSaveTimer);
  _wsSaveTimer = setTimeout(() => {
    const active = wsActive();
    if (!active) return;
    active.state = wsCaptureState();
    active.updatedAt = Date.now();
    wsPersist();
    wsPaintCurrent();
    const panel = document.getElementById("ws-panel");
    if (panel && !panel.hidden) wsRenderList();
  }, 400);
}

function wsFlushSave() {
  if (!_wsDoc) return;
  clearTimeout(_wsSaveTimer);
  const active = wsActive();
  if (!active) return;
  active.state = wsCaptureState();
  active.updatedAt = Date.now();
  wsPersist();
}

function wsSwitch(id) {
  if (!_wsDoc || id === _wsDoc.activeId) { wsCloseSwitcher(); return; }
  const target = _wsDoc.workspaces.find((w) => w.id === id);
  if (!target) return;
  wsFlushSave(); // never lose the outgoing workspace's latest changes
  _wsDoc.activeId = id;
  wsApplyState(target.state);
  wsPersist();
  wsPaintCurrent();
  wsCloseSwitcher();
  toast(`Workspace: ${target.name}`, "info", 1800);
}

function wsUpdateEmptyState() {
  const main = document.querySelector(".workspace-main");
  const empty = document.getElementById("ws-empty");
  if (!main || !empty) return;
  const panels = Array.from(main.querySelectorAll(":scope > [data-wpanel]"));
  empty.hidden = !panels.length || panels.some((p) => !p.classList.contains("collapsed"));
}

function wsPaintCurrent() {
  const label = document.getElementById("ws-current");
  const active = wsActive();
  if (label && active) label.textContent = active.name;
}

function wsRelTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function wsRenderList() {
  const listEl = document.getElementById("ws-list");
  const search = document.getElementById("ws-search");
  if (!listEl || !_wsDoc) return;
  const q = (search ? search.value : "").trim().toLowerCase();
  const rows = _wsDoc.workspaces.filter((w) => !q || w.name.toLowerCase().includes(q));
  const many = _wsDoc.workspaces.length > 1;
  listEl.innerHTML = rows.length ? rows.map((w, i) => {
    const activeCls = w.id === _wsDoc.activeId ? " active" : "";
    const panelCount = WS_PANEL_IDS.filter((id) => !w.state.collapsed[id]).length;
    const collapsedCount = Object.keys(w.state.collapsed).filter((k) => w.state.collapsed[k]).length;
    const meta = `${panelCount} panels · ${collapsedCount} collapsed · ${wsRelTime(w.updatedAt)}`;
    if (w.id === _wsEditId) {
      return `<div class="ws-row editing" data-wsid="${esc(w.id)}">` +
        `<input class="ws-rename" type="text" value="${esc(w.name)}" maxlength="40" aria-label="Workspace name" />` +
        `</div>`;
    }
    if (w.id === _wsDeleteId) {
      return `<div class="ws-row deleting" data-wsid="${esc(w.id)}">` +
        `<span class="ws-name">Delete “${esc(w.name)}”?</span>` +
        `<span class="ws-acts">` +
        `<button type="button" class="ws-act neg" data-act="confirm-del" title="Delete">✓</button>` +
        `<button type="button" class="ws-act" data-act="cancel-del" title="Keep">✕</button>` +
        `</span></div>`;
    }
    return `<div class="ws-row${activeCls}" role="option" aria-selected="${w.id === _wsDoc.activeId}" data-wsid="${esc(w.id)}" data-i="${i}">` +
      `<span class="ws-dot" aria-hidden="true"></span>` +
      `<span class="ws-main"><span class="ws-name">${esc(w.name)}</span>` +
      `<span class="ws-meta">${esc(meta)}</span></span>` +
      (i < 9 ? `<kbd class="ws-key">${i + 1}</kbd>` : "") +
      `<span class="ws-acts">` +
      `<button type="button" class="ws-act" data-act="rename" title="Rename" aria-label="Rename ${esc(w.name)}">✎</button>` +
      (many ? `<button type="button" class="ws-act" data-act="delete" title="Delete" aria-label="Delete ${esc(w.name)}">🗑</button>` : "") +
      `</span></div>`;
  }).join("") : `<div class="ws-none muted">No matching workspace.</div>`;
  const editInput = listEl.querySelector(".ws-rename");
  if (editInput) { editInput.focus(); editInput.select(); }
}

function wsOpenSwitcher(startRename) {
  const panel = document.getElementById("ws-panel");
  const btn = document.getElementById("ws-btn");
  const search = document.getElementById("ws-search");
  if (!panel || !_wsDoc) return;
  _wsEditId = startRename ? _wsDoc.activeId : null;
  _wsDeleteId = null;
  if (search) search.value = "";
  panel.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
  wsRenderList();
  if (!startRename && search) search.focus();
}

function wsCloseSwitcher() {
  const panel = document.getElementById("ws-panel");
  const btn = document.getElementById("ws-btn");
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
  _wsEditId = null;
  _wsDeleteId = null;
}

function wsExportActive() {
  const active = wsActive();
  if (!active) return;
  wsFlushSave();
  const payload = {
    app: "dma-terminal", kind: "workspace", version: WS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: { name: active.name, description: active.description, state: active.state },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dma-workspace-${active.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "layout"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wsImportFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let ws = null;
    try { ws = wsValidateImport(JSON.parse(String(reader.result))); } catch (e) { /* invalid JSON */ }
    if (!ws) { toast("Import failed: not a valid workspace file", "neg"); return; }
    if (_wsDoc.workspaces.length >= WS_MAX) { toast(`Workspace limit reached (${WS_MAX})`, "warn"); return; }
    wsFlushSave();
    _wsDoc.workspaces.push(ws);
    _wsDoc.activeId = ws.id;
    wsApplyState(ws.state);
    wsPersist();
    wsPaintCurrent();
    wsRenderList();
    toast(`Imported workspace: ${ws.name}`, "pos");
  };
  reader.onerror = () => toast("Import failed: could not read the file", "neg");
  reader.readAsText(file);
}

function wireWorkspaces() {
  // ---- Load (with migration + corruption quarantine) ----
  let rawV2 = null, rawV1 = null, legacyDensity = null;
  try {
    rawV2 = localStorage.getItem(WS_STORE_KEY);
    rawV1 = localStorage.getItem(WS_LEGACY_KEY);
    legacyDensity = localStorage.getItem("dma.density");
  } catch (e) { /* storage unavailable: run on defaults */ }
  const { doc, migrated, corrupt } = wsParseDoc(rawV2, rawV1, legacyDensity);
  _wsDoc = doc;
  if (corrupt && rawV2 != null) {
    try { localStorage.setItem(WS_STORE_KEY + ".corrupt", rawV2); } catch (e) {}
    toast("Workspace data was unreadable — reset to defaults (old data kept under …corrupt)", "warn", 8000);
  }
  if (migrated) {
    try { localStorage.removeItem(WS_LEGACY_KEY); } catch (e) {}
  }
  wsPersist();

  // ---- Per-panel controls (collapse + drag), registered into _wsPanelCtl ----
  const main = document.querySelector(".workspace-main");
  document.querySelectorAll("[data-wpanel]").forEach((sec) => {
    const head = sec.querySelector(".panel-head");
    const id = sec.dataset.wpanel;
    if (!head) return;
    const reorderable = main && sec.parentElement === main;
    const tools = document.createElement("span");
    tools.className = "wpanel-tools";
    tools.innerHTML =
      (reorderable
        ? `<button type="button" class="wpanel-btn wpanel-drag" draggable="true" title="Drag to reorder (Arrow keys work too)" aria-label="Reorder ${esc(id)} panel">⁙</button>`
        : "") +
      `<button type="button" class="wpanel-btn wpanel-collapse" title="Collapse panel" aria-expanded="true" aria-label="Collapse ${esc(id)} panel">▾</button>`;
    head.appendChild(tools);

    const collapseBtn = tools.querySelector(".wpanel-collapse");
    const setCollapsed = (on) => {
      if (sec.classList.contains("collapsed") === on) return; // cheap no-op
      sec.classList.toggle("collapsed", on);
      collapseBtn.setAttribute("aria-expanded", String(!on));
      collapseBtn.textContent = on ? "▸" : "▾";
      // Collapsed panels stop paying for data they don't show.
      if (id === "charts") { if (on) stopChartPolling(); else startChartPolling(); }
    };
    _wsPanelCtl[id] = { setCollapsed };
    collapseBtn.addEventListener("click", () => {
      setCollapsed(!sec.classList.contains("collapsed"));
      wsUpdateEmptyState();
      wsAutoSave();
    });

    const dragBtn = tools.querySelector(".wpanel-drag");
    if (dragBtn) {
      dragBtn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        sec.classList.add("dragging");
      });
      dragBtn.addEventListener("dragend", () => { sec.classList.remove("dragging"); wsAutoSave(); });
      dragBtn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const sib = e.key === "ArrowUp" ? sec.previousElementSibling : sec.nextElementSibling;
        if (!sib || !sib.dataset || !sib.dataset.wpanel) return;
        if (e.key === "ArrowUp") main.insertBefore(sec, sib);
        else main.insertBefore(sib, sec);
        wsAutoSave();
        dragBtn.focus();
      });
    }
  });
  if (main) {
    main.addEventListener("dragover", (e) => {
      const dragging = main.querySelector(":scope > .dragging");
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest("[data-wpanel]");
      if (!over || over === dragging || over.parentElement !== main) return;
      const rect = over.getBoundingClientRect();
      main.insertBefore(dragging, e.clientY < rect.top + rect.height / 2 ? over : over.nextSibling);
    });
    main.addEventListener("drop", (e) => e.preventDefault());
  }

  // ---- Auto-save hooks for the non-panel parts of a workspace ----
  // (Chart mutations auto-save themselves via the chart module's mcAutoSave.)
  const tabs = document.getElementById("tabs");
  if (tabs) {
    tabs.addEventListener("click", () => wsAutoSave());
    tabs.addEventListener("keydown", () => wsAutoSave()); // arrow-key tab switches
  }

  // ---- Switcher UI ----
  const btn = document.getElementById("ws-btn");
  const panel = document.getElementById("ws-panel");
  const search = document.getElementById("ws-search");
  const listEl = document.getElementById("ws-list");
  if (btn && panel) {
    btn.addEventListener("click", () => { panel.hidden ? wsOpenSwitcher() : wsCloseSwitcher(); });
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) wsCloseSwitcher();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) wsCloseSwitcher();
    });
  }
  if (search) {
    search.addEventListener("input", () => { _wsDeleteId = null; wsRenderList(); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = listEl && listEl.querySelector(".ws-row[data-wsid]:not(.editing):not(.deleting)");
        if (first) wsSwitch(first.dataset.wsid);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = listEl && listEl.querySelector(".ws-row[tabindex], .ws-row");
        if (first && first.focus) { first.setAttribute("tabindex", "0"); first.focus(); }
      }
    });
  }
  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const act = e.target.closest(".ws-act");
      const row = e.target.closest(".ws-row[data-wsid]");
      if (!row) return;
      const id = row.dataset.wsid;
      if (act) {
        const kind = act.dataset.act;
        if (kind === "rename") { _wsEditId = id; _wsDeleteId = null; wsRenderList(); }
        else if (kind === "delete") { _wsDeleteId = id; _wsEditId = null; wsRenderList(); }
        else if (kind === "confirm-del") {
          const wasActive = _wsDoc.activeId === id;
          if (wsDelete(_wsDoc, id)) {
            _wsDeleteId = null;
            if (wasActive) wsApplyState(wsActive().state);
            wsPersist(); wsPaintCurrent(); wsRenderList();
            toast("Workspace deleted", "info", 2000);
          }
        } else if (kind === "cancel-del") { _wsDeleteId = null; wsRenderList(); }
        return;
      }
      if (row.classList.contains("editing") || row.classList.contains("deleting")) return;
      wsSwitch(id);
    });
    // Inline rename: Enter/blur commits, Esc cancels.
    listEl.addEventListener("keydown", (e) => {
      const input = e.target.closest(".ws-rename");
      if (input) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); _wsEditId = null; wsRenderList(); }
        return;
      }
      // Keyboard on rows: Enter switches, digits quick-switch, arrows move.
      const row = e.target.closest(".ws-row[data-wsid]");
      if (!row) return;
      if (e.key === "Enter") { e.preventDefault(); wsSwitch(row.dataset.wsid); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const sib = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        if (sib && sib.classList.contains("ws-row")) { sib.setAttribute("tabindex", "0"); sib.focus(); }
      }
    });
    listEl.addEventListener("focusout", (e) => {
      const input = e.target.closest && e.target.closest(".ws-rename");
      if (!input || _wsEditId == null) return;
      if (wsRename(_wsDoc, _wsEditId, input.value)) wsPersist();
      _wsEditId = null;
      wsPaintCurrent();
      wsRenderList();
    });
    // Digits 1–9 select the Nth listed workspace while the switcher is open
    // (and focus is NOT in the search field, where digits must stay typeable).
    document.addEventListener("keydown", (e) => {
      if (!panel || panel.hidden) return;
      if (e.target === search || _wsEditId) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const rows = listEl.querySelectorAll(".ws-row[data-wsid]:not(.editing):not(.deleting)");
      const row = rows[Number(e.key) - 1];
      if (row) { e.preventDefault(); wsSwitch(row.dataset.wsid); }
    });
  }

  // ---- Footer actions ----
  const on = (bid, fn) => { const b = document.getElementById(bid); if (b) b.addEventListener("click", fn); };
  on("ws-new", () => {
    wsFlushSave();
    const w = wsCreate(_wsDoc, `Workspace ${_wsDoc.workspaces.length + 1}`, wsCaptureState());
    if (!w) { toast(`Workspace limit reached (${WS_MAX})`, "warn"); return; }
    wsPersist(); wsPaintCurrent();
    _wsEditId = w.id; // Linear-style: a new workspace is born in rename mode
    wsRenderList();
  });
  on("ws-dup", () => {
    wsFlushSave();
    const w = wsDuplicate(_wsDoc, _wsDoc.activeId);
    if (!w) { toast(`Workspace limit reached (${WS_MAX})`, "warn"); return; }
    wsPersist(); wsPaintCurrent(); wsRenderList();
    toast(`Duplicated as: ${w.name}`, "pos", 2200);
  });
  on("ws-export", wsExportActive);
  on("ws-import", () => { const f = document.getElementById("ws-import-file"); if (f) f.click(); });
  const fileInput = document.getElementById("ws-import-file");
  if (fileInput) fileInput.addEventListener("change", () => {
    wsImportFromFile(fileInput.files && fileInput.files[0]);
    fileInput.value = "";
  });
  on("ws-snap-save", () => {
    const active = wsActive();
    if (!active) return;
    active.snapshot = { savedAt: Date.now(), state: wsCaptureState() };
    wsPersist();
    toast("Snapshot saved for this workspace", "pos", 2200);
  });
  on("ws-snap-restore", () => {
    const active = wsActive();
    if (!active || !active.snapshot) { toast("No snapshot saved for this workspace yet", "warn"); return; }
    wsApplyState(active.snapshot.state);
    wsAutoSave();
    toast(`Snapshot restored (${wsRelTime(active.snapshot.savedAt)})`, "pos", 2200);
  });
  on("ws-reset", () => {
    wsApplyState(null); // defaults
    wsAutoSave();
    toast("Workspace reset to the default layout", "info", 2200);
  });
  on("ws-empty-reset", () => { wsApplyState(null); wsAutoSave(); });
  on("ws-empty-open", () => wsOpenSwitcher());

  // ---- Apply the active workspace ----
  wsPaintCurrent();
  wsApplyState(wsActive().state, { noAnim: true });
}

// Table density is part of the active WORKSPACE's state (info-density is a
// per-environment preference); this thin toggle exists for the palette.
function toggleDensity() {
  document.body.classList.toggle("density-compact");
  wsAutoSave();
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts reference ("?")
// ---------------------------------------------------------------------------
function wireKeysHelp() {
  const overlay = document.getElementById("keys-overlay");
  if (!overlay) return;
  const close = () => { overlay.hidden = true; };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const btn = document.getElementById("keys-close");
  if (btn) btn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });
}
function openKeysHelp() {
  const overlay = document.getElementById("keys-overlay");
  if (overlay) overlay.hidden = false;
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd + K) — navigation & display actions ONLY. Every
// action just .click()s an existing on-screen control, so no new code path
// can ever reach a write endpoint; the standing rule that no keyboard
// shortcut trades is preserved by construction.
// ---------------------------------------------------------------------------
function wireCommandPalette() {
  const overlay = document.getElementById("cmdk-overlay");
  const input = document.getElementById("cmdk-input");
  const listEl = document.getElementById("cmdk-list");
  if (!overlay || !input || !listEl) return;
  let items = [];
  let sel = 0;
  let prevFocus = null;

  // Built fresh at each open/keystroke from the CURRENT DOM, so viewer-removed
  // controls (admin tabs, the ticket) never appear for a viewer session.
  const buildActions = () => {
    const acts = [];
    document.querySelectorAll("#tabs .tab").forEach((b) => {
      const label = (b.textContent || "").replace(/\s+/g, " ").trim();
      acts.push({ label: `Go to ${label}`, hint: "nav", run: () => b.click() });
    });
    if (document.getElementById("order-form")) {
      acts.push({
        label: "Focus order ticket", hint: "/",
        run: () => {
          const pane = document.querySelector('[data-pane="dashboard"]');
          const dashTab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
          if (pane && pane.hidden && dashTab) dashTab.click();
          const f = document.getElementById("order-form");
          try { f.symbol.focus(); f.symbol.select(); } catch (e) {}
        },
      });
    }
    acts.push({
      label: "Toggle privacy mode", hint: "display",
      run: () => { const b = document.getElementById("privacy-toggle"); if (b) b.click(); },
    });
    acts.push({
      label: "Toggle light / dark theme", hint: "display",
      run: () => { const b = document.getElementById("theme-toggle"); if (b) b.click(); },
    });
    if (window.Theme) {
      acts.push({
        label: "Theme: follow system", hint: "display",
        run: () => { window.Theme.set("system"); },
      });
    }
    document.querySelectorAll("#ccy-toggle button").forEach((b) => {
      acts.push({ label: `Display currency: ${b.dataset.ccy}`, hint: "display", run: () => b.click() });
    });
    // Multi-chart actions — layout/display state only; none can reach a write.
    const gotoDash = () => {
      const pane = document.querySelector('[data-pane="dashboard"]');
      const tab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
      if (pane && pane.hidden && tab) tab.click();
    };
    MC_LAYOUT_IDS.forEach((id, k) => {
      if (mcState.layout !== id) {
        acts.push({
          label: `Chart layout: ${MC_LAYOUT_TITLES[id]}`, hint: `alt+${k + 1}`,
          run: () => { gotoDash(); mcSetLayout(id); },
        });
      }
    });
    MC_LINK_KINDS.forEach((kind) => {
      acts.push({
        label: `Charts: ${kind} sync ${mcState.links[kind] ? "off" : "on"}`, hint: "link",
        run: () => mcToggleLink(kind),
      });
    });
    acts.push({ label: "Add chart", hint: "charts", run: () => { gotoDash(); mcAddChart(); } });
    acts.push({ label: "Duplicate focused chart", hint: "charts", run: () => { gotoDash(); mcDuplicateChart(mcState.focus); } });
    acts.push({
      label: "Change chart symbol…", hint: "charts",
      run: () => {
        gotoDash();
        setTimeout(() => {
          const card = document.querySelector(`#mc-grid .mc-card[data-idx="${mcState.focus}"] [data-mc="sym"]`);
          if (card) mcOpenPicker(mcState.focus, card);
        }, 0);
      },
    });
    acts.push({ label: "Fullscreen focused chart", hint: "F", run: () => { gotoDash(); mcToggleChartFullscreen(mcState.focus); } });
    acts.push({ label: "Reset chart zoom (all)", hint: "R", run: mcResetZoomAll });
    mcState.slots.forEach((s, i) => {
      if (i !== mcState.focus) {
        acts.push({ label: `Focus chart ${i + 1}: ${s.symbol} ${mcIvLabel(s.interval)}`, hint: "charts", run: () => { gotoDash(); mcSetFocus(i); } });
      }
    });
    const expand = document.getElementById("chart-expand");
    if (expand) acts.push({ label: "Expand / collapse charts panel", hint: "esc exits", run: () => { gotoDash(); expand.click(); } });
    [["jn-refresh", "Refresh journal"],
     ["account-refresh", "Refresh account"]].forEach(([id, label]) => {
      const b = document.getElementById(id);
      if (b) acts.push({ label, hint: "read-only", run: () => b.click() });
    });
    // Journal actions — annotations only; nothing here can reach a trade write.
    const gotoJournal = () => {
      const pane = document.querySelector('[data-pane="history"]');
      const tab = document.querySelector('#tabs .tab[data-tab="history"]');
      if (pane && pane.hidden && tab) tab.click();
    };
    JN_VIEWS.forEach((v) => {
      if (_jnView.view !== v) {
        acts.push({ label: `Journal: ${JN_VIEW_LABELS[v]}`, hint: "journal", run: () => { gotoJournal(); jnSwitchView(v); } });
      }
    });
    acts.push({ label: "Journal: review next trade", hint: "queue", run: () => { gotoJournal(); setTimeout(jnReviewNext, 0); } });
    acts.push({ label: "Journal: search trades", hint: "notes/tags", run: () => { gotoJournal(); const s = document.getElementById("jn-search"); if (s) setTimeout(() => s.focus(), 0); } });
    acts.push({ label: "Journal: jump to today", hint: "calendar", run: () => { gotoJournal(); jnGotoDay(jnDayKey(Date.now())); } });
    const jl = document.getElementById("jn-labels");
    if (jl && !jl.hidden) acts.push({ label: "Journal: manage labels", hint: "tags", run: () => { gotoJournal(); setTimeout(jnOpenLabels, 0); } });
    // AI coach — read-only analysis; generation is admin-gated server-side too.
    const gotoAI = () => {
      const pane = document.querySelector('[data-pane="ai"]');
      const tab = document.querySelector('#tabs .tab[data-tab="ai"]');
      if (pane && pane.hidden && tab) tab.click();
    };
    AI_VIEWS.forEach((v) => {
      if (_aiView.view !== v) {
        acts.push({ label: `Coach: ${AI_VIEW_LABELS[v]}`, hint: "ai", run: () => { gotoAI(); aiSwitchView(v); } });
      }
    });
    if (state.role === "admin") {
      acts.push({ label: "Coach: generate briefing", hint: "ai", run: () => { gotoAI(); aiSwitchView("briefing"); setTimeout(aiGenerateBriefing, 0); } });
      acts.push({ label: "Coach: ask about my trading", hint: "ai", run: () => { gotoAI(); aiSwitchView("ask"); setTimeout(() => { const t = document.getElementById("ai-question"); if (t) t.focus(); }, 50); } });
    }
    // Execution ladder — display/navigation only (writes stay behind the
    // ticket/table ceremonies; the palette can never reach one).
    const exCenterBtn = document.getElementById("ex-center");
    if (exCenterBtn) acts.push({ label: "Ladder: center on market", hint: "L", run: () => { gotoDash(); exCenterBtn.click(); } });
    const exFollowBtn = document.getElementById("ex-follow");
    if (exFollowBtn) acts.push({ label: "Ladder: toggle follow / freeze", hint: "depth", run: () => { gotoDash(); exFollowBtn.click(); } });
    acts.push({ label: "Focus ladder", hint: "L", run: () => { gotoDash(); setTimeout(() => { const r = document.querySelector("#book-widget .book-row.clickable"); if (r) r.focus(); }, 0); } });
    // Watchlist actions — display/navigation only; none can reach a write.
    const gotoWatch = () => {
      const pane = document.querySelector('[data-pane="markets"]');
      const tab = document.querySelector('#tabs .tab[data-tab="markets"]');
      if (pane && pane.hidden && tab) tab.click();
    };
    acts.push({ label: "Add symbol to watchlist", hint: "A", run: () => { gotoWatch(); const s = document.getElementById("wl-search"); if (s) setTimeout(() => s.focus(), 0); } });
    acts.push({ label: "New watchlist", hint: "watch", run: () => { gotoWatch(); const b = document.getElementById("wl-new"); if (b) setTimeout(() => b.click(), 0); } });
    if (_wlDoc) {
      _wlDoc.lists.forEach((l) => {
        if (l.id !== _wlDoc.activeId) {
          acts.push({ label: `Watchlist: ${l.name}`, hint: "switch", run: () => { gotoWatch(); wlSwitchList(l.id); } });
        }
      });
      const active = wlActiveList();
      if (active) acts.push({ label: `Rename watchlist “${active.name}”`, hint: "watch", run: () => { gotoWatch(); const chip = document.querySelector(`#wl-lists .wl-chip[data-wlid="${CSS.escape(active.id)}"]`); if (chip) setTimeout(() => wlStartRenameChip(chip), 0); } });
      acts.push({ label: "Export watchlist", hint: "json", run: wlExportActive });
    }
    // Scanner actions — display/navigation only; none can reach a write.
    const gotoScan = () => {
      const pane = document.querySelector('[data-pane="scanner"]');
      const tab = document.querySelector('#tabs .tab[data-tab="scanner"]');
      if (pane && pane.hidden && tab) tab.click();
    };
    acts.push({ label: "Search markets (scanner)", hint: "F", run: () => { gotoScan(); const s = document.getElementById("sc-search"); if (s) setTimeout(() => s.focus(), 0); } });
    acts.push({ label: "New custom scan", hint: "scanner", run: () => { gotoScan(); setTimeout(() => scOpenScanBuilder(null), 0); } });
    acts.push({ label: "New scanner alert", hint: "notify only", run: () => { gotoScan(); setTimeout(() => scOpenAlert(null), 0); } });
    SC_PRESET_DEFS.forEach((p) => {
      if (_scView.preset !== p.id) {
        acts.push({ label: `Scanner: ${p.label.replace(/^★ /, "")}`, hint: "preset", run: () => { gotoScan(); scSetPresetForce(p.id); } });
      }
    });
    if (_scDoc) {
      _scDoc.scans.forEach((s) => {
        if (_scView.preset !== "scan:" + s.id) {
          acts.push({ label: `Scanner: ${s.name}`, hint: "custom scan", run: () => { gotoScan(); scSetPresetForce("scan:" + s.id); } });
        }
      });
    }
    acts.push({
      label: document.body.classList.contains("density-compact")
        ? "Table density: comfortable" : "Table density: compact",
      hint: "display", run: toggleDensity,
    });
    // Risk actions — display/notify-only; none can reach a write.
    acts.push({
      label: _rkArmed ? "Risk alerts: disarm" : "Risk alerts: arm", hint: "notify only",
      run: () => { const b = document.getElementById("rk-alerts-toggle"); if (b) b.click(); },
    });
    RK_ALLOC_VIEWS.forEach((v) => {
      if (_rkView.alloc !== v) {
        acts.push({
          label: `Risk allocation view: ${v}`, hint: "risk",
          run: () => {
            const tab = document.querySelector('#tabs .tab[data-tab="risk"]');
            if (tab && !tab.classList.contains("active")) tab.click();
            setTimeout(() => { const b = document.querySelector(`[data-rkalloc="${v}"]`); if (b) b.click(); }, 0);
          },
        });
      }
    });
    acts.push({
      label: "Notifications", hint: "log",
      run: () => { const b = document.getElementById("notif-btn"); if (b) b.click(); },
    });
    acts.push({ label: "Keyboard shortcuts", hint: "?", run: openKeysHelp });
    // Workspace actions — all layout/display state; none can reach a write.
    if (_wsDoc) {
      _wsDoc.workspaces.forEach((w) => {
        if (w.id !== _wsDoc.activeId) {
          acts.push({ label: `Workspace: ${w.name}`, hint: "switch", run: () => wsSwitch(w.id) });
        }
      });
    }
    acts.push({ label: "New workspace", hint: "layout", run: () => { const b = document.getElementById("ws-new"); wsOpenSwitcher(); if (b) b.click(); } });
    acts.push({ label: "Duplicate workspace", hint: "layout", run: () => { const b = document.getElementById("ws-dup"); if (b) b.click(); } });
    acts.push({ label: "Rename workspace", hint: "layout", run: () => wsOpenSwitcher(true) });
    acts.push({ label: "Export workspace", hint: "json", run: wsExportActive });
    acts.push({ label: "Import workspace…", hint: "json", run: () => { const f = document.getElementById("ws-import-file"); if (f) f.click(); } });
    acts.push({ label: "Save layout snapshot", hint: "layout", run: () => { const b = document.getElementById("ws-snap-save"); if (b) b.click(); } });
    acts.push({ label: "Restore layout snapshot", hint: "layout", run: () => { const b = document.getElementById("ws-snap-restore"); if (b) b.click(); } });
    acts.push({ label: "Reset workspace layout", hint: "layout", run: () => { const b = document.getElementById("ws-reset"); if (b) b.click(); } });
    const logout = document.getElementById("logout-btn");
    if (logout) acts.push({ label: "Log out", hint: "session", run: () => logout.click() });
    return acts;
  };

  const paint = () => {
    const q = input.value.trim().toLowerCase();
    items = buildActions().filter((a) => !q || a.label.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    listEl.innerHTML = items.length
      ? items.map((a, i) =>
          `<div class="cmdk-item${i === sel ? " sel" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}">` +
          `<span>${esc(a.label)}</span><span class="hint">${esc(a.hint)}</span></div>`
        ).join("")
      : `<div class="cmdk-empty">No matching command</div>`;
  };

  const close = () => {
    overlay.hidden = true;
    input.value = "";
    restoreFocus(prevFocus);
  };
  const open = () => {
    // Never stack over a live trade dialog — those own the keyboard.
    const confirmOv = document.getElementById("confirm-overlay");
    const tpslOv = document.getElementById("tpsl-overlay");
    if ((confirmOv && !confirmOv.hidden) || (tpslOv && !tpslOv.hidden)) return;
    prevFocus = document.activeElement;
    sel = 0;
    overlay.hidden = false;
    paint();
    input.focus();
  };
  const runSelected = () => {
    const action = items[sel];
    close();
    if (action) action.run();
  };

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
      e.preventDefault();
      if (overlay.hidden) open(); else close();
    }
  });
  const hintBtn = document.getElementById("cmdk-hint");
  if (hintBtn) hintBtn.addEventListener("click", open);
  input.addEventListener("input", () => { sel = 0; paint(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); runSelected(); }
  });
  listEl.addEventListener("click", (e) => {
    const it = e.target.closest(".cmdk-item[data-i]");
    if (!it) return;
    sel = Number(it.dataset.i);
    runSelected();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// ---------------------------------------------------------------------------
// Global keys — "/" jumps to the ticket, "B"/"S" jump to it with the side
// pre-selected (form state only — identical to clicking the segment), "?"
// opens the shortcut reference. NAVIGATION/PREFILL ONLY: no keyboard shortcut
// ever submits, modifies or cancels anything. All ignored while typing, and
// the ticket keys are inert for viewers (no ticket exists for them).
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.key === "?") { e.preventDefault(); openKeysHelp(); return; }
  const key = e.key.toLowerCase();
  // "W" opens the workspace switcher (search + arrows + digits inside). The
  // spec's Ctrl+1..9 / Ctrl+Shift+N/D/R were deliberately NOT bound: browsers
  // own them (tab switching, incognito, bookmark-all, hard-reload).
  if (key === "w") { e.preventDefault(); wsOpenSwitcher(); return; }
  // "F" focuses the scanner's market search — only while the Scan tab is
  // visible, so the key keeps its normal meaning everywhere else.
  if (key === "f") {
    const scanPane = document.querySelector('[data-pane="scanner"]');
    if (scanPane && !scanPane.hidden) {
      e.preventDefault();
      const s = document.getElementById("sc-search");
      if (s) { try { s.focus(); s.select(); } catch (err) {} }
      return;
    }
  }
  // "A" jumps to the watchlist add-symbol search: switch to the Watch tab if
  // needed, then focus the search field. Navigation only.
  if (key === "a") {
    e.preventDefault();
    const watchTab = document.querySelector('#tabs .tab[data-tab="markets"]');
    const pane = document.querySelector('[data-pane="markets"]');
    if (pane && pane.hidden && watchTab) watchTab.click();
    const s = document.getElementById("wl-search");
    if (s) { try { s.focus(); } catch (err) {} }
    return;
  }
  // "L" / "O" / "P": focus the ladder / first order row / first position row
  // on the Trade tab. Pure navigation — activation still runs the existing
  // Enter/Space handlers (and any write still runs the full ceremony).
  if (key === "l" || key === "o" || key === "p") {
    const dashPane = document.querySelector('[data-pane="dashboard"]');
    if (dashPane && !dashPane.hidden) {
      const target = key === "l"
        ? document.querySelector("#book-widget .book-row.clickable")
        : document.querySelector(key === "o" ? "#orders-body tr.exp-row" : "#positions-body tr.exp-row");
      if (target) {
        e.preventDefault();
        try { target.focus(); target.scrollIntoView({ block: "nearest" }); } catch (err) {}
        return;
      }
    }
  }
  if (e.key !== "/" && key !== "b" && key !== "s") return;
  const form = document.getElementById("order-form");
  if (!form) return;
  e.preventDefault();
  const pane = document.querySelector('[data-pane="dashboard"]');
  if (pane && pane.hidden) {
    const dashTab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
    if (dashTab) dashTab.click();
  }
  if (key === "b" || key === "s") {
    form.side.value = key === "b" ? "Buy" : "Sell";
    form.side.dispatchEvent(new Event("change", { bubbles: true })); // repaints segment + submit
  }
  try {
    // "/" (or an empty ticket) → symbol; a ready ticket with B/S → quantity.
    const target = e.key === "/" || !form.symbol.value.trim() ? form.symbol : form.qty;
    target.focus();
    if (target === form.symbol) target.select();
  } catch (err) { /* focus is best-effort */ }
});

// Arrow-key navigation between focused table rows (dashboard grids): the rows
// are already focusable buttons (Enter expands); ↑/↓ now moves between them.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const row = e.target && e.target.closest &&
    e.target.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (!row || e.target !== row) return;
  e.preventDefault();
  let next = row;
  do {
    next = e.key === "ArrowDown" ? next.nextElementSibling : next.previousElementSibling;
  } while (next && !next.classList.contains("exp-row"));
  if (next) next.focus();
});

// ---------------------------------------------------------------------------
// Icon-button tooltips — instant, styled hover labels.
//
// Icon-only controls (chart toolbar, row actions, ladder tools, quick actions)
// carry a `title`, but the native tooltip waits ~1s, renders unstyled, and is
// easy to miss on a dense trading surface. This engine shows the SAME text
// immediately in a styled bubble.
//
// Contract: on first hover the `title` is MOVED to `data-tip` so the browser
// stops drawing its own tooltip (no double bubble) — and, when the control has
// no `aria-label`, the text is promoted to one so screen readers keep it. One
// delegated listener covers every current and future button, including the
// dashboard's constantly re-rendered rows, with zero per-render work.
//
// Scope is deliberately `button` elements only: row/ladder targets are
// `[role="button"]` divs whose titles are long hints, and popping a bubble on
// every ladder row hover would fight the trader, not help them.
// ---------------------------------------------------------------------------
let _tipEl = null;
let _tipFor = null;

function tipText(el) {
  if (!el) return "";
  const native = el.getAttribute("title");
  if (native) {
    el.setAttribute("data-tip", native);
    el.removeAttribute("title"); // suppress the duplicate native tooltip
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", native);
  }
  return el.getAttribute("data-tip") || "";
}

function hideTip() {
  _tipFor = null;
  if (_tipEl) _tipEl.classList.remove("on");
}

function showTip(el) {
  const text = tipText(el);
  if (!text) return;
  if (!_tipEl) {
    _tipEl = document.createElement("div");
    _tipEl.className = "tipbox";
    _tipEl.setAttribute("aria-hidden", "true"); // the control's own label serves AT
    document.body.appendChild(_tipEl);
  }
  _tipFor = el;
  _tipEl.textContent = text;
  // Measure with the bubble laid out but invisible, then place it.
  _tipEl.style.left = "0px";
  _tipEl.style.top = "0px";
  _tipEl.classList.add("on");
  const r = el.getBoundingClientRect();
  const t = _tipEl.getBoundingClientRect();
  const gap = 7;
  let top = r.top - t.height - gap;
  if (top < 4) top = r.bottom + gap; // no room above → flip below
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
  _tipEl.style.left = Math.round(left) + "px";
  _tipEl.style.top = Math.round(top) + "px";
}

function wireTooltips() {
  const target = (e) => e.target && e.target.closest
    ? e.target.closest("button[title], button[data-tip]") : null;

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return; // touch has no hover; taps just act
    const el = target(e);
    if (!el || el === _tipFor) return; // already showing for this control
    showTip(el);
  });
  // Hiding is driven by pointermove rather than pointerout: pointerout also
  // fires when crossing INTO a child (the icon svg), which would flicker the
  // bubble, and it never fires at all when a re-render removes the hovered
  // button from under the cursor (the dashboard rebuilds rows every few
  // seconds) — an `isConnected` check catches that too. The handler only does
  // work while a tip is actually up.
  document.addEventListener("pointermove", (e) => {
    if (!_tipFor) return;
    if (!_tipFor.isConnected || !_tipFor.contains(e.target)) hideTip();
  });
  document.addEventListener("pointerleave", hideTip); // cursor left the window
  // A press acts on the control — the label has served its purpose.
  document.addEventListener("pointerdown", hideTip, true);
  // Keyboard parity: only for keyboard-visible focus, so clicking a button
  // doesn't leave a bubble hanging over the UI.
  document.addEventListener("focusin", (e) => {
    const el = target(e);
    if (!el) return;
    try { if (!el.matches(":focus-visible")) return; } catch (err) { return; }
    showTip(el);
  });
  document.addEventListener("focusout", (e) => {
    if (target(e) === _tipFor) hideTip();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
  // Any layout shift invalidates the anchor position.
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    await loadMe();
  } catch (e) {
    window.location.href = "/login";
    return;
  }
  wireAdminForms();
  wireExplorer();
  wireTabs();
  wireMarketsHistory();
  wireWatchlist(); // Watchlist & market monitor (loads _wlDoc BEFORE workspaces apply their saved view)
  wireScanner(); // Market scanner (loads _scDoc BEFORE workspaces apply their saved view)
  wireCharts(); // live candlestick charts (read-only; polls while dashboard visible)
  wireRisk(); // risk command center (feeds off the shared dashboard snapshot)
  wirePnl(); // unrealised-PnL history tab (Redis-backed series via /api/upnl)
  wireJournal(); // trading journal (loads on tab entry; BEFORE workspaces apply their saved view)
  wireAI(); // AI coach (read-only intelligence layer; loads on tab entry)
  wireExec(); // execution workspace (ladder/previews/quick actions on the Trade tab)
  wireWorkspaces(); // multi-workspace system: load/migrate, apply active layout
  wireCommandPalette(); // Ctrl/Cmd+K — navigation & display actions only
  wireNotifCenter(); // session notification log (every toast, recoverable)
  wireKeysHelp(); // "?" shortcut reference
  wireTooltips(); // instant hover labels on icon-only buttons
  wirePrivacyToggle(); // restore saved privacy state BEFORE the first render (no flash)
  wireThemeToggle(); // theme.js already painted it pre-paint; this wires the button
  wireCurrencyToggle(); // restore saved currency BEFORE the first render
  renderLoading(); // skeleton rows until the first snapshot lands
  updateSizingAvail();
  // Render an immediate snapshot, then rely on the WS for live updates.
  try {
    const d = await api("/api/dashboard");
    renderDashboard(d);
  } catch (e) {}
  connectWS();
  startConnWatchdog(); // escalate the pill to "stale" if frames stop arriving
  // The dashboard is the HTML-default active tab, so wireTabs' activation
  // hook never fires for it at boot — arm the execution panel's day-window
  // refresh here (it self-cancels the moment the pane hides).
  const dashPane = document.querySelector('[data-pane="dashboard"]');
  if (dashPane && !dashPane.hidden) onExecActive();
  syncHeaderHeight();
  // Throttle to one measurement per frame so a resize drag doesn't thrash layout.
  let _rhTick = false;
  window.addEventListener("resize", () => {
    if (_rhTick) return;
    _rhTick = true;
    requestAnimationFrame(() => { _rhTick = false; syncHeaderHeight(); });
  });
})();
