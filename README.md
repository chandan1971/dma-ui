# DMA Terminal

A self-hosted trading dashboard for the **CoinSwitch DMA** (Bybit-V5-style)
futures API. It exposes a clean web UI with **real-time** positions, open
orders and live PnL (pushed over a WebSocket, no page refresh), plus order
placement, cancellation and leverage controls.

The API key/secret never reach the browser — every request is signed
server-side using the same Ed25519 scheme as the original `sign_server.py`.
All credentials live in environment variables.

## Features

- 🔐 **Username/password login** with two roles:
  - **admin** — full trading (place market/limit orders, cancel, cancel-all,
    set leverage, close positions fully or partially)
  - **viewer** — read-only (positions, open orders, live PnL, equity)
- 📈 **Live dashboard** over WebSocket: total unrealised PnL, per-position PnL,
  open orders, wallet equity — one shared server-side poll, fanned out to every
  connected tab every few seconds.
- 🧮 **Docked order ticket** (admin): market / limit orders, size by quantity or
  by margin (%-of-balance presets, real account leverage), attached TP/SL,
  reduce-only, live order-book ladder with click-to-fill, instrument spec strip.
- ✂️ **Partial close**: close 25 / 50 / 75 / 100% of a position — the server
  re-derives the live size and floors the slice to the instrument's lot step.
- 🕯️ **Multi-chart workspace**: TradingView-style chart grid on the dashboard —
  eight layouts (1 / 2 side-by-side / 2 stacked / focus+2 / 2×2 / 3×2 / 4×2 /
  3×3, `⌥1–8`), each chart with its **own symbol, interval (1m–1D), zoom and
  pan** (wheel zooms, drag pans history, double-click resets). Symbol search
  covers the whole live universe (recents + watchlist + all markets); charts
  can be **linked** (symbol / interval / crosshair / zoom sync, opt-out per
  chart), swapped by drag, resized at the seams, duplicated, screenshotted to
  PNG, and taken fullscreen per chart or per panel. Everything (layout, slots,
  links, track sizes, fullscreen) persists **per workspace**. Data stays
  shared: N charts on one market cost one poll (public Bybit klines via an
  unsigned, server-validated proxy — see the region note below), and cadence
  follows the candle interval.
- 🛡️ **Risk command center** (the *Risk* tab): a portfolio risk dashboard fed
  by the SAME live snapshot the tables render (zero extra polling). Weighted
  0–100 **risk score** with an explained factor breakdown (margin utilization,
  liquidation proximity, portfolio leverage, concentration, unrealized loss —
  weights renormalize over the factors actually available, nothing is ever
  fabricated), KPI strip (equity, available/used margin, realized today,
  portfolio leverage, account MM rate), exposure & allocation (donut / bars /
  PnL-heat map), concentration meters (largest / top-3 / HHI), per-position
  liquidation-distance heat bars, margin utilization meter with 70/90% alert
  ticks, a sortable position-risk table (exchange `positionIM` used verbatim,
  estimates marked "~"), daily realized stats + fees/funding from the history
  mirror, session drawdown/equity tracking, a risk-event timeline, and
  session-local history sparklines. **Risk alerts** (margin ≥70/90%, liq <10/5%,
  score critical, concentration, large loss, high leverage) fire as toasts +
  notification-center entries with hysteresis and a 15-min cooldown — armable/
  disarmable, and **never** able to place, modify or cancel an order. Every
  figure is labeled exchange-actual vs derived vs session-local; view choices
  persist per workspace.
- 🔎 **Market Scanner** (the *Scan* tab): a live intelligence dashboard over the
  whole tradable universe. A background sampler polls the full ticker list —
  **one** read-only request per `SCANNER_SAMPLE_INTERVAL` (default 10 s) no
  matter how many tabs are open — and keeps a rolling in-memory history so the
  UI can show 5m/15m/1h changes, realized volatility, volume acceleration and
  funding drift *honestly* (a metric renders as "—" until its window has warmed
  up or if the venue doesn't supply it; nothing is fabricated). Includes
  overview cards (top movers/losers, volume, volatility, funding, recently
  active, watchlist movers, recent alerts — collapsible & drag-to-rearrange), a
  virtualized sortable screener with fuzzy search, numeric filters, built-in
  presets (momentum, breakouts, mean-reversion, high volume, caps, …), a saved
  **custom-scan rule builder** (AND/OR conditions over any metric), and
  **scanner alerts** (enters top-N movers, volume doubles, volatility / 15m
  move / funding thresholds) that notify via toasts + the notification center —
  alerts and every other scanner control are display-only and can never place,
  modify or cancel an order. Sorting, filters, preset, card layout, selection
  and scroll position are remembered **per workspace**.
- 📈 **Unrealised-PnL history** (the *PnL* tab): a background sampler reads the
  account's positions every `UPNL_SAMPLE_INTERVAL` (default 5 s) — **one**
  signed read-only request per interval no matter how many tabs are open — sums
  the total unrealised PnL and persists the series in **Redis** (Railway's
  Redis service via `REDIS_URL`). The tab charts it over 1H/6H/1D/7D/30D/ALL
  with a zero-split green/red area, per-bucket hi/lo band and crosshair
  tooltip, plus stat cards for the current value (live off the shared WS
  snapshot), the window's max unrealised PnL / max unrealised loss (computed
  server-side over FULL-resolution data, never the downsampled drawing) and
  the all-time peak/trough. Retention is budgeted for Railway's 500 MB Redis:
  raw 5s samples for 7 days, 1-min OHLC rollups for 60 days, 1-hour rollups
  for 2 years (~22 MB at full retention, `MAXLEN`-trimmed on every write). A
  Redis or exchange outage leaves an honest gap — nothing is interpolated.
- 🗄️ **History tab backed by MongoDB**: a background sync mirrors executions and
  closed PnL into Mongo every minute (cursor-free, time-windowed); the UI reads
  only the mirror, with range presets / custom dates / overall, an equity curve,
  win-rate and fee analytics, and a "last synced" freshness cue.
- 🔔 **Telegram alerts** (opt-in): order fills, TP/SL executions, liquidations —
  plus an operational alert if the history sync wedges.
- 👁️ **Privacy toggle** (masks account figures) and a **USDT/INR display lens**
  (read-only views convert at a configured `INR_RATE`; every write surface stays
  USDT — nothing sent to the exchange is ever converted).
- ⚙️ **Account controls** (admin): leverage, margin mode, funds transfer (with
  client-owned idempotency keys and positive success confirmation).
- 🔒 Keys stay server-side; requests are Ed25519-signed in the backend.

## Tech

Single **FastAPI** service (Python). Serves the static frontend (vanilla JS, no
build step), proxies + signs all DMA calls, streams the live feed over `/ws`,
and runs the background history sync + Telegram watcher in-process. One
process, one Railway service — the only external dependency is MongoDB for the
history mirror.

## Project layout

```
app/
  main.py          FastAPI routes, auth gates, WebSocket broadcast feed
  config.py        env-var configuration
  signer.py        Ed25519 request signing
  dma_client.py    async CoinSwitch DMA client (+ windowed history fetching)
  auth.py          login + signed-cookie sessions + per-role single session
  db.py            MongoDB access layer (history mirror)
  history_sync.py  background sync: exchange history -> MongoDB (every minute)
  notifier.py      Telegram execution alerts + operational alerts (opt-in)
  scanner.py       market-scanner engine: shared ticker sampler + rolling
                   history + metric providers (serves /api/scanner from memory)
  upnl.py          unrealised-PnL tracker: positions sampler -> Redis streams
                   (raw + 1m/1h rollups + all-time extremes; serves /api/upnl)
  market_data.py   public kline proxy for the charts (unsigned; static
                   allowlist + scanner-observed live universe)
  static/          login.html, index.html, app.js, charts.js, risk.js,
                   pnl.js, styles.css (charts.js = multi-chart workspace,
                   risk.js = risk command center, pnl.js = unrealised-PnL
                   history tab; all feed off shared data, no extra polling)
tests/             pytest suite (+ tests/test_snap.mjs money-math regression)
requirements.txt / requirements-dev.txt
Procfile / railway.json   start command for Railway
.env.example   all environment variables, documented
```

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick this repo.
   Railway auto-detects Python (Nixpacks) and uses the start command in
   `railway.json` / `Procfile`.
3. Open the service → **Variables** and set everything from `.env.example`:
   - `DMA_API_KEY`, `DMA_API_SECRET` (your DMA key + Ed25519 secret hex)
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   - `VIEWER_USERNAME`, `VIEWER_PASSWORD`
   - `SESSION_SECRET` (a long random string —
     `python -c "import secrets;print(secrets.token_hex(32))"`)
   - `TRADE_TOKEN` (second secret gating every write; unset = writes disabled)
   - `MONGO_URI` (+ `MONGO_USERNAME`/`MONGO_PASSWORD`, `MONGO_DB_NAME`, and one
     of `MONGO_TLS_CA_FILE`/`MONGO_TLS_CA_PEM`) for the history mirror
   - optional: `DMA_BASE_URL`, `CATEGORY`, `SETTLE_COIN`, `ACCOUNT_TYPE`,
     `POLL_INTERVAL`, `INR_RATE`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
     `SYNC_INTERVAL_SECONDS`, `SYNC_BACKFILL_DAYS`, `TRUSTED_PROXY_HOPS`,
     `CHART_SYMBOLS`, `SCANNER_SAMPLE_INTERVAL`, `SCANNER_ENABLED`,
     `REDIS_URL` (= `${{Redis.REDIS_URL}}` after adding Railway's Redis
     service; enables the PnL tab's history), `UPNL_SAMPLE_INTERVAL`,
     `UPNL_ENABLED` — every variable is documented in `.env.example`
4. Railway gives the service a public URL. Open it → log in.

> `$PORT` is provided by Railway automatically; the start command already
> binds to it.

> **Region note:** the Live Charts use Bybit's public kline API, which is
> geo-blocked from US hosts. Deploy in a non-US region (Singapore confirmed
> working); the signed DMA endpoints are unaffected either way.

### Health check

`GET /healthz` returns whether all required env vars are configured, plus
`historySyncAgeSeconds` per history collection — seconds since each Mongo
mirror last completed a sync (normally under ~2× `SYNC_INTERVAL_SECONDS`; a
climbing value means the sync is wedged and the History tab is going stale) —
and `scannerAgeSeconds` (seconds since the market scanner's last ticker
sample; normally ≈ `SCANNER_SAMPLE_INTERVAL`, null before the first sample or
when the scanner is disabled), and `upnlAgeSeconds` (seconds since the
unrealised-PnL tracker last persisted a sample to Redis; normally ≈
`UPNL_SAMPLE_INTERVAL`, null before the first sample or when `REDIS_URL` is
unset).

### Running the tests

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest -q                      # backend suite
node --check app/static/app.js # frontend syntax
node tests/test_snap.mjs       # money-math regression
```

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit .env with real values
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 and log in.

> The cookie is set with `Secure`, so it is only sent over HTTPS. Railway
> serves HTTPS so this works in production. For local HTTP testing, use
> `localhost` in a browser that allows Secure cookies on localhost (Chrome
> does), or temporarily flip `secure=False` in `app/main.py`'s `set_cookie`
> call.

## Trading safety controls

Because real money is at stake, every write operation (place / cancel / close
order, cancel-all, set leverage, set margin mode, transfer funds) is protected
by **three independent gates**:

1. **Admin session** — you must be logged in as the admin role.
2. **Trade token** — a second secret (`TRADE_TOKEN`, separate from the admin
   password) that you paste into the dashboard's *Trade Token* field. It is
   sent as the `X-Trade-Token` header with each write and verified server-side
   (constant-time). **Fail-closed:** if `TRADE_TOKEN` is unset on the server,
   *no* write can happen. The token is held only in the browser tab's memory —
   never stored — so it must be re-entered after a refresh.
3. **Typed confirmation** — before a write executes, a modal requires you to
   type the word **confirm**. Nothing is sent until you do. (Exception: *Set
   Leverage* skips this prompt for convenience — it still requires the admin
   session **and** the trade token, and moves no funds itself.)

Submit buttons are also disabled while a write is in flight to prevent
accidental double-submission.

**Audit trail:** every write (and every login attempt) emits one JSON line on
the `dma-ui.audit` logger — action, user, role, client IP, the sanitized
outbound body, and the outcome (exchange orderId / txn id, or the rejection).
It answers "who did what, from where, and what did the exchange say" after any
incident; secrets never appear in it. Lines go to stdout, so Railway retains
them with the app logs.

**Ambiguous order timeouts:** if the exchange does not answer an order
submission (network timeout / gateway 5xx), the error explicitly warns that the
order **may still have been placed** and to check Open Orders before retrying —
a blind resubmit is the classic double-execution mistake. Optionally set
`SEND_ORDER_LINK_ID=1` (after one live verification — see `.env.example`) to
tag every order with a server-generated id that the error message and audit log
reference.

## Security notes

- API key/secret, login passwords and the trade token are **only** read from
  env vars — nothing is hard-coded.
- Write endpoints require admin role **and** a valid trade token, server-side.
  The custom `X-Trade-Token` header also blocks cross-site (CSRF) writes.
- Session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`; the WebSocket
  rejects cross-origin handshakes.
- **Single active session per role:** at most one `admin` and one `viewer`
  session are active at once. A new login evicts the previous session **of the
  same role only** — the old tab is redirected to `/login` (within one live-feed
  cycle, ~`POLL_INTERVAL`s, or on its next request) — so a viewer login can
  never knock the trading admin offline. The active session id is tracked **in
  memory**, which means: run exactly **one Railway replica**, and a
  restart/redeploy logs everyone out (just log back in). No security downside —
  the cookie itself stays cryptographically signed.
- The signing scheme was ported into `app/signer.py`; the old standalone
  `sign_server.py` helper is **not** part of the app (not imported, not in the
  Procfile, not in `requirements.txt`) and has been removed from the working
  tree. `dma-api.json` remains as a gitignored local reference copy of the API
  spec. If a real secret ever lived in either file, **rotate it** regardless.
- **Brute force:** credential and trade-token checks are constant-time, **and**
  `/api/login` + `/api/verify-trade-token` are rate-limited in-app (failed
  attempts per client IP; cleared on success so a legitimate operator is never
  locked out). Behind Railway's single proxy the client IP is taken from the
  **rightmost** `X-Forwarded-For` hop (the value the trusted proxy appends),
  which the client cannot forge. **If you put an edge proxy in front** (e.g.
  Cloudflare → Railway), set `TRUSTED_PROXY_HOPS=2` so the real client IP is used
  instead of collapsing every client into one shared bucket (which one attacker
  could then use to lock everyone out). An edge limiter (Cloudflare / Railway) is
  still recommended as defense in depth, along with **strong, high-entropy**
  values for `ADMIN_PASSWORD`, `VIEWER_PASSWORD` and `TRADE_TOKEN` (the trade
  token in particular should stay a long random string, e.g.
  `secrets.token_hex(24)`).

## Integrated endpoints

Every endpoint from the Postman collection is wired in. Reads are available to
both roles; writes are **admin-only** (the viewer gets `403`).

**Reads** (dashboard + API Explorer): wallet balance, withdrawable amount,
account info, server time, open positions, open orders, instruments info,
tickers, order book, closed PnL, trades/execution history. Closed PnL and
executions are served from the **MongoDB mirror** (kept fresh by the in-process
sync); every other read hits the exchange live.

**Writes** (admin panel): create order (market/limit, optional attached
take-profit / stop-loss, optional time-in-force — GTC/IOC/FOK/Post-Only on
limit orders), set TP/SL on an existing position
(`/v5/position/trading-stop`, Full mode, positionIdx re-derived from the live
position), cancel order, amend (cancel + edit in the ticket), cancel-all,
close position (fully, or a 25/50/75% slice — size re-derived live and floored
to the lot step server-side), set leverage, set margin mode, transfer funds.

**Projected PnL at TP/SL:** Bybit exposes no projected-PnL field, so it is
computed client-side as `(exit − entry) × size` (linear; sign-flipped for
shorts) **minus the exit fee** (taker 0.035%, since Full-mode TP/SL are market
exits). The entry fee is excluded (it's already in an open position's realised
PnL). Shown under the TP/SL columns, live in the TP/SL modal, and in the order
form (with ROI% where leverage is known). Figures are net of the exit fee only;
funding is not included.

The **API Explorer** panel calls any read endpoint ad-hoc (with an optional
symbol) and renders the result as a **formatted table** (with a collapsible
"Raw JSON" view underneath each result).

> Not yet integrated: `POST /v5/position/switch-mode` (one-way ↔ hedge). It's a
> real-money write and its exact params weren't confirmed, so it was left out
> pending verification — easy to add on request.

> The two `loadtest.coinswitch.co/ledger/query-balance` items in the
> collection were intentionally **not** integrated: they target a different
> host and use a static `x-auth-token` (now redacted) rather than the
> API-key/Ed25519 signing this app uses. Tell me if you actually need them.

## Notes on real-time PnL

The DMA collection is REST-only (no exchange WebSocket). The backend therefore
polls `/v5/position/list`, `/v5/order/realtime` and `/v5/account/wallet-balance`
every `POLL_INTERVAL` seconds (default 5) and pushes the aggregated snapshot to
all connected browsers over `/ws`. The poll is **shared**: one snapshot per
interval is built and fanned out to every connected tab, so the upstream cost
stays constant no matter how many dashboards are open (and drops to zero when
none are). Unrealised PnL comes from the position feed's `unrealisedPnl`
(mark-price based).
