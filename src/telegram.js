/**
 * Telegram notifier — send alerts for entries, TP/SL hits, reports
 */
import { execSync } from 'child_process';
import { CONFIG } from './config.js';

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;

async function sendTelegram(text) {
  try {
    const escapedText = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const cmd = `curl -s --max-time 15 -X POST "${TELEGRAM_API}/sendMessage" -d "chat_id=${CONFIG.TELEGRAM_CHAT_ID}" -d "text=${escapedText}" -d "parse_mode=HTML" -d "disable_webpage_preview=true" 2>&1`;
    const result = execSync(cmd, { timeout: 20000, maxBuffer: 1024 * 1024 }).toString();
    const data = JSON.parse(result);
    if (!data?.ok) {
      console.error('[Telegram] API error:', result.substring(0, 200));
    }
    return data;
  } catch (err) {
    console.error('[Telegram] Error:', err.message?.substring(0, 100) || 'unknown');
    return null;
  }
}

function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPrice(p) {
  if (!p) return '?';
  if (p < 0.00001) return p.toExponential(2);
  if (p < 0.01) return p.toFixed(8);
  return p.toFixed(4);
}

function formatUSD(n) {
  if (!n) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function formatTime() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── ENTRY NOTIFICATION (main format) ───────────────────────────────────

export async function notifyEntry(trade, signal) {
  const name = esc(signal.name || 'Unknown');
  const symbol = esc(signal.symbol || '?');
  const mint = esc(trade.mint || '');
  const entryPrice = trade.entry_price || signal.price_usd || 0;
  const liq = signal.liquidity_usd || 0;
  const mcap = signal.market_cap_usd || signal.fdv || 0;
  const vol24h = signal.volume_24h || 0;
  const txns24h = signal.txns_24h || 0;
  const buys24h = signal.buys_24h || Math.floor(txns24h * 0.55);
  const sells24h = signal.sells_24h || Math.floor(txns24h * 0.45);
  const priceChange5m = signal.price_change_5m || 0;
  const priceChange1h = signal.price_change_1h || 0;
  const priceChange24h = signal.price_change_24h || 0;
  const isRenounced = signal.lp_burned ? 'Renounced' : 'Active';
  const devRisk = signal.dev_risk || 'LOW';
  const devScore = signal.dev_score || 0;
  const ageMinutes = signal.age_minutes || 0;
  const ageHours = (ageMinutes / 60).toFixed(1);
  const score = signal.filter_score || 0;
  const entryMode = trade.entry_type || CONFIG.DEFAULT_ENTRY_MODE;

  // TP levels
  const tp1 = entryPrice * (1 + CONFIG.DEFAULT_TP1_PCT / 100);
  const tp2 = entryPrice * (1 + CONFIG.DEFAULT_TP2_PCT / 100);
  const tp3 = entryPrice * (1 + CONFIG.DEFAULT_TP3_PCT / 100);
  const sl = entryPrice * (1 - CONFIG.DEFAULT_SL_PCT / 100);

  // Positif points
  const positif = [];
  if (liq >= 50000) positif.push(`✅ Liq good: ${formatUSD(liq)}`);
  else if (liq >= 20000) positif.push(`✅ Liq ok: ${formatUSD(liq)}`);
  if (vol24h >= 100000) positif.push(`✅ Vol high: ${formatUSD(vol24h)}`);
  else if (vol24h >= 10000) positif.push(`✅ Vol ok: ${formatUSD(vol24h)}`);
  if (txns24h >= 1000) positif.push(`✅ Healthy txns: ${txns24h.toLocaleString()} (buy: ${((buys24h / txns24h) * 100).toFixed(0)}%)`);
  if (isRenounced === 'Renounced') positif.push(`🔒 Contract: Renounced`);
  if (ageHours >= 1 && ageHours <= 48) positif.push(`✅ Age: ${ageHours}h`);
  if (signal.has_twitter) positif.push(`🐦 Twitter`);
  if (signal.has_website) positif.push(`🌐 Website`);
  if (signal.has_telegram) positif.push(`💬 Telegram`);

  // Negatif points
  const negatif = [];
  if (signal.top10_holder_pct > 50) negatif.push(`⚠️ Top10 high: ${signal.top10_holder_pct.toFixed(1)}%`);
  if (signal.top1_supply_pct > 20) negatif.push(`⚠️ Top1 whale: ${signal.top1_supply_pct.toFixed(1)}%`);
  if (signal.holder_count < 50) negatif.push(`⚠️ Low holders: ${signal.holder_count}`);
  if (priceChange24h > 500) negatif.push(`⚠️ Pumped hard: +${priceChange24h.toFixed(0)}%`);

  const modeIcon = entryMode === 'LIMIT' ? '🟡' : '🟢';
  const modeLabel = entryMode === 'LIMIT' ? 'LIMIT' : 'MARKET';

  let msg = `${modeIcon} <b>${modeLabel}</b> | ${name} | ${symbol}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 Score: <b>${score}/100</b>\n`;
  msg += `💰 MC: <b>${formatUSD(mcap)}</b> | FDV: ${formatUSD(mcap)}\n`;
  msg += `💧 Liq: <b>${formatUSD(liq)}</b>\n`;
  msg += `📊 Vol 24h: <b>${formatUSD(vol24h)}</b>\n`;
  msg += `📈 Txns: ${txns24h.toLocaleString()} (Buy: ${buys24h.toLocaleString()} | Sell: ${sells24h.toLocaleString()})\n`;
  msg += `⏰ ${formatTime()} WIB\n`;
  msg += `📉 Price: 5m:${priceChange5m >= 0 ? '+' : ''}${priceChange5m.toFixed(1)}% 1h:${priceChange1h >= 0 ? '+' : ''}${priceChange1h.toFixed(1)}% 24h:${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(1)}%\n`;
  msg += `🔒 Contract: ${isRenounced}\n`;
  msg += `🟢 Dev Risk: ${devRisk} (${devScore}/100)\n\n`;

  msg += `🎯 Entry: <code>$${formatPrice(entryPrice)}</code>\n`;
  msg += `📈 TP1: +${CONFIG.DEFAULT_TP1_PCT}% | TP2: +${CONFIG.DEFAULT_TP2_PCT}% | TP3: +${CONFIG.DEFAULT_TP3_PCT}%\n`;
  msg += `🛑 SL: -${CONFIG.DEFAULT_SL_PCT}%\n`;
  msg += `⏱ Timeframe: Swing (12-48 jam)\n\n`;

  if (positif.length > 0) {
    msg += `✅ Positif:\n`;
    positif.forEach(p => msg += `  ${p}\n`);
  }

  if (negatif.length > 0) {
    msg += `\n⚠️ Watch:\n`;
    negatif.forEach(n => msg += `  ${n}\n`);
  }

  msg += `\n🔗 <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>\n`;
  msg += `💰 Wallet: ${CONFIG.WALLET_BALANCE_SOL} SOL | Entry: ${CONFIG.MODAL_PER_TRADE} SOL`;

  return sendTelegram(msg);
}

// ─── TP HIT ─────────────────────────────────────────────────────────────

export async function notifyTP(trade, signal) {
  const name = esc(signal.name || 'Unknown');
  const pnlPct = trade.pnl_pct || 0;
  const pnlSol = trade.pnl_sol || 0;
  const tpLevel = trade.tp_hit === 1 ? 'TP1' : trade.tp_hit === 2 ? 'TP2' : 'TP3';

  let msg = `🎯 <b>${tpLevel} HIT!</b> | ${name}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Entry: $${formatPrice(trade.entry_price)}\n`;
  msg += `🎯 Exit: $${formatPrice(trade.exit_price)}\n`;
  msg += `📈 PnL: <b>+${pnlPct.toFixed(1)}% (+${pnlSol.toFixed(4)} SOL)</b>\n`;
  msg += `💵 Size: ${CONFIG.MODAL_PER_TRADE} SOL\n`;
  msg += `⏰ ${formatTime()} WIB\n\n`;
  msg += `🔗 <a href="https://dexscreener.com/solana/${esc(trade.mint)}">DexScreener</a>`;

  return sendTelegram(msg);
}

// ─── SL HIT ─────────────────────────────────────────────────────────────

export async function notifySL(trade, signal) {
  const name = esc(signal.name || 'Unknown');
  const pnlPct = trade.pnl_pct || 0;
  const pnlSol = trade.pnl_sol || 0;

  let msg = `🛑 <b>STOP LOSS HIT!</b> | ${name}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Entry: $${formatPrice(trade.entry_price)}\n`;
  msg += `🛑 Exit: $${formatPrice(trade.exit_price)}\n`;
  msg += `📉 PnL: <b>${pnlPct.toFixed(1)}% (${pnlSol.toFixed(4)} SOL)</b>\n`;
  msg += `💵 Size: ${CONFIG.MODAL_PER_TRADE} SOL\n`;
  msg += `⏰ ${formatTime()} WIB\n\n`;
  msg += `🔗 <a href="https://dexscreener.com/solana/${esc(trade.mint)}">DexScreener</a>`;

  return sendTelegram(msg);
}

// ─── LIMIT FILLED ───────────────────────────────────────────────────────

export async function notifyLimitEntry(trade, signal) {
  const name = esc(signal.name || 'Unknown');

  let msg = `🟡 <b>LIMIT FILLED</b> | ${name}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Entry: $${formatPrice(trade.entry_price)}\n`;
  msg += `💵 Size: ${CONFIG.MODAL_PER_TRADE} SOL\n`;
  msg += `📈 TP1: +${CONFIG.DEFAULT_TP1_PCT}% | TP2: +${CONFIG.DEFAULT_TP2_PCT}% | TP3: +${CONFIG.DEFAULT_TP3_PCT}%\n`;
  msg += `🛑 SL: -${CONFIG.DEFAULT_SL_PCT}%\n`;
  msg += `⏰ ${formatTime()} WIB\n\n`;
  msg += `🔗 <a href="https://dexscreener.com/solana/${esc(trade.mint)}">DexScreener</a>`;

  return sendTelegram(msg);
}

// ─── HOURLY REPORT ──────────────────────────────────────────────────────

export async function notifyHourlyReport(report) {
  let msg = `📊 <b>HOURLY REPORT</b>\n\n`;
  msg += `⏰ ${report.report_hour}\n\n`;
  msg += `📡 Signals: ${report.total_signals}\n`;
  msg += `✅ Passed: ${report.passed_filter}\n`;
  msg += `📈 Opened: ${report.trades_opened}\n`;
  msg += `📉 Closed: ${report.trades_closed}\n\n`;
  msg += `🏆 Wins: ${report.wins}\n`;
  msg += `💀 Losses: ${report.losses}\n`;
  msg += `📊 Win Rate: <b>${(report.win_rate * 100).toFixed(1)}%</b>\n\n`;
  msg += `💰 PnL: <b>${report.total_pnl_sol >= 0 ? '+' : ''}${report.total_pnl_sol.toFixed(4)} SOL</b>\n`;
  msg += `📊 Avg: ${report.avg_pnl_pct >= 0 ? '+' : ''}${report.avg_pnl_pct.toFixed(1)}%\n`;
  msg += `🚀 Best: +${report.best_trade_pct.toFixed(1)}%\n`;
  msg += `💥 Worst: ${report.worst_trade_pct.toFixed(1)}%\n\n`;
  msg += `💵 Wallet: ${CONFIG.WALLET_BALANCE_SOL} SOL | Per trade: ${CONFIG.MODAL_PER_TRADE} SOL`;

  return sendTelegram(msg);
}

// ─── SCANNER START ──────────────────────────────────────────────────────

export async function notifyScannerStart() {
  let msg = `🚀 <b>MEME SCANNER STARTED</b>\n\n`;
  msg += `📡 DexScreener + Pump.fun\n`;
  msg += `💧 Min Liquidity: $20,000\n`;
  msg += `📊 Filters: Bundle, LP Burn, Holders\n`;
  msg += `💵 Wallet: ${CONFIG.WALLET_BALANCE_SOL} SOL | Entry: ${CONFIG.MODAL_PER_TRADE} SOL\n`;
  msg += `🎯 TP1/TP2/TP3: +${CONFIG.DEFAULT_TP1_PCT}%/+${CONFIG.DEFAULT_TP2_PCT}%/+${CONFIG.DEFAULT_TP3_PCT}%\n`;
  msg += `🛑 SL: -${CONFIG.DEFAULT_SL_PCT}%\n`;
  msg += `⏰ Report: Every ${CONFIG.REPORT_INTERVAL_MIN} min\n\n`;
  msg += `Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`;

  return sendTelegram(msg);
}
