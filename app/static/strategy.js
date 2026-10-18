// ===========================================================================
// STRATEGY — the "Bot" tab: one row per trade on the strategy symbols, built
// server-side from the REAL fills
// (/api/strategy/trades, straight from the exchange's fill history — last
// 30 days, no database). Entry / exit are average fill prices; Realised is net
// of all fees paid; Unrealised is at the live mark, before the exit fee. A
// position opened before the window shows its entry as unknown.
//
// Loaded BEFORE app.js: only defines consts + functions. app.js's tab switcher
// calls onStrategyActive() / clears _stTimer. Shared helpers (api, esc,
// fmtNum, fmtMoney, fmtMoneySigned, pnlClass, fmtTime) resolve at call time.
// READ-ONLY: nothing here can reach a write endpoint.
// ===========================================================================
const ST_REFRESH_MS = 15000;
let _stTimer = null;

function stCell(label, html, cls) {
  return `<td data-label="${label}" class="mono ${cls || ""}">${html}</td>`;
}

function stPnl(label, v) {
  if (v === null || v === undefined) return stCell(label, "—");
  return stCell(label, fmtMoneySigned(v, 4), pnlClass(v));
}

function stRow(t) {
  return `<tr>
    ${stCell("Symbol", esc(t.symbol))}
    ${stCell("Side", esc(t.side), t.side === "LONG" ? "pos" : "neg")}
    ${stCell("Status", esc(t.status))}
    ${stCell("Opened", t.entryBeforeWindow ? `<span class="muted">before window</span>` : fmtTime(t.openedMs))}
    ${stCell("Qty", fmtNum(t.qty, 4))}
    ${stCell("Entry", t.entryPrice === null ? `<span class="muted" title="Opened before the history window">?</span>` : fmtNum(t.entryPrice, 4))}
    ${stCell("Exit", t.exitPrice === null ? (t.markPrice ? `<span class="muted">mark ${fmtNum(t.markPrice, 4)}</span>` : "—") : fmtNum(t.exitPrice, 4))}
    ${stCell("Closed", t.closedMs ? fmtTime(t.closedMs) : "—")}
    ${stCell("Fees", fmtMoney(t.fees, 4))}
    ${stPnl("Realised", t.realisedPnl)}
    ${stPnl("Unrealised", t.unrealisedPnl)}
    ${stPnl("Net", t.netPnl)}
  </tr>`;
}

async function stLoad() {
  const status = document.getElementById("st-status");
  const body = document.getElementById("st-body");
  const tot = document.getElementById("st-totals");
  try {
    const [d, cfg] = await Promise.all([api("/api/strategy/trades"), api("/api/strategy")]);
    const mode = !cfg.enabled ? "disabled" : (cfg.live ? "LIVE" : "dry-run");
    status.textContent = `Bot ${mode} · last ${d.days} days` +
      (d.truncated ? " · history truncated (partial)" : "") +
      ` · updated ${new Date().toLocaleTimeString()}`;
    body.innerHTML = d.trades.length
      ? d.trades.map(stRow).join("")
      : `<tr><td colspan="12" class="muted">No strategy trades yet.</td></tr>`;
    const t = d.totals;
    tot.innerHTML =
      `${t.trades} trades (${t.open} open) · fees <span class="mono">${fmtMoney(t.fees, 4)}</span>` +
      ` · realised <span class="mono ${pnlClass(t.realisedPnl)}">${fmtMoneySigned(t.realisedPnl, 4)}</span>` +
      ` · unrealised <span class="mono ${pnlClass(t.unrealisedPnl)}">${fmtMoneySigned(t.unrealisedPnl, 4)}</span>` +
      ` · net <span class="mono ${pnlClass(t.netPnl)}">${fmtMoneySigned(t.netPnl, 4)}</span>`;
  } catch (e) {
    status.textContent = `Could not load strategy trades: ${e.message}`;
  }
}

function onStrategyActive() {
  stLoad();
  clearInterval(_stTimer);
  _stTimer = setInterval(stLoad, ST_REFRESH_MS);
}
