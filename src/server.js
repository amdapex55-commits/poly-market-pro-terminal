#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

const cfg = {
  port: numberEnv("PORT", 8788),
  paperBankroll: numberEnv("PAPER_BANKROLL", 1000),
  maxStake: numberEnv("MAX_STAKE", 50),
  maxEndHours: numberEnv("MAX_END_HOURS", 24),
  hedgeMinCost: numberEnv("HEDGE_MIN_COST", 1.0),
  hedgeMaxCost: numberEnv("HEDGE_MAX_COST", 1.05),
  minNetCash: numberEnv("MIN_NET_CASH", 100),
  minTradeEdge: numberEnv("MIN_TRADE_EDGE", 1),
  scanIntervalMs: numberEnv("SCAN_INTERVAL_MS", 12000),
  marketsLimit: numberEnv("MARKETS_LIMIT", 500),
  pageSize: numberEnv("PAGE_SIZE", 100),
  booksChunk: numberEnv("BOOKS_CHUNK", 100),
  walletLookbackSec: numberEnv("WALLET_LOOKBACK_SEC", 900),
  walletsPerMarket: numberEnv("WALLETS_PER_MARKET", 250),
  scoutMarkets: numberEnv("SCOUT_MARKETS", 12),
  cooldownMin: numberEnv("COOLDOWN_MIN", 20),
};

const files = {
  state: path.join(DATA_DIR, "paper-state.json"),
  trades: path.join(DATA_DIR, "paper-trades.ndjson"),
  snapshots: path.join(DATA_DIR, "snapshots.ndjson"),
};

const runtime = {
  startedAt: Date.now(),
  cycle: 0,
  scanning: false,
  lastScanAt: null,
  nextScanAt: null,
  elapsedMs: 0,
  markets: [],
  signals: [],
  trades: [],
  walletStats: new Map(),
  seenTx: new Set(),
  errors: [],
};

const paper = loadPaperState();

ensureDir(DATA_DIR);
scanLoop();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res);
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, statusPayload());
    if (req.method === "POST" && url.pathname === "/api/manual/open-best") return json(res, openBest());
    if (req.method === "POST" && url.pathname === "/api/manual/open") return json(res, openManual(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/manual/close") return json(res, closeManual(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/manual/settle") return json(res, settleManual(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/scan-now") {
      await scanOnce();
      return json(res, statusPayload());
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    runtime.errors.unshift(`${new Date().toISOString()} ${err.stack || err.message}`);
    runtime.errors = runtime.errors.slice(0, 10);
    json(res, { ok: false, error: err.message }, 500);
  }
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`Polymarket Pro Terminal running at http://127.0.0.1:${cfg.port}`);
});

async function scanLoop() {
  await scanOnce();
  setInterval(scanOnce, Math.max(3000, cfg.scanIntervalMs));
}

async function scanOnce() {
  if (runtime.scanning) return;
  runtime.scanning = true;
  const started = Date.now();
  try {
    const markets = await fetchMarkets();
    await attachBooks(markets);
    runtime.markets = markets;
    await updateWalletProfiles(markets.slice(0, cfg.scoutMarkets));
    markPaperPositions(markets);
    runtime.signals = buildSignals(markets).slice(0, 30);
    runtime.trades = readRecentTrades();
    runtime.cycle += 1;
    runtime.lastScanAt = new Date().toISOString();
    runtime.nextScanAt = new Date(Date.now() + cfg.scanIntervalMs).toISOString();
    runtime.elapsedMs = Date.now() - started;
    savePaperState();
    writeSnapshot();
  } catch (err) {
    runtime.errors.unshift(`${new Date().toISOString()} ${err.stack || err.message}`);
    runtime.errors = runtime.errors.slice(0, 10);
  } finally {
    runtime.scanning = false;
  }
}

async function fetchMarkets() {
  const out = [];
  for (let offset = 0; out.length < cfg.marketsLimit; offset += cfg.pageSize) {
    const url = new URL("/markets", GAMMA);
    url.searchParams.set("limit", String(Math.min(cfg.pageSize, cfg.marketsLimit - out.length)));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("closed", "false");
    url.searchParams.set("active", "true");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows.map(normalizeMarket));
    if (rows.length < cfg.pageSize) break;
  }
  return out
    .filter((m) => m.tokens.length === 2)
    .filter((m) => m.acceptingOrders !== false && m.enableOrderBook !== false)
    .filter((m) => withinEndWindow(m));
}

function normalizeMarket(row) {
  return {
    id: String(row.id ?? ""),
    question: row.question ?? row.title ?? "Untitled market",
    conditionId: row.conditionId,
    slug: row.slug,
    eventSlug: row.events?.[0]?.slug,
    outcomes: parseMaybeJson(row.outcomes).map(String),
    tokens: parseMaybeJson(row.clobTokenIds).map(String),
    volume24hr: finite(row.volume24hrClob ?? row.volume24hr),
    liquidity: finite(row.liquidityClob ?? row.liquidity),
    acceptingOrders: row.acceptingOrders,
    enableOrderBook: row.enableOrderBook,
    endDate: row.endDateIso ?? row.endDate,
    books: [],
  };
}

function withinEndWindow(market) {
  if (!market.endDate) return false;
  const end = Date.parse(market.endDate);
  if (!Number.isFinite(end)) return false;
  const hours = (end - Date.now()) / 3600000;
  return hours >= 0 && hours <= cfg.maxEndHours;
}

async function attachBooks(markets) {
  const tokenToMarket = new Map();
  for (const market of markets) for (const token of market.tokens) tokenToMarket.set(token, market);
  const tokens = [...tokenToMarket.keys()];
  for (const chunk of chunks(tokens, cfg.booksChunk)) {
    const books = await postJson(`${CLOB}/books`, chunk.map((token_id) => ({ token_id })));
    for (const book of books || []) {
      const market = tokenToMarket.get(String(book.asset_id));
      if (market) market.books.push(book);
    }
  }
}

async function updateWalletProfiles(markets) {
  const cutoff = Math.floor(Date.now() / 1000) - cfg.walletLookbackSec;
  for (const market of markets) {
    const url = new URL("/trades", DATA);
    url.searchParams.set("limit", String(cfg.walletsPerMarket));
    url.searchParams.set("market", market.conditionId);
    url.searchParams.set("start", String(cutoff));
    url.searchParams.set("takerOnly", "false");
    const rows = await getJson(url);
    for (const trade of rows || []) {
      const wallet = trade.proxyWallet;
      const tx = trade.transactionHash ?? `${wallet}-${trade.timestamp}-${trade.asset}-${trade.size}`;
      if (!wallet || runtime.seenTx.has(tx)) continue;
      runtime.seenTx.add(tx);
      const stats = runtime.walletStats.get(wallet) || freshWallet(wallet);
      const cash = finite(trade.usdcSize ?? finite(trade.size) * finite(trade.price));
      stats.trades += 1;
      stats.cash += cash;
      stats.markets.add(trade.conditionId ?? market.conditionId);
      stats.lastTs = Math.max(stats.lastTs, finite(trade.timestamp));
      stats.names.add(trade.pseudonym || trade.name || "");
      stats.recent.push({
        ts: finite(trade.timestamp),
        conditionId: trade.conditionId ?? market.conditionId,
        market: trade.title ?? market.question,
        outcome: trade.outcome ?? String(trade.outcomeIndex ?? ""),
        side: trade.side ?? "",
        price: finite(trade.price),
        cash,
      });
      stats.recent = stats.recent.slice(-80);
      runtime.walletStats.set(wallet, stats);
    }
  }
}

function freshWallet(wallet) {
  return { wallet, names: new Set(), trades: 0, cash: 0, markets: new Set(), lastTs: 0, recent: [] };
}

function buildSignals(markets) {
  const flow = walletFlow();
  const signals = [];
  for (const market of markets) {
    const a = leg(market, 0);
    const b = leg(market, 1);
    if (!a.ask || !b.ask) continue;
    const combinedCost = a.ask.price + b.ask.price;
    if (combinedCost < cfg.hedgeMinCost || combinedCost > cfg.hedgeMaxCost) continue;
    const fa = flow.get(`${market.question}::${a.outcome}`) || emptyFlow();
    const fb = flow.get(`${market.question}::${b.outcome}`) || emptyFlow();
    const netA = fa.buyCash - fa.sellCash;
    const netB = fb.buyCash - fb.sellCash;
    const tradeA = fa.buyTrades - fa.sellTrades;
    const tradeB = fb.buyTrades - fb.sellTrades;
    const biasLeg = netA >= netB ? a : b;
    const hedgeLeg = biasLeg === a ? b : a;
    const biasFlow = biasLeg === a ? fa : fb;
    const hedgeFlow = biasLeg === a ? fb : fa;
    const biasNetCash = Math.max(netA, netB);
    const hedgeNetCash = Math.min(netA, netB);
    const tradeEdge = biasLeg === a ? tradeA - tradeB : tradeB - tradeA;
    if (biasNetCash < cfg.minNetCash || tradeEdge < cfg.minTradeEdge) continue;
    const plan = sizeHedge({ biasLeg, hedgeLeg }, Math.min(cfg.maxStake, paper.cash));
    if (!plan) continue;
    const key = `${market.conditionId}:${biasLeg.token}:${hedgeLeg.token}:BIAS_HEDGE`;
    signals.push({
      key,
      market: market.question,
      conditionId: market.conditionId,
      endDate: market.endDate,
      minutesToEnd: minutesToEnd(market),
      biasLeg,
      hedgeLeg,
      combinedCost,
      biasNetCash,
      hedgeNetCash,
      tradeEdge,
      wallets: biasFlow.wallets.size,
      plan,
      alreadyOpen: paper.positions.some((p) => p.key === key && p.status === "OPEN"),
      coolingDown: (paper.seenSignals[key] || 0) > Date.now() - cfg.cooldownMin * 60000,
      confidence: biasNetCash * Math.log2(biasFlow.wallets.size + 1) * tradeEdge / Math.max(1, combinedCost),
      reason: `cost ${(combinedCost * 100).toFixed(1)}c | end ${formatMinutes(minutesToEnd(market))} | flow ${money(biasNetCash)} vs ${money(hedgeNetCash)} | trades ${tradeEdge}`,
    });
  }
  return signals.sort((a, b) => b.confidence - a.confidence);
}

function walletFlow() {
  const grouped = new Map();
  for (const wallet of runtime.walletStats.values()) {
    for (const row of wallet.recent) {
      const key = `${row.market}::${row.outcome}`;
      const g = grouped.get(key) || emptyFlow();
      if (String(row.side).toUpperCase() === "BUY") {
        g.buyCash += row.cash;
        g.buyTrades += 1;
      } else if (String(row.side).toUpperCase() === "SELL") {
        g.sellCash += row.cash;
        g.sellTrades += 1;
      }
      g.wallets.add(wallet.wallet);
      grouped.set(key, g);
    }
  }
  return grouped;
}

function emptyFlow() {
  return { buyCash: 0, sellCash: 0, buyTrades: 0, sellTrades: 0, wallets: new Set() };
}

function leg(market, i) {
  const token = market.tokens[i];
  const book = market.books.find((b) => String(b.asset_id) === token);
  return {
    token,
    outcome: market.outcomes[i] ?? `#${i + 1}`,
    bid: best(book?.bids, "bid"),
    ask: best(book?.asks, "ask"),
  };
}

function sizeHedge(signal, stakeBudget) {
  const biasPrice = signal.biasLeg.ask?.price;
  const hedgePrice = signal.hedgeLeg.ask?.price;
  if (!biasPrice || !hedgePrice || stakeBudget <= 0) return null;
  const payoutBudget = stakeBudget / ((biasPrice * 1.4) + hedgePrice);
  const biasPayout = payoutBudget * 1.4;
  const hedgePayout = payoutBudget;
  const biasStake = biasPayout * biasPrice;
  const hedgeStake = hedgePayout * hedgePrice;
  const totalStake = biasStake + hedgeStake;
  const winProfit = biasPayout - totalStake;
  const loseLoss = totalStake - hedgePayout;
  if (!Number.isFinite(totalStake) || winProfit <= 0 || loseLoss < 0) return null;
  return {
    totalStake,
    winProfit,
    loseLoss,
    breakEvenProbability: loseLoss / (winProfit + loseLoss),
    legs: [
      { role: "BIAS", action: "BUY", outcome: signal.biasLeg.outcome, token: signal.biasLeg.token, price: biasPrice, stake: biasStake, payout: biasPayout, shares: biasPayout },
      { role: "HEDGE", action: "BUY", outcome: signal.hedgeLeg.outcome, token: signal.hedgeLeg.token, price: hedgePrice, stake: hedgeStake, payout: hedgePayout, shares: hedgePayout },
    ],
  };
}

function openBest() {
  const signal = runtime.signals.find((s) => !s.alreadyOpen && !s.coolingDown);
  if (!signal) return { ok: false, error: "No eligible signal." };
  return openSignal(signal, "MANUAL_OPEN_BEST");
}

function openManual(input) {
  const signal = runtime.signals.find((s) => s.key === input.key);
  if (!signal) return { ok: false, error: "Signal not found. Refresh scan." };
  return openSignal(signal, "MANUAL_OPEN");
}

function openSignal(signal, action) {
  if (paper.positions.some((p) => p.key === signal.key && p.status === "OPEN")) return { ok: false, error: "Position already open." };
  if ((paper.seenSignals[signal.key] || 0) > Date.now() - cfg.cooldownMin * 60000) return { ok: false, error: "Signal cooling down." };
  const stake = Math.min(cfg.maxStake, paper.cash, Math.max(5, signal.biasNetCash * 0.01));
  const plan = sizeHedge(signal, stake);
  if (!plan || plan.totalStake > paper.cash) return { ok: false, error: "Not enough paper cash." };
  const position = {
    id: `${Date.now()}-${paper.positions.length + 1}`,
    ts: new Date().toISOString(),
    key: signal.key,
    market: signal.market,
    conditionId: signal.conditionId,
    endDate: signal.endDate,
    biasOutcome: signal.biasLeg.outcome,
    hedgeOutcome: signal.hedgeLeg.outcome,
    legs: plan.legs,
    stake: plan.totalStake,
    markValue: plan.totalStake,
    unrealized: 0,
    realized: 0,
    status: "OPEN",
    winProfit: plan.winProfit,
    loseLoss: plan.loseLoss,
    combinedCost: signal.combinedCost,
    reason: signal.reason,
  };
  paper.cash -= position.stake;
  paper.positions.push(position);
  paper.seenSignals[signal.key] = Date.now();
  savePaperState();
  writeTrade({ action, ...position, paperCash: paper.cash });
  return { ok: true, position };
}

function closeManual(input) {
  const p = paper.positions.find((x) => x.id === input.id && x.status === "OPEN");
  if (!p) return { ok: false, error: "Open position not found." };
  markPaperPositions(runtime.markets);
  p.status = "CLOSED";
  p.closedAt = new Date().toISOString();
  p.realized = p.markValue - p.stake;
  paper.cash += p.markValue;
  savePaperState();
  writeTrade({ action: "MANUAL_CLOSE_MARK", ...p, paperCash: paper.cash });
  return { ok: true, position: p };
}

function settleManual(input) {
  const p = paper.positions.find((x) => x.id === input.id && pLikeOpen(x));
  if (!p) return { ok: false, error: "Position not found." };
  const winner = String(input.winner || "");
  const winningLeg = p.legs.find((leg) => normalize(leg.outcome) === normalize(winner));
  if (!winningLeg) return { ok: false, error: "Winner must match one of the position outcomes." };
  const payout = winningLeg.payout;
  p.status = "SETTLED";
  p.settledAt = new Date().toISOString();
  p.winner = winningLeg.outcome;
  p.markValue = payout;
  p.realized = payout - p.stake;
  p.unrealized = 0;
  paper.cash += payout;
  savePaperState();
  writeTrade({ action: "MANUAL_SETTLE", ...p, paperCash: paper.cash });
  return { ok: true, position: p };
}

function pLikeOpen(p) {
  return p.status === "OPEN" || p.status === "EXPIRED";
}

function markPaperPositions(markets) {
  const byToken = new Map();
  const byCondition = new Map(markets.map((m) => [m.conditionId, m]));
  for (const market of markets) {
    for (const token of market.tokens) {
      const book = market.books.find((b) => String(b.asset_id) === token);
      byToken.set(token, best(book?.bids, "bid"));
    }
  }
  for (const p of paper.positions.filter((x) => x.status === "OPEN")) {
    const market = byCondition.get(p.conditionId);
    const ended = p.endDate && Date.parse(p.endDate) < Date.now();
    let markValue = 0;
    let missing = 0;
    for (const l of p.legs) {
      const bid = byToken.get(l.token);
      l.currentBid = bid?.price ?? null;
      l.markValue = bid ? l.shares * bid.price : 0;
      if (!bid) missing += 1;
      markValue += l.markValue;
    }
    p.markValue = markValue;
    p.unrealized = markValue - p.stake;
    if (ended && (!market || missing === p.legs.length)) {
      p.status = "EXPIRED";
      p.needsSettlement = true;
      p.unrealized = 0;
      p.markValue = p.stake;
    }
  }
}

function loadPaperState() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(files.state)) {
    return { startingBankroll: cfg.paperBankroll, cash: cfg.paperBankroll, positions: [], seenSignals: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(files.state, "utf8"));
    return {
      startingBankroll: finite(data.startingBankroll || cfg.paperBankroll),
      cash: finite(data.cash),
      positions: Array.isArray(data.positions) ? data.positions : [],
      seenSignals: data.seenSignals && typeof data.seenSignals === "object" ? data.seenSignals : {},
    };
  } catch {
    return { startingBankroll: cfg.paperBankroll, cash: cfg.paperBankroll, positions: [], seenSignals: {} };
  }
}

function savePaperState() {
  const tmp = `${files.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(paper, null, 2));
  fs.renameSync(tmp, files.state);
}

function statusPayload() {
  const open = paper.positions.filter((p) => p.status === "OPEN");
  const expired = paper.positions.filter((p) => p.status === "EXPIRED");
  const realized = sum(paper.positions.filter((p) => p.status === "CLOSED" || p.status === "SETTLED").map((p) => p.realized));
  const equity = paper.cash + sum(open.map((p) => p.markValue || 0)) + sum(expired.map((p) => p.markValue || 0));
  return {
    ok: true,
    cfg,
    runtime: {
      cycle: runtime.cycle,
      scanning: runtime.scanning,
      lastScanAt: runtime.lastScanAt,
      nextScanAt: runtime.nextScanAt,
      elapsedMs: runtime.elapsedMs,
      marketCount: runtime.markets.length,
      errors: runtime.errors.slice(0, 5),
    },
    paper: {
      startingBankroll: paper.startingBankroll,
      cash: paper.cash,
      equity,
      pnl: equity - paper.startingBankroll,
      realized,
      open: open.length,
      expired: expired.length,
      positions: paper.positions.slice(-80).reverse(),
    },
    signals: runtime.signals,
    trades: runtime.trades,
  };
}

function writeTrade(row) {
  fs.appendFileSync(files.trades, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  runtime.trades = readRecentTrades();
}

function writeSnapshot() {
  fs.appendFileSync(files.snapshots, JSON.stringify({
    ts: new Date().toISOString(),
    cycle: runtime.cycle,
    markets: runtime.markets.length,
    signals: runtime.signals.slice(0, 10).map(cleanSignal),
    paper: statusPayload().paper,
  }) + "\n");
}

function cleanSignal(s) {
  return {
    key: s.key,
    market: s.market,
    bias: s.biasLeg.outcome,
    hedge: s.hedgeLeg.outcome,
    cost: s.combinedCost,
    stake: s.plan.totalStake,
    win: s.plan.winProfit,
    loss: s.plan.loseLoss,
    end: s.minutesToEnd,
    reason: s.reason,
  };
}

function readRecentTrades() {
  if (!fs.existsSync(files.trades)) return [];
  return fs.readFileSync(files.trades, "utf8").trim().split("\n").filter(Boolean).slice(-80).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).reverse();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

function html(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Polymarket Pro Terminal</title>
<style>
:root{color-scheme:dark;--bg:#07090d;--panel:#101720;--line:#243244;--text:#e8eef7;--muted:#8996aa;--cyan:#66e3ff;--green:#5ee087;--red:#ff6370;--yellow:#ffd166}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;z-index:2;background:#080c12d9;backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
h1{font-size:16px;margin:0;color:var(--cyan);letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:12px;padding:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;min-height:72px}.label{color:var(--muted);font-size:12px}.value{font-size:24px;font-weight:700}.green{color:var(--green)}.red{color:var(--red)}.cyan{color:var(--cyan)}.yellow{color:var(--yellow)}
main{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;padding:0 16px 16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}.panel h2{margin:0;padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--cyan)}
table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid #1b2837;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px}tr:hover td{background:#132031}
button{background:#142235;color:var(--text);border:1px solid #36506c;border-radius:6px;padding:7px 9px;font:inherit;cursor:pointer}button:hover{border-color:var(--cyan)}button.primary{background:#0b3a46;border-color:#1787a0}.small{font-size:12px;padding:5px 7px}.muted{color:var(--muted)}.pill{border:1px solid var(--line);border-radius:999px;padding:2px 7px}.log{max-height:330px;overflow:auto}.nowrap{white-space:nowrap}.market{max-width:360px}
@media(max-width:1050px){.grid{grid-template-columns:repeat(2,1fr)}main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><h1>POLYMARKET PRO TERMINAL :: PAPER EXECUTION</h1><div><button onclick="scanNow()">Scan Now</button> <button class="primary" onclick="openBest()">Open Best Paper</button></div></header>
<section class="grid">
<div class="card"><div class="label">Equity</div><div id="equity" class="value">$0.00</div></div>
<div class="card"><div class="label">PnL</div><div id="pnl" class="value">$0.00</div></div>
<div class="card"><div class="label">Cash / Open</div><div id="cash" class="value">$0.00</div></div>
<div class="card"><div class="label">Scan</div><div id="scan" class="value">-</div></div>
</section>
<main>
<section class="panel"><h2>Live Signals</h2><div class="log"><table><thead><tr><th>Market</th><th>Bias</th><th>Cost</th><th>Stake</th><th>Win/Loss</th><th></th></tr></thead><tbody id="signals"></tbody></table></div></section>
<section class="panel"><h2>Paper Positions</h2><div class="log"><table><thead><tr><th>Market</th><th>Status</th><th>Stake</th><th>uPnL</th><th></th></tr></thead><tbody id="positions"></tbody></table></div></section>
<section class="panel"><h2>Execution Tape</h2><div class="log"><table><thead><tr><th>Time</th><th>Action</th><th>Market</th><th>Cash</th></tr></thead><tbody id="tape"></tbody></table></div></section>
<section class="panel"><h2>System</h2><div id="system" style="padding:14px"></div></section>
</main>
<script>
const money=n=>'$'+Number(n||0).toFixed(2);
const pct=n=>(Number(n||0)*100).toFixed(1)+'%';
async function api(path, body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()}
async function refresh(){
 const s=await api('/api/status');
 equity.textContent=money(s.paper.equity);
 pnl.textContent=money(s.paper.pnl); pnl.className='value '+(s.paper.pnl>=0?'green':'red');
 cash.textContent=money(s.paper.cash)+' / '+s.paper.open;
 scan.textContent=s.runtime.marketCount+' mkts';
 signals.innerHTML=s.signals.slice(0,20).map(x=>'<tr><td class="market">'+esc(x.market)+'<div class="muted">'+esc(x.reason)+'</div></td><td>'+esc(x.biasLeg.outcome)+' / '+esc(x.hedgeLeg.outcome)+'</td><td class="nowrap">'+(x.combinedCost*100).toFixed(1)+'c</td><td>'+money(x.plan.totalStake)+'</td><td><span class="green">'+money(x.plan.winProfit)+'</span><br><span class="red">-'+money(x.plan.loseLoss).slice(1)+'</span></td><td><button class="small" onclick="openSignal(\\''+x.key+'\\')" '+(x.alreadyOpen||x.coolingDown?'disabled':'')+'>Paper Open</button></td></tr>').join('')||'<tr><td colspan="6" class="muted">No eligible signals.</td></tr>';
 positions.innerHTML=s.paper.positions.map(p=>'<tr><td class="market">'+esc(p.market)+'<div class="muted">'+esc(p.biasOutcome)+' / '+esc(p.hedgeOutcome)+'</div></td><td><span class="pill">'+esc(p.status)+'</span></td><td>'+money(p.stake)+'</td><td class="'+((p.unrealized||0)>=0?'green':'red')+'">'+money(p.unrealized)+'</td><td>'+positionButtons(p)+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No positions.</td></tr>';
 tape.innerHTML=s.trades.map(t=>'<tr><td class="nowrap">'+esc((t.ts||'').slice(11,19))+'</td><td>'+esc(t.action)+'</td><td class="market">'+esc(t.market||'')+'</td><td>'+money(t.paperCash)+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">No tape.</td></tr>';
 system.innerHTML='<div>Cycle: <b>'+s.runtime.cycle+'</b></div><div>Last scan: <b>'+esc(s.runtime.lastScanAt||'-')+'</b></div><div>Next: <b>'+esc(s.runtime.nextScanAt||'-')+'</b></div><div>Open expired needing settlement: <b>'+s.paper.expired+'</b></div><pre class="red">'+esc((s.runtime.errors||[]).join('\\n'))+'</pre>';
}
function positionButtons(p){if(p.status==='OPEN')return '<button class="small" onclick="closePos(\\''+p.id+'\\')">Close Mark</button> '+settleButtons(p); if(p.status==='EXPIRED')return settleButtons(p); return ''}
function settleButtons(p){return (p.legs||[]).map(l=>'<button class="small" onclick="settlePos(\\''+p.id+'\\',\\''+escAttr(l.outcome)+'\\')">Settle '+esc(l.outcome)+'</button>').join(' ')}
async function openBest(){await api('/api/manual/open-best',{});refresh()}
async function openSignal(key){await api('/api/manual/open',{key});refresh()}
async function closePos(id){await api('/api/manual/close',{id});refresh()}
async function settlePos(id,winner){await api('/api/manual/settle',{id,winner});refresh()}
async function scanNow(){await api('/api/scan-now',{});refresh()}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function escAttr(s){return String(s??'').replace(/[\\\\']/g,'')}
refresh();setInterval(refresh,2000);
</script>
</body>
</html>`);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
  });
}

function best(levels, side) {
  const parsed = Array.isArray(levels) ? levels.map((l) => ({ price: finite(l.price), size: finite(l.size) })).filter((l) => l.price > 0 && l.size > 0) : [];
  parsed.sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
  return parsed[0] || null;
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function minutesToEnd(market) {
  return market.endDate ? (Date.parse(market.endDate) - Date.now()) / 60000 : null;
}

function formatMinutes(value) {
  if (!Number.isFinite(Number(value))) return "?";
  return value < 60 ? `${Math.max(0, Math.round(value))}m` : `${(value / 60).toFixed(1)}h`;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function money(value) {
  return `$${finite(value).toFixed(2)}`;
}

function sum(values) {
  return values.reduce((a, b) => a + finite(b), 0);
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function numberEnv(name, fallback) {
  return Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
