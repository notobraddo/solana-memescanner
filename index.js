/**
 * PONYIN AI AGENT — Solana Meme Trading Bot
 * Auto Trade | Auto Learn | Auto Improve
 * 
 * Features:
 * - Real-time DexScreener scanning
 * - AI Agent (Claude) decides entry type, TP, SL
 * - Auto-improve filters setelah 3x consecutive loss
 * - Telegram notifications + hourly reports
 * - Paper trading with 1 SOL balance, 0.03 SOL per trade
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import axios from 'axios';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════
const CONFIG = {
TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '1404877677',

// OpenRouter AI
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_MODEL: 'anthropic/claude-sonnet-4',

  // Trading
  INITIAL_BALANCE_SOL: 1.0,
  TRADE_SIZE_SOL: 0.03,
  MAX_OPEN_TRADES: 5,
  SCAN_INTERVAL_MS: 60000,
  REPORT_INTERVAL_MS: 3600000,
  TARGET_WIN_RATE: 0.55,
  CONSECUTIVE_LOSS_TRIGGER: 3,

  // RPC
  RPC_URL: 'https://solana-mainnet.g.alchemy.com/v2/TM1nScPxx_HBO9PfNOLBRHZku5Swb_Ac',

  // Dashboard
  DASHBOARD_PORT: 3210,
};

// ══════════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════════
const DB_PATH = join(__dirname, 'data', 'trades.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL, name TEXT, symbol TEXT,
    price_usd REAL, liquidity_usd REAL, market_cap_usd REAL,
    volume_24h REAL, volume_5m REAL,
    price_change_5m REAL, price_change_1h REAL, price_change_24h REAL,
    holder_count INTEGER, tx_count_5m INTEGER,
    buy_count_5m INTEGER, sell_count_5m INTEGER,
    age_minutes REAL, dex TEXT, pair_address TEXT,
    bundle_score REAL DEFAULT 0, lp_burned INTEGER DEFAULT 0,
    filter_passed INTEGER DEFAULT 0, filter_score INTEGER DEFAULT 0,
    filter_reasons TEXT, ai_action TEXT, ai_reasoning TEXT,
    ai_confidence INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER, mint TEXT NOT NULL,
    entry_type TEXT DEFAULT 'limit',
    entry_price REAL, tp_price REAL, sl_price REAL,
    amount_sol REAL DEFAULT 0.03, fee_sol REAL DEFAULT 0.005,
    status TEXT DEFAULT 'pending_limit',
    current_price REAL DEFAULT 0,
    exit_price REAL, pnl_sol REAL, pnl_pct REAL,
    ai_reasoning TEXT,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS hourly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_hour DATETIME NOT NULL,
    total_signals INTEGER DEFAULT 0, passed_filter INTEGER DEFAULT 0,
    trades_opened INTEGER DEFAULT 0, trades_closed INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
    total_pnl_sol REAL DEFAULT 0, avg_pnl_pct REAL DEFAULT 0,
    best_trade_pct REAL DEFAULT 0, worst_trade_pct REAL DEFAULT 0,
    win_rate REAL DEFAULT 0, filter_generation INTEGER DEFAULT 1,
    report_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS filter_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation INTEGER NOT NULL,
    triggered_by TEXT, improvement_notes TEXT,
    filters_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON paper_trades(status);
`);

// ══════════════════════════════════════════════════════════════════
// BOT STATE
// ══════════════════════════════════════════════════════════════════
let state = {
  balance: CONFIG.INITIAL_BALANCE_SOL,
  consecutiveLosses: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnl: 0,
  filterGeneration: 1,
  recentLosses: [],
  scannedToday: 0,
  skippedToday: 0,
  startedAt: Date.now(),
  lastReportAt: Date.now(),
};

// Load state from DB
const tradeCount = db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status='closed'").get();
if (tradeCount.c > 0) {
  const stats = db.prepare("SELECT SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w, COUNT(*) as t, COALESCE(SUM(pnl_sol),0) as pnl FROM paper_trades WHERE status='closed'").get();
  state.wins = stats.w || 0;
  state.losses = (stats.t || 0) - state.wins;
  state.totalTrades = stats.t || 0;
  state.totalPnl = stats.pnl || 0;
  state.balance = CONFIG.INITIAL_BALANCE_SOL + state.totalPnl;
}

// ══════════════════════════════════════════════════════════════════
// FILTER CONFIG (AI-tunable)
// ══════════════════════════════════════════════════════════════════
let filterConfig = {
  minLiquidityUsd: 20000,
  minVolume24hUsd: 5000,
  minHolderCount: 10,
  minPriceChange5m: -10,
  maxPriceChange5m: 100,
  minTxCount5m: 0,
  minBuySellRatio: 0.5,
  minMarketCapUsd: 5000,
  maxMarketCapUsd: 50000000,
  minAgeMinutes: 1,
  maxAgeHours: 720,
  tpMultiplier: 1.20,
  slMultiplier: 0.90,
  generation: 1,
};

// ══════════════════════════════════════════════════════════════════
// TELEGRAM (via curl — reliable on this server)
// ══════════════════════════════════════════════════════════════════
const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;

async function sendTelegram(text) {
  try {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const cmd = `curl -s --max-time 15 -X POST "${TELEGRAM_API}/sendMessage" -d "chat_id=${CONFIG.TELEGRAM_CHAT_ID}" -d "text=${escaped}" -d "parse_mode=HTML" -d "disable_webpage_preview=true" 2>&1`;
    const result = execSync(cmd, { timeout: 20000, maxBuffer: 1024 * 1024 }).toString();
    const data = JSON.parse(result);
    if (!data?.ok) console.error('[Telegram] Error:', result.substring(0, 200));
    return data;
  } catch (e) {
    console.error('[Telegram] Error:', e.message?.substring(0, 100) || 'unknown');
    return null;
  }
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtPrice(p) { if (!p) return '?'; if (p < 0.00001) return p.toExponential(2); if (p < 0.01) return p.toFixed(8); return p.toFixed(4); }
function fmtUSD(n) { if (!n) return '$0'; if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M'; if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K'; return '$' + n.toFixed(0); }
function fmtTime() { return new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

async function notifyEntry(trade, signal, aiReasoning) {
  const icon = trade.entry_type === 'limit' ? '🟡' : '🟢';
  const mode = trade.entry_type === 'limit' ? 'LIMIT ORDER' : 'MARKET ENTRY';
  const tpPct = ((trade.tp_price / trade.entry_price) - 1) * 100;
  const slPct = (1 - (trade.sl_price / trade.entry_price)) * 100;

  let msg = `${icon} <b>NEW TRADE — ${mode}</b>\n\n`;
  msg += `🪙 Token: <b>$${esc(signal.symbol)}</b> (${esc(signal.name)})\n`;
  msg += `💰 Entry: <b>$${fmtPrice(trade.entry_price)}</b>\n`;
  msg += `🎯 TP: <b>$${fmtPrice(trade.tp_price)}</b> (+${tpPct.toFixed(0)}%)\n`;
  msg += `🛑 SL: <b>$${fmtPrice(trade.sl_price)}</b> (-${slPct.toFixed(0)}%)\n`;
  msg += `💼 Size: <b>${trade.amount_sol} SOL</b>\n`;
  msg += `💧 Liq: ${fmtUSD(signal.liquidity_usd)} | Vol 24h: ${fmtUSD(signal.volume_24h)}\n`;
  msg += `📊 MC: ${fmtUSD(signal.market_cap_usd)}\n`;
  msg += `📈 5m: ${signal.price_change_5m >= 0 ? '+' : ''}${signal.price_change_5m?.toFixed(1)}% | 1h: ${signal.price_change_1h >= 0 ? '+' : ''}${signal.price_change_1h?.toFixed(1)}%\n`;
  msg += `🔗 <a href="https://dexscreener.com/solana/${trade.mint}">DexScreener</a>\n\n`;
  msg += `📝 AI Reason: <i>${esc(aiReasoning || 'N/A')}</i>\n`;
  msg += `🕐 ${fmtTime()} WIB`;

  return sendTelegram(msg);
}

async function notifyClose(trade, won) {
  const icon = won ? '✅' : '❌';
  let msg = `${icon} <b>TRADE CLOSED — ${won ? 'PROFIT' : 'LOSS'}</b>\n\n`;
  msg += `🪙 Token: <b>$${esc(trade.token_symbol || trade.mint?.substring(0,8))}</b>\n`;
  msg += `💰 Entry: $${fmtPrice(trade.entry_price)}\n`;
  msg += `💱 Exit: $${fmtPrice(trade.exit_price)}\n`;
  msg += `${won ? '📈' : '📉'} PnL: <b>${trade.pnl_sol >= 0 ? '+' : ''}${trade.pnl_sol?.toFixed(4)} SOL (${trade.pnl_pct >= 0 ? '+' : ''}${trade.pnl_pct?.toFixed(1)}%)</b>\n`;
  msg += `🕐 ${fmtTime()} WIB`;
  return sendTelegram(msg);
}

async function notifyFilterImprove(oldGen, newGen, notes) {
  let msg = `🔧 <b>AI FILTER IMPROVED</b>\n\n`;
  msg += `Generation: ${oldGen} → ${newGen}\n`;
  msg += `Trigger: ${CONFIG.CONSECUTIVE_LOSS_TRIGGER}x consecutive losses\n\n`;
  msg += `📋 Changes:\n<i>${esc(notes)}</i>\n\n`;
  msg += `Bot akan lebih selektif. 💪`;
  return sendTelegram(msg);
}

async function notifyHourly() {
  const openTrades = db.prepare("SELECT * FROM paper_trades WHERE status IN ('open','pending_limit')").all();
  const closed = db.prepare("SELECT * FROM paper_trades WHERE status='closed' ORDER BY closed_at DESC LIMIT 5").all();
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  let msg = `📊 <b>HOURLY REPORT — ${fmtTime()} WIB</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⏱ Uptime: ${hours}h ${mins}m\n`;
  msg += `💼 Balance: <b>${state.balance.toFixed(4)} SOL</b>\n`;
  msg += `📈 Total PnL: <b>${state.totalPnl >= 0 ? '+' : ''}${state.totalPnl.toFixed(4)} SOL</b>\n\n`;
  msg += `📉 <b>STATS</b>\n`;
  msg += `Total: ${state.totalTrades} | ✅ Win: ${state.wins} | ❌ Loss: ${state.losses}\n`;
  msg += `🎯 Win Rate: <b>${state.totalTrades > 0 ? ((state.wins/state.totalTrades)*100).toFixed(1) : 0}%</b> (Target: ${CONFIG.TARGET_WIN_RATE*100}%)\n`;
  msg += `🔁 Filter Gen: #${filterConfig.generation}\n`;

  if (openTrades.length > 0) {
    msg += `\n🟢 <b>OPEN (${openTrades.length})</b>\n`;
    for (const t of openTrades.slice(0, 5)) {
      const pnl = t.current_price > 0 ? ((t.current_price - t.entry_price) / t.entry_price * 100) : 0;
      msg += `• ${t.mint.substring(0,6)}... | ${t.entry_type} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
    }
  }

  if (closed.length > 0) {
    msg += `\n📋 <b>RECENT CLOSED</b>\n`;
    for (const t of closed.slice(0, 3)) {
      msg += `• ${t.mint.substring(0,6)}... | ${t.pnl_sol >= 0 ? '+' : ''}${t.pnl_sol?.toFixed(4)} SOL\n`;
    }
  }

  return sendTelegram(msg);
}

// ══════════════════════════════════════════════════════════════════
// SCANNER — DexScreener
// ══════════════════════════════════════════════════════════════════
const EXCLUDE_SYMBOLS = new Set(['sol','wsol','usdc','usdt','bonk','wif','popcat','bome','myro','wen','jup','pyth','ray','orca','msol','bsol','hnt','render','inf']);
const EXCLUDE_MINTS = new Set(['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

async function scanTokens() {
  const tokens = [];
  const queries = ['pump solana', 'pump fun', 'new solana'];

  for (const q of queries) {
    try {
      const res = await axios.get('https://api.dexscreener.com/latest/dex/search', {
        params: { q, limit: 30 }, timeout: 15000,
      });
      const pairs = res.data?.pairs || [];
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken?.address || '';
        if (EXCLUDE_MINTS.has(mint)) continue;
        const sym = (p.baseToken?.symbol || '').toLowerCase();
        if (EXCLUDE_SYMBOLS.has(sym)) continue;

        const priceUsd = parseFloat(p.priceUsd) || 0;
        if (priceUsd <= 0) continue;
        const liq = p.liquidity?.usd || 0;
        if (liq < 5000) continue;

        const created = p.pairCreatedAt || 0;
        const ageMin = created ? (Date.now() - created) / 60000 : 0;
        const txns5m = p.txns?.m5 || {};
        const buys5 = parseInt(txns5m.buys || 0);
        const sells5 = parseInt(txns5m.sells || 0);

        tokens.push({
          mint, name: p.baseToken?.name || 'Unknown', symbol: p.baseToken?.symbol || '?',
          price_usd: priceUsd, price_sol: parseFloat(p.priceNative) || 0,
          liquidity_usd: liq, market_cap_usd: p.fdv || p.marketCap || 0,
          volume_24h: p.volume?.h24 || 0, volume_5m: p.volume?.m5 || 0,
          price_change_5m: p.priceChange?.m5 || 0, price_change_1h: p.priceChange?.h1 || 0, price_change_24h: p.priceChange?.h24 || 0,
          holder_count: 0, tx_count_5m: buys5 + sells5, buy_count_5m: buys5, sell_count_5m: sells5,
          age_minutes: Math.max(0, ageMin), dex: p.dexId || '', pair_address: p.pairAddress || '',
        });
      }
    } catch (e) { console.warn(`[Scan] Query "${q}" failed:`, e.message); }
  }

  // Deduplicate
  const seen = new Set();
  return tokens.filter(t => { if (seen.has(t.mint)) return false; seen.add(t.mint); return true; });
}

// ══════════════════════════════════════════════════════════════════
// FILTER ENGINE
// ══════════════════════════════════════════════════════════════════
function applyFilters(token) {
  const reasons = [];
  let passed = true;

  if (token.liquidity_usd < filterConfig.minLiquidityUsd) { reasons.push(`Liq ${fmtUSD(token.liquidity_usd)} < ${fmtUSD(filterConfig.minLiquidityUsd)}`); passed = false; }
  if (token.volume_24h < filterConfig.minVolume24hUsd) { reasons.push(`Vol24h ${fmtUSD(token.volume_24h)} < ${fmtUSD(filterConfig.minVolume24hUsd)}`); passed = false; }
  if (token.price_change_5m < filterConfig.minPriceChange5m) { reasons.push(`Momentum 5m ${token.price_change_5m.toFixed(1)}% < ${filterConfig.minPriceChange5m}%`); passed = false; }
  if (token.price_change_5m > filterConfig.maxPriceChange5m) { reasons.push(`Pump 5m ${token.price_change_5m.toFixed(1)}% > ${filterConfig.maxPriceChange5m}%`); passed = false; }
  if (token.tx_count_5m < filterConfig.minTxCount5m) { reasons.push(`Tx5m ${token.tx_count_5m} < ${filterConfig.minTxCount5m}`); passed = false; }
  if (token.market_cap_usd > 0 && token.market_cap_usd < filterConfig.minMarketCapUsd) { reasons.push(`MC ${fmtUSD(token.market_cap_usd)} < ${fmtUSD(filterConfig.minMarketCapUsd)}`); passed = false; }
  if (token.market_cap_usd > filterConfig.maxMarketCapUsd) { reasons.push(`MC ${fmtUSD(token.market_cap_usd)} > ${fmtUSD(filterConfig.maxMarketCapUsd)}`); passed = false; }
  if (token.age_minutes < filterConfig.minAgeMinutes) { reasons.push(`Too new (${token.age_minutes.toFixed(0)}m)`); passed = false; }
  if (token.age_minutes > filterConfig.maxAgeHours * 60) { reasons.push(`Too old (${(token.age_minutes/60).toFixed(1)}h)`); passed = false; }
  if (token.sell_count_5m > 0) {
    const ratio = token.buy_count_5m / token.sell_count_5m;
    if (ratio < filterConfig.minBuySellRatio) { reasons.push(`B/S ratio ${ratio.toFixed(1)}x < ${filterConfig.minBuySellRatio}x`); passed = false; }
  }
  if (token.holder_count > 0 && token.holder_count < filterConfig.minHolderCount) { reasons.push(`Holders ${token.holder_count} < ${filterConfig.minHolderCount}`); passed = false; }

  return { passed, reasons };
}

// ══════════════════════════════════════════════════════════════════
// AI AGENT — Claude decides entry
// ══════════════════════════════════════════════════════════════════
async function aiAnalyze(token) {
  if (!CONFIG.OPENROUTER_API_KEY) return null;

  const prompt = `Kamu adalah AI trading agent Solana on-chain. Analisis token ini dan tentukan apakah layak di-trade.

FILTER CONFIG (Gen ${filterConfig.generation}):
- Min Liq: $${filterConfig.minLiquidityUsd.toLocaleString()}
- Min Vol 24h: $${filterConfig.minVolume24hUsd.toLocaleString()}
- Min Holders: ${filterConfig.minHolderCount}
- Price Change 5m: ${filterConfig.minPriceChange5m}% - ${filterConfig.maxPriceChange5m}%
- Min Tx 5m: ${filterConfig.minTxCount5m}
- Min Buy/Sell Ratio: ${filterConfig.minBuySellRatio}x
- MC Range: $${filterConfig.minMarketCapUsd.toLocaleString()} - $${filterConfig.maxMarketCapUsd.toLocaleString()}
- Age: ${filterConfig.minAgeMinutes}m - ${filterConfig.maxAgeHours}h
- TP: +${((filterConfig.tpMultiplier-1)*100).toFixed(0)}% | SL: -${((1-filterConfig.slMultiplier)*100).toFixed(0)}%

TOKEN DATA:
- Symbol: ${token.symbol} (${token.name})
- Price: $${token.price_usd}
- Liq: $${token.liquidity_usd?.toLocaleString()}
- Vol 24h: $${token.volume_24h?.toLocaleString()}
- Vol 5m: $${token.volume_5m?.toLocaleString()}
- Price Change 5m: ${token.price_change_5m?.toFixed(1)}%
- Price Change 1h: ${token.price_change_1h?.toFixed(1)}%
- MC: $${token.market_cap_usd?.toLocaleString()}
- Holders: ${token.holder_count}
- Tx 5m: ${token.tx_count_5m} (Buy: ${token.buy_count_5m} | Sell: ${token.sell_count_5m})
- Age: ${token.age_minutes?.toFixed(0)} menit
- DEX: ${token.dex}

BOT STATE:
- Balance: ${state.balance.toFixed(3)} SOL
- Trade size: ${CONFIG.TRADE_SIZE_SOL} SOL
- Open trades: ${db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status IN ('open','pending_limit')").get().c}/${CONFIG.MAX_OPEN_TRADES}
- WR: ${state.totalTrades > 0 ? ((state.wins/state.totalTrades)*100).toFixed(1) : 0}%
- Consecutive losses: ${state.consecutiveLosses}

Jawab HANYA JSON (tanpa backtick):
{"action":"BUY" or "SKIP","entry_type":"market" or "limit","entry_price_usd":float,"tp_price_usd":float,"sl_price_usd":float,"confidence":0-100,"reasoning":"singkat max 2 kalimat","skip_reason":"jika SKIP"}`;

  try {
    const res = await axios.post(`${CONFIG.OPENROUTER_BASE_URL}/chat/completions`, {
      model: CONFIG.AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    let text = res.data?.choices?.[0]?.message?.content?.trim() || '';
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('[AI] Error:', e.message?.substring(0, 100));
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
// AI FILTER IMPROVE
// ══════════════════════════════════════════════════════════════════
async function aiImproveFilters() {
  if (!CONFIG.OPENROUTER_API_KEY) {
    // Fallback: manual tighten
    filterConfig.minLiquidityUsd *= 1.3;
    filterConfig.minVolume24hUsd *= 1.3;
    filterConfig.minBuySellRatio = Math.min(filterConfig.minBuySellRatio + 0.2, 3.0);
    filterConfig.generation++;
    db.prepare("INSERT INTO filter_history (generation, triggered_by, improvement_notes, filters_json) VALUES (?,?,?,?)")
      .run(filterConfig.generation, 'consecutive_losses', 'Auto-tighten fallback', JSON.stringify(filterConfig));
    return notifyFilterImprove(filterConfig.generation - 1, filterConfig.generation, 'Auto-tighten: liq +30%, vol +30%, B/S ratio +0.2');
  }

  const recentLosses = state.recentLosses.slice(-5);
  const lossInfo = recentLosses.map(l => `- ${l.symbol}: Entry $${l.entry_price}, PnL ${l.pnl_pct?.toFixed(1)}%`).join('\n');

  const prompt = `Kamu AI filter optimizer. Bot mengalami ${state.consecutiveLosses} loss berturut-turut. WR: ${state.totalTrades > 0 ? ((state.wins/state.totalTrades)*100).toFixed(1) : 0}% (target: ${CONFIG.TARGET_WIN_RATE*100}%).

RECENT LOSSES:
${lossInfo || 'Tidak ada detail'}

CURRENT FILTER (Gen ${filterConfig.generation}):
- Min Liq: $${filterConfig.minLiquidityUsd.toLocaleString()}
- Min Vol 24h: $${filterConfig.minVolume24hUsd.toLocaleString()}
- Min Holders: ${filterConfig.minHolderCount}
- Price Change 5m: ${filterConfig.minPriceChange5m}% - ${filterConfig.maxPriceChange5m}%
- Min Tx 5m: ${filterConfig.minTxCount5m}
- Min B/S Ratio: ${filterConfig.minBuySellRatio}x
- MC: $${filterConfig.minMarketCapUsd.toLocaleString()} - $${filterConfig.maxMarketCapUsd.toLocaleString()}
- Age: ${filterConfig.minAgeMinutes}m - ${filterConfig.maxAgeHours}h
- TP: +${((filterConfig.tpMultiplier-1)*100).toFixed(0)}% | SL: -${((1-filterConfig.slMultiplier)*100).toFixed(0)}%

Improve filter untuk WR 55%+. Jawab HANYA JSON: {"minLiquidityUsd":float,"minVolume24hUsd":float,"minHolderCount":int,"minPriceChange5m":float,"maxPriceChange5m":float,"minTxCount5m":int,"minBuySellRatio":float,"minMarketCapUsd":float,"maxMarketCapUsd":float,"minAgeMinutes":int,"maxAgeHours":int,"tpMultiplier":float,"slMultiplier":float,"notes":"apa yang diubah"}`;

  try {
    const res = await axios.post(`${CONFIG.OPENROUTER_BASE_URL}/chat/completions`, {
      model: CONFIG.AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    let text = res.data?.choices?.[0]?.message?.content?.trim() || '';
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(text);
    const notes = data.notes || 'AI improved filters';
    delete data.notes;
    Object.assign(filterConfig, data, { generation: filterConfig.generation + 1 });
    db.prepare("INSERT INTO filter_history (generation, triggered_by, improvement_notes, filters_json) VALUES (?,?,?,?)")
      .run(filterConfig.generation, 'consecutive_losses', notes, JSON.stringify(filterConfig));
    return notifyFilterImprove(filterConfig.generation - 1, filterConfig.generation, notes);
  } catch (e) {
    console.error('[AI Improve] Error:', e.message?.substring(0, 100));
    filterConfig.minLiquidityUsd *= 1.3;
    filterConfig.generation++;
    return notifyFilterImprove(filterConfig.generation - 1, filterConfig.generation, 'Fallback: liq +30%');
  }
}

// ══════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT
// ══════════════════════════════════════════════════════════════════
function openTrade(token, aiResult) {
  const entryPrice = aiResult.entry_price_usd || token.price_usd;
  const tpPrice = aiResult.tp_price_usd || entryPrice * filterConfig.tpMultiplier;
  const slPrice = aiResult.sl_price_usd || entryPrice * filterConfig.slMultiplier;
  const entryType = aiResult.entry_type || 'limit';
  const status = entryType === 'limit' ? 'pending_limit' : 'open';

  const stmt = db.prepare(`INSERT INTO paper_trades (signal_id, mint, entry_type, entry_price, tp_price, sl_price, amount_sol, fee_sol, status, ai_reasoning) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const result = stmt.run(token.signalId, token.mint, entryType, entryPrice, tpPrice, slPrice, CONFIG.TRADE_SIZE_SOL, 0.005, status, aiResult.reasoning || '');

  return { id: result.lastInsertRowid, entry_price: entryPrice, tp_price: tpPrice, sl_price: slPrice, entry_type: entryType };
}

async function updatePrices() {
  const openTrades = db.prepare("SELECT * FROM paper_trades WHERE status IN ('open','pending_limit')").all();
  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const res = await axios.get(`https://price.jup.ag/v6/price?ids=${trade.mint}`, { timeout: 10000 });
      const price = res.data?.data?.[trade.mint]?.price;
      if (!price) continue;

      db.prepare("UPDATE paper_trades SET current_price=? WHERE id=?").run(price, trade.id);

      // Check TP
      if (trade.status === 'open' && price >= trade.tp_price) {
        const pnlPct = ((price - trade.entry_price) / trade.entry_price) * 100;
        const pnlSol = (CONFIG.TRADE_SIZE_SOL * pnlPct / 100) - 0.005;
        db.prepare("UPDATE paper_trades SET status='closed', exit_price=?, pnl_sol=?, pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?").run(price, pnlSol, pnlPct, trade.id);
        state.balance += pnlSol;
        state.totalPnl += pnlSol;
        state.wins++;
        state.totalTrades++;
        state.consecutiveLosses = 0;
        await notifyClose({ ...trade, exit_price: price, pnl_sol: pnlSol, pnl_pct: pnlPct, token_symbol: trade.mint.substring(0,8) }, true);
      }
      // Check SL
      else if (trade.status === 'open' && price <= trade.sl_price) {
        const pnlPct = ((price - trade.entry_price) / trade.entry_price) * 100;
        const pnlSol = (CONFIG.TRADE_SIZE_SOL * pnlPct / 100) - 0.005;
        db.prepare("UPDATE paper_trades SET status='closed', exit_price=?, pnl_sol=?, pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?").run(price, pnlSol, pnlPct, trade.id);
        state.balance += pnlSol;
        state.totalPnl += pnlSol;
        state.losses++;
        state.totalTrades++;
        state.consecutiveLosses++;
        state.recentLosses.push({ symbol: trade.mint.substring(0,8), entry_price: trade.entry_price, pnl_pct: pnlPct });
        await notifyClose({ ...trade, exit_price: price, pnl_sol: pnlSol, pnl_pct: pnlPct, token_symbol: trade.mint.substring(0,8) }, false);

        // Trigger AI improve
        if (state.consecutiveLosses >= CONFIG.CONSECUTIVE_LOSS_TRIGGER) {
          console.log(`[AI] ${state.consecutiveLosses} consecutive losses — improving filters...`);
          await aiImproveFilters();
          state.consecutiveLosses = 0;
        }
      }
      // Check limit fill (price dipped to limit level)
      else if (trade.status === 'pending_limit' && price <= trade.entry_price) {
        db.prepare("UPDATE paper_trades SET status='open' WHERE id=?").run(trade.id);
        console.log(`[Limit Filled] ${trade.mint.substring(0,8)} @ $${trade.entry_price}`);
        await sendTelegram(`🟡 <b>LIMIT FILLED</b>\n🪙 ${trade.mint.substring(0,8)}...\n💰 Entry: $${fmtPrice(trade.entry_price)}\n🎯 TP: $${fmtPrice(trade.tp_price)}\n🛑 SL: $${fmtPrice(trade.sl_price)}\n🕐 ${fmtTime()}`);
      }
    } catch (e) { /* silent */ }
  }
}

// ══════════════════════════════════════════════════════════════════
// MAIN SCAN LOOP
// ══════════════════════════════════════════════════════════════════
let scanCount = 0;

async function runScan() {
  scanCount++;
  console.log(`\n[Scan #${scanCount}] ${new Date().toISOString()}`);

  const tokens = await scanTokens();
  console.log(`[Scan] ${tokens.length} tokens found`);

  let passed = 0, failed = 0, skipped = 0;
  const openCount = db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE status IN ('open','pending_limit')").get().c;

  for (const token of tokens) {
    try {
      // Skip if already scanned recently
      const existing = db.prepare("SELECT id FROM signals WHERE mint=? AND created_at > datetime('now','-30 minutes')").get(token.mint);
      if (existing) { skipped++; continue; }

      // Pre-filter
      const filterResult = applyFilters(token);

      // AI analysis (if API key available)
      let aiResult = null;
      if (CONFIG.OPENROUTER_API_KEY && filterResult.passed && openCount < CONFIG.MAX_OPEN_TRADES) {
        aiResult = await aiAnalyze(token);
      }

      const shouldBuy = aiResult?.action === 'BUY' || (!CONFIG.OPENROUTER_API_KEY && filterResult.passed);

      // Save signal
      const stmt = db.prepare(`INSERT INTO signals (mint, name, symbol, price_usd, liquidity_usd, market_cap_usd, volume_24h, volume_5m, price_change_5m, price_change_1h, price_change_24h, holder_count, tx_count_5m, buy_count_5m, sell_count_5m, age_minutes, dex, pair_address, filter_passed, filter_reasons, ai_action, ai_reasoning, ai_confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const result = stmt.run(
        token.mint, token.name, token.symbol, token.price_usd, token.liquidity_usd, token.market_cap_usd,
        token.volume_24h, token.volume_5m, token.price_change_5m, token.price_change_1h, token.price_change_24h,
        token.holder_count, token.tx_count_5m, token.buy_count_5m, token.sell_count_5m, token.age_minutes,
        token.dex, token.pair_address, shouldBuy ? 1 : 0, JSON.stringify(filterResult.reasons),
        aiResult?.action || 'SKIP', aiResult?.reasoning || '', aiResult?.confidence || 0
      );
      token.signalId = result.lastInsertRowid;

      if (shouldBuy && openCount < CONFIG.MAX_OPEN_TRADES && state.balance >= CONFIG.TRADE_SIZE_SOL) {
        passed++;
        const trade = openTrade(token, aiResult || { entry_price_usd: token.price_usd, tp_price_usd: token.price_usd * filterConfig.tpMultiplier, sl_price_usd: token.price_usd * filterConfig.slMultiplier, entry_type: 'limit', reasoning: 'Filter pass (no AI)' });
        await notifyEntry(trade, token, aiResult?.reasoning);
        console.log(`[PASS] ${token.symbol} (${fmtUSD(token.liquidity_usd)} liq) — ${trade.entry_type} @ $${fmtPrice(trade.entry_price)}`);
        await new Promise(r => setTimeout(r, 500));
        openCount++;
      } else {
        failed++;
      }
    } catch (e) { console.error(`[Scan] Error:`, e.message?.substring(0, 100)); }
  }

  console.log(`[Scan #${scanCount}] ${passed} passed, ${failed} failed, ${skipped} skipped`);

  // Update prices
  await updatePrices();
}

// ══════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/api/stats', (req, res) => {
  try {
    const ts = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('open','pending_limit') THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as wins, COALESCE(SUM(pnl_sol),0) as pnl FROM paper_trades").get();
    const ss = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN filter_passed=1 THEN 1 ELSE 0 END) as passed FROM signals").get();
    res.json({
      balance: state.balance, totalPnl: state.totalPnl, winRate: ts.closed > 0 ? (ts.wins/ts.closed) : 0,
      totalTrades: ts.total || 0, openPositions: ts.open || 0, closed: ts.closed || 0,
      wins: ts.wins || 0, losses: (ts.closed || 0) - (ts.wins || 0),
      totalSignals: ss.total || 0, passedFilter: ss.passed || 0,
      passRate: ss.total > 0 ? ((ss.passed/ss.total)*100) : 0,
      filterGeneration: filterConfig.generation, consecutiveLosses: state.consecutiveLosses,
    });
  } catch (e) { res.json({}); }
});

app.get('/api/signals', (req, res) => {
  try { res.json(db.prepare("SELECT * FROM signals ORDER BY created_at DESC LIMIT 50").all()); } catch (e) { res.json([]); }
});

app.get('/api/trades', (req, res) => {
  try {
    res.json({
      open: db.prepare("SELECT * FROM paper_trades WHERE status IN ('open','pending_limit') ORDER BY opened_at DESC").all(),
      closed: db.prepare("SELECT * FROM paper_trades WHERE status='closed' ORDER BY closed_at DESC LIMIT 50").all(),
    });
  } catch (e) { res.json({ open: [], closed: [] }); }
});

app.get('/api/filters', (req, res) => {
  res.json(filterConfig);
});

app.get('/api/filter-history', (req, res) => {
  try { res.json(db.prepare("SELECT * FROM filter_history ORDER BY id DESC LIMIT 10").all()); } catch (e) { res.json([]); }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Ponyin AI — Solana Trading Bot</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Courier New',monospace;background:#050509;color:#ccc;min-height:100vh}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#050509}::-webkit-scrollbar-thumb{background:#1e1e3a}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}@keyframes fadeIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}</style>
</head><body><div id="root"></div>
<script type="text/babel">
const {useState,useEffect,useCallback}=React;
const API='';
function fmtP(p){if(!p)return'?';if(p<0.00001)return p.toExponential(2);if(p<0.01)return p.toFixed(8);return p.toFixed(4)}
function fmtUSD(n){if(!n)return'$0';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+n.toFixed(0)}
function fmtTime(){return new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}

function App(){
  const[stats,setStats]=useState({});
  const[signals,setSignals]=useState([]);
  const[trades,setTrades]=useState({open:[],closed:[]});
  const[tab,setTab]=useState('signals');
  const[filters,setFilters]=useState({});

  const fetchData=useCallback(async()=>{
    try{
      const[s,sg,t,f]=await Promise.all([
        fetch('/api/stats').then(r=>r.json()),
        fetch('/api/signals').then(r=>r.json()),
        fetch('/api/trades').then(r=>r.json()),
        fetch('/api/filters').then(r=>r.json()),
      ]);
      setStats(s);setSignals(sg);setTrades(t);setFilters(f);
    }catch(e){}
  },[]);

  useEffect(()=>{fetchData();const i=setInterval(fetchData,10000);return()=>clearInterval(i);},[fetchData]);

  const openTrades=trades.open||[];
  const closedTrades=trades.closed||[];
  const passRate=stats.totalSignals>0?((stats.passedFilter/stats.totalSignals)*100).toFixed(1):0;
  const wr=stats.totalTrades>0?((stats.wins/stats.totalTrades)*100).toFixed(1):0;

  return(<div style={{minHeight:'100vh',background:'#050509'}}>
    {/* Header */}
    <div style={{background:'linear-gradient(90deg,#050509,#0a0a1a,#050509)',borderBottom:'1px solid #1e1e3a',padding:'12px 20px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <div>
        <div style={{fontSize:18,fontWeight:900,color:'#f7c948',letterSpacing:3}}>PONYIN <span style={{color:'#555'}}>◆</span> AI AGENT</div>
        <div style={{fontSize:9,color:'#333',letterSpacing:2}}>SOLANA MEME TRADING BOT v2.0</div>
      </div>
      <div style={{fontSize:10,fontFamily:'monospace',color:'#00ff9d',background:'#00ff9d11',border:'1px solid #00ff9d33',borderRadius:6,padding:'4px 10px',animation:'pulse 2s infinite'}}>● SCANNING</div>
    </div>

    {/* Stats */}
    <div style={{display:'flex',gap:8,padding:'12px 20px',flexWrap:'wrap',borderBottom:'1px solid #1e1e3a'}}>
      {[
       ['Balance',(stats.balance||0).toFixed(3)+' SOL',stats.balance>=1?'#00ff9d':'#ff3366'],
        ['PnL',(stats.totalPnl>=0?'+':'')+(stats.totalPnl||0).toFixed(4)+' SOL',stats.totalPnl>=0?'#00ff9d':'#ff3366'],
        ['Win Rate',wr+'%',wr>=55?'#00ff9d':'#ff6b35'],
        ['Trades',stats.totalTrades||0,'#f7c948'],
        ['Open',stats.openPositions||0,'#aaa'],
        ['Signals',stats.totalSignals||0,'#7aa8f0'],
        ['Pass Rate',passRate+'%','#7aa8f0'],
        ['Filter Gen','#'+filters.generation,'#555'],
      ].map(([l,v,c])=>(
        <div key={l} style={{background:'#0d0d1a',border:'1px solid #1e1e3a',borderRadius:8,padding:'8px 12px',minWidth:80,textAlign:'center'}}>
          <div style={{fontSize:16,fontWeight:700,color:c,fontFamily:'monospace'}}>{v}</div>
          <div style={{fontSize:9,color:'#444',marginTop:2,textTransform:'uppercase',letterSpacing:1}}>{l}</div>
        </div>
      ))}
    </div>

    {/* Tabs */}
    <div style={{display:'flex',gap:0,borderBottom:'1px solid #1e1e3a',padding:'0 20px'}}>
      {[['signals','🔍 Signals'],['trades','📊 Trades'],['filters','⚙️ Filters']].map(([k,l])=>(
        <button key={k} onClick={()=>setTab(k)} style={{background:'none',border:'none',borderBottom:'2px solid '+(tab===k?'#f7c948':'transparent'),color:tab===k?'#f7c948':'#444',padding:'10px 16px',fontSize:11,cursor:'pointer',fontWeight:600,letterSpacing:1,marginBottom:-1}}>{l}</button>
      ))}
    </div>

    {/* Content */}
    <div style={{display:'flex',height:'calc(100vh - 200px)'}}>
      <div style={{flex:1,overflowY:'auto',padding:16}}>

        {tab==='signals' && (<>
          <div style={{fontSize:11,color:'#555',marginBottom:10}}>Showing {signals.length} signals</div>
          {signals.length===0 && <div style={{textAlign:'center',padding:60,color:'#222'}}>Waiting for scan...</div>}
          {signals.map(s=>(
            <div key={s.id} style={{background:'linear-gradient(135deg,#0d0d1a,#12122a)',border:'1px solid '+(s.filter_passed?'#00ff9d33':'#1e1e3a'),borderRadius:10,padding:'12px 14px',marginBottom:8,animation:'fadeIn 0.3s ease'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div><span style={{fontWeight:800,color:'#f7c948'}}>{s.symbol}</span><span style={{fontSize:10,color:'#444',marginLeft:6}}>{s.name}</span></div>
                <div style={{background:(s.filter_passed?'#00ff9d22':'#ff336622'),border:'1px solid '+(s.filter_passed?'#00ff9d44':'#ff336644'),borderRadius:6,padding:'2px 8px',fontSize:11,fontWeight:700,color:s.filter_passed?'#00ff9d':'#ff3366'}}>{s.filter_passed?'PASS':'FAIL'}</div>
              </div>
              <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap',fontSize:11}}>
                {[['Liq',fmtUSD(s.liquidity_usd)],['MC',fmtUSD(s.market_cap_usd)],['Vol',fmtUSD(s.volume_24h)],['5m',(s.price_change_5m>=0?'+':'')+s.price_change_5m?.toFixed(1)+'%'],['Tx5m',s.tx_count_5m],['Age',s.age_minutes?.toFixed(0)+'m']].map(([k,v])=>(
                  <div key={k} style={{textAlign:'center',background:'#0a0a15',borderRadius:4,padding:'3px 6px'}}>
                    <div style={{color:'#444',fontSize:9}}>{k}</div>
                    <div style={{color:'#ccc',fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
              {s.ai_reasoning && <div style={{marginTop:6,fontSize:10,color:'#555',fontStyle:'italic'}}>AI: {s.ai_reasoning}</div>}
            </div>
          ))}
        </>)}

        {tab==='trades' && (<>
          <div style={{fontSize:13,color:'#f7c948',marginBottom:10,fontWeight:700}}>Open Positions ({openTrades.length})</div>
          {openTrades.length===0 && <div style={{textAlign:'center',padding:30,color:'#222'}}>No open positions</div>}
          {openTrades.map((t,i)=>{
            const pnl=t.current_price>0?((t.current_price-t.entry_price)/t.entry_price*100):0;
            const pnlSol=t.current_price>0?((t.current_price-t.entry_price)/t.entry_price*CONFIG.TRADE_SIZE_SOL-0.005):0;
            const col=pnl>=0?'#00ff9d':'#ff3366';
            return(<div key={i} style={{background:'#0d0d1a',border:'1px solid '+col+'33',borderRadius:10,padding:'10px 14px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div><span style={{fontWeight:700,color:'#f7c948'}}>{t.mint.substring(0,8)}...</span><span style={{fontSize:10,color:'#444',marginLeft:6}}>{t.entry_type}</span><span style={{fontSize:10,color:'#333',marginLeft:6}}>{t.status}</span></div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:col,fontFamily:'monospace'}}>{pnl>=0?'+':''}{pnl.toFixed(1)}% ({pnlSol>=0?'+':''}{pnlSol.toFixed(4)} SOL)</div>
                <div style={{fontSize:9,color:'#333'}}>Entry: {fmtP(t.entry_price)} | Now: {fmtP(t.current_price)}</div>
              </div>
            </div>);
          })}
          <div style={{fontSize:13,color:'#f7c948',margin:'20px 0 10px',fontWeight:700}}>Closed ({closedTrades.length})</div>
          {closedTrades.map((t,i)=>{
            const col=(t.pnl_sol||0)>=0?'#00ff9d':'#ff3366';
            return(<div key={i} style={{background:'#0d0d1a',border:'1px solid #1e1e3a',borderRadius:8,padding:'8px 12px',marginBottom:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontWeight:700,color:'#f7c948',fontSize:12}}>{t.mint.substring(0,8)}...</span>
              <span style={{fontWeight:700,color:col,fontFamily:'monospace',fontSize:12}}>{(t.pnl_sol>=0?'+':'')+(t.pnl_sol||0).toFixed(4)} SOL ({(t.pnl_pct>=0?'+':'')+(t.pnl_pct||0).toFixed(1)}%)</span>
            </div>);
          })}
        </>)}

        {tab==='filters' && (<>
          <div style={{fontSize:13,color:'#f7c948',marginBottom:10,fontWeight:700}}>Filter Config (Gen #{filters.generation})</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            {Object.entries(filters).filter(([k])=>!['generation'].includes(k)).map(([k,v])=>(
              <div key={k} style={{background:'#0d0d1a',border:'1px solid #1e1e3a',borderRadius:8,padding:'8px 12px'}}>
                <div style={{fontSize:9,color:'#444',textTransform:'uppercase'}}>{k}</div>
                <div style={{fontSize:14,fontWeight:700,color:'#ccc',fontFamily:'monospace'}}>{typeof v==='number'?v.toLocaleString():v}</div>
              </div>
            ))}
          </div>
        </>)}
      </div>

      {/* Right: AI Panel */}
      <div style={{width:260,borderLeft:'1px solid #1e1e3a',overflowY:'auto',padding:12}}>
        <div style={{background:'linear-gradient(135deg,#080814,#0e0e1e)',border:'1px solid #1e1e3a',borderRadius:14,padding:16}}>
          <div style={{fontWeight:700,fontSize:13,color:'#f7c948',letterSpacing:2,textTransform:'uppercase',marginBottom:14}}>🧠 AI Agent</div>
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'#555',marginBottom:4}}><span>CONFIDENCE</span><span style={{color:'#00ff9d'}}>{Math.min(95,50+(state.totalTrades||0)*2+(parseFloat(passRate)||0)*0.3).toFixed(0)}%</span></div>
            <div style={{background:'#0d0d1a',borderRadius:4,height:6,overflow:'hidden'}}>
              <div style={{width:Math.min(95,50+(state.totalTrades||0)*2+(parseFloat(passRate)||0)*0.3)+'%',height:'100%',background:'linear-gradient(90deg,#f7c948,#00ff9d)',borderRadius:4,transition:'width 1s ease'}}/>
            </div>
          </div>
          <div style={{fontSize:10,color:'#555',marginBottom:6}}>Consecutive Losses: <span style={{color:state.consecutiveLosses>=2?'#ff3366':'#00ff9d'}}>{state.consecutiveLosses||0}/{CONFIG.CONSECUTIVE_LOSS_TRIGGER}</span></div>
          <div style={{fontSize:10,color:'#555',marginBottom:6}}>AI Model: <span style={{color:'#7aa8f0'}}>{CONFIG.AI_MODEL.includes('sonnet')?'Claude Sonet 4':'Claude'}</span></div>
          <div style={{fontSize:10,color:'#555',marginBottom:6}}>API Key: <span style={{color:CONFIG.OPENROUTER_API_KEY?'#00ff9d':'#ff3366'}}>{CONFIG.OPENROUTER_API_KEY?'Set ✓':'Not Set ✗'}</span></div>
          <div style={{fontSize:10,color:'#333',textAlign:'center',marginTop:20}}>Auto-improve after {CONFIG.CONSECUTIVE_LOSS_TRIGGER}x loss</div>
        </div>
      </div>
    </div>
  </div>);
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script></body></html>`);
});

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
  console.log('🚀 PONYIN AI AGENT — Solana Meme Trading Bot');
  console.log(`📡 RPC: ${CONFIG.RPC_URL.substring(0, 50)}...`);
  console.log(`💼 Balance: ${state.balance} SOL | Trade: ${CONFIG.TRADE_SIZE_SOL} SOL`);
  console.log(`🎯 TP: +${((filterConfig.tpMultiplier-1)*100).toFixed(0)}% | SL: -${((1-filterConfig.slMultiplier)*100).toFixed(0)}%`);
  console.log(`🤖 AI: ${CONFIG.AI_MODEL} ${CONFIG.OPENROUTER_API_KEY ? '✓' : '(no key — filter-only mode)'}`);
  console.log(`📊 Filter Gen: #${filterConfig.generation}`);

  // Dashboard
  app.listen(CONFIG.DASHBOARD_PORT, () => {
    console.log(`[Dashboard] http://localhost:${CONFIG.DASHBOARD_PORT}`);
  });

  // Notify start
  await sendTelegram(`🚀 <b>PONYIN AI AGENT STARTED</b>\n\n💼 Balance: ${state.balance} SOL\n💵 Trade: ${CONFIG.TRADE_SIZE_SOL} SOL\n🎯 TP: +${((filterConfig.tpMultiplier-1)*100).toFixed(0)}% | SL: -${((1-filterConfig.slMultiplier)*100).toFixed(0)}%\n🤖 AI: ${CONFIG.AI_MODEL} ${CONFIG.OPENROUTER_API_KEY ? '✓' : '(filter-only)'}\n📊 Filter Gen: #${filterConfig.generation}\n\nDashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);

  // Initial scan
  await runScan();

  // Scan loop
  setInterval(runScan, CONFIG.SCAN_INTERVAL_MS);

  // Price monitor (every 15s)
  setInterval(updatePrices, 15000);

  // Hourly report
  setInterval(async () => {
    console.log('[Cron] Generating hourly report...');
    await notifyHourly();
  }, CONFIG.REPORT_INTERVAL_MS);

  console.log(`\n✅ Bot running! Scan every ${CONFIG.SCAN_INTERVAL_MS/1000}s`);
  console.log(`📊 Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
  console.log(`⏰ Reports: Every ${CONFIG.REPORT_INTERVAL_MS/60000} min\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
