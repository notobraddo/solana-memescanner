/**
 * Token Scanner — DexScreener primary (Pump.fun blocked by Cloudflare)
 * Filters: Liquidity >$20K, LP Burn, Holder concentration
 * No BubbleMaps (no API key) — bundle check skipped
 * No Global Fee (too heavy) — replaced with tx volume check
 */
import axios from 'axios';
import { CONFIG } from './config.js';
import db from './db.js';
import {
  notifyEntry, notifyTP, notifySL,
  notifyHourlyReport, notifyScannerStart
} from './telegram.js';

// ─── DexScreener Scanner ─────────────────────────────────────────────

async function scanDexScreener() {
  try {
    // Use multiple queries to find new pairs
    const queries = ['pump solana', 'pump fun', 'new solana'];
    const allPairs = [];

    for (const q of queries) {
      try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/search', {
          params: { q, limit: 30 },
          timeout: 15000,
        });
        const pairs = res.data?.pairs || [];
        allPairs.push(...pairs);
      } catch (err) {
        console.warn(`[DexScreener] Query "${q}" failed:`, err.message);
      }
    }

    console.log(`[DexScreener] ${allPairs.length} total pairs from ${queries.length} queries`);

    // Filter: Solana only, has liquidity data
    const excludeMints = new Set([
      'So11111111111111111111111111111111111111112', // wSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);

    // Only exclude exact matches for well-known tokens
    const excludeSymbols = new Set([
      'sol', 'wsol', 'usdc', 'usdt', 'bonk', 'wif', 'popcat', 'bome',
      'myro', 'wen', 'jup', 'pyth', 'ray', 'orca', 'msol', 'bsol',
      'hnt', 'render', 'inf',
    ]);

    const seen = new Set();
    const results = [];
    for (const p of allPairs) {
      if (p.chainId !== 'solana') continue;
      const mint = p.baseToken?.address || '';
      if (excludeMints.has(mint)) continue;
      if (seen.has(mint)) continue;
      seen.add(mint);

      const symbol = (p.baseToken?.symbol || '').toLowerCase();
      if (excludeSymbols.has(symbol)) continue;

      const liq = p.liquidity?.usd || 0;
      if (liq < 5000) continue; // Pre-filter very low liquidity

      results.push({
        mint,
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '?',
        price_usd: parseFloat(p.priceUsd) || 0,
        liquidity_usd: liq,
        market_cap_usd: p.fdv || p.marketCap || 0,
        volume_24h: p.volume?.h24 || 0,
        txns_24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
        buys_24h: p.txns?.h24?.buys || 0,
        sells_24h: p.txns?.h24?.sells || 0,
        price_change_5m: p.priceChange?.m5 || 0,
        price_change_1h: p.priceChange?.h1 || 0,
        price_change_24h: p.priceChange?.h24 || 0,
        pairAddress: p.pairAddress || '',
        dexId: p.dexId || '',
        created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : new Date().toISOString(),
        source: 'dexscreener',
      });
    }

    console.log(`[DexScreener] ${results.length} after pre-filter`);
    return results;
  } catch (err) {
    console.error('[DexScreener] Error:', err.message);
    return [];
  }
}

// ─── LP Burn Check (simplified) ─────────────────────────────────────

async function checkLPBurn(mint) {
  try {
    // Use Helius or Alchemy RPC to check if mint authority is renounced
    // Renounced mint authority = tokens can't be minted = safer
    const res = await axios.post(CONFIG.RPC_URL, {
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [mint, { encoding: 'jsonParsed' }],
    }, { timeout: 10000 });

    const info = res.data?.result?.value?.data?.parsed?.info;
    if (!info) return { burned: false, mint_authority: null };

    // If mintAuthority is null/None, it's renounced
    const mintAuthority = info.mintAuthority;
    const isRenounced = !mintAuthority || mintAuthority === 'null';

    return {
      burned: isRenounced,
      mint_authority: mintAuthority ? 'active' : 'renounced',
    };
  } catch {
    return { burned: false, mint_authority: 'unknown' };
  }
}

// ─── Holder Analysis (simplified) ───────────────────────────────────

async function analyzeHolders(mint) {
  try {
    const res = await axios.post(CONFIG.RPC_URL, {
      jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts',
      params: [mint, { commitment: 'confirmed' }],
    }, { timeout: 10000 });

    const accounts = res.data?.result?.value || [];
    if (!accounts.length) return { holder_count: 0, top10_pct: 100, top1_supply_pct: 0 };

    // Get total supply
    const supplyRes = await axios.post(CONFIG.RPC_URL, {
      jsonrpc: '2.0', id: 2, method: 'getTokenSupply',
      params: [mint],
    }, { timeout: 10000 });

    const totalSupply = supplyRes.data?.result?.value?.uiAmount || 0;
    if (totalSupply === 0) return { holder_count: accounts.length, top10_pct: 100, top1_supply_pct: 0 };

    let top10Amount = 0;
    let top1Amount = 0;

    for (let i = 0; i < accounts.length; i++) {
      const amount = parseFloat(accounts[i].uiAmount || 0);
      if (i < 10) top10Amount += amount;
      if (i === 0) top1Amount = amount;
    }

    return {
      holder_count: accounts.length,
      top10_pct: (top10Amount / totalSupply) * 100,
      top1_supply_pct: (top1Amount / totalSupply) * 100,
    };
  } catch {
    // RPC error — return neutral values (don't reject token just because RPC failed)
    return { holder_count: 50, top10_pct: 30, top1_supply_pct: 10 };
  }
}

// ─── Filter Engine ───────────────────────────────────────────────────

async function applyFilters(token) {
  const reasons = [];
  let passed = true;
  let score = 0; // 0-100 score

  // 1. Liquidity > $20K (hard filter)
  if (token.liquidity_usd < CONFIG.MIN_LIQUIDITY_USD) {
    reasons.push(`❌ Liquidity $${Math.round(token.liquidity_usd).toLocaleString()} < $${CONFIG.MIN_LIQUIDITY_USD.toLocaleString()}`);
    passed = false;
  } else {
    reasons.push(`✅ Liquidity $${Math.round(token.liquidity_usd).toLocaleString()}`);
    score += 25;
  }

  // 2. Volume check (soft filter — needs some activity)
  if (token.volume_24h < 1000) {
    reasons.push(`❌ Volume 24h $${Math.round(token.volume_24h).toLocaleString()} < $1,000`);
    // Soft fail — don't reject but penalize
    score -= 10;
  } else {
    reasons.push(`✅ Volume 24h $${Math.round(token.volume_24h).toLocaleString()}`);
    score += 15;
  }

  // 3. Mint authority renounced (replaces LP burn check)
  const mintAuth = await checkLPBurn(token.mint);
  if (mintAuth.burned) {
    reasons.push(`✅ Mint authority renounced`);
    score += 20;
  } else {
    reasons.push(`⚠️ Mint authority: ${mintAuth.mint_authority}`);
    score += 5; // Soft penalty, not hard fail
  }

  // 4. Holder analysis
  const holders = await analyzeHolders(token.mint);

  if (holders.top10_pct > 70) {
    reasons.push(`❌ Top 10 holders ${holders.top10_pct.toFixed(1)}% > 70%`);
    passed = false;
  } else if (holders.top10_pct > CONFIG.MAX_TOP10_HOLDER_PCT) {
    reasons.push(`⚠️ Top 10 holders ${holders.top10_pct.toFixed(1)}% > ${CONFIG.MAX_TOP10_HOLDER_PCT}%`);
    score += 5;
  } else {
    reasons.push(`✅ Top 10 holders ${holders.top10_pct.toFixed(1)}%`);
    score += 20;
  }

  if (holders.top1_supply_pct > 40) {
    reasons.push(`❌ Top 1 holder ${holders.top1_supply_pct.toFixed(1)}% > 40%`);
    passed = false;
  } else {
    score += 10;
  }

  if (holders.holder_count < 10) {
    reasons.push(`⚠️ Only ${holders.holder_count} holders`);
    score -= 5;
  } else {
    reasons.push(`✅ ${holders.holder_count} holders`);
    score += 10;
  }

  // 5. Bundle check — no API key, skip (neutral)
  reasons.push(`ℹ️ Bundle check: skipped (no BubbleMaps key)`);

  // Calculate age in minutes
  const pairAge = token.created_at ? (Date.now() - new Date(token.created_at).getTime()) / 60000 : 0;

  return {
    ...token,
    bundle_score: 0,
    bundle_count: 0,
    lp_burned: mintAuth.burned ? 1 : 0,
    holder_count: holders.holder_count,
    top10_holder_pct: holders.top10_pct,
    top1_supply_pct: holders.top1_supply_pct,
    global_fee_ratio: 0,
    filter_passed: passed && score >= 40 ? 1 : 0,
    filter_score: score,
    filter_reasons: JSON.stringify(reasons),
    age_minutes: Math.round(pairAge),
    dev_risk: 'LOW',
    dev_score: 0,
  };
}

// ─── Paper Trade Manager ─────────────────────────────────────────────

function openPaperTrade(signal) {
  const entryPrice = signal.price_usd;
  if (!entryPrice || entryPrice <= 0) return null;

  const tp1Price = entryPrice * (1 + CONFIG.DEFAULT_TP1_PCT / 100);
  const tp2Price = entryPrice * (1 + CONFIG.DEFAULT_TP2_PCT / 100);
  const tp3Price = entryPrice * (1 + CONFIG.DEFAULT_TP3_PCT / 100);
  const slPrice = entryPrice * (1 - CONFIG.DEFAULT_SL_PCT / 100);
  const entryType = CONFIG.DEFAULT_ENTRY_MODE;

  const stmt = db.prepare(`
    INSERT INTO paper_trades (signal_id, mint, entry_price, tp_price, sl_price, amount_sol, fee_sol, entry_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `);
  const result = stmt.run(signal.id, signal.mint, entryPrice, tp1Price, slPrice, CONFIG.MODAL_PER_TRADE, CONFIG.FEE_PER_TRADE, entryType);

  return {
    id: result.lastInsertRowid,
    mint: signal.mint,
    entry_price: entryPrice,
    tp_price: tp1Price,
    tp2_price: tp2Price,
    tp3_price: tp3Price,
    sl_price: slPrice,
    entry_type: entryType,
  };
}

// ─── Price Monitor ───────────────────────────────────────────────────

async function getCurrentPrice(mint) {
  try {
    const res = await axios.get(`https://price.jup.ag/v6/price?ids=${mint}`, { timeout: 10000 });
    return res.data?.data?.[mint]?.price || null;
  } catch {
    return null;
  }
}

async function monitorPositions() {
  const openTrades = db.prepare(`
    SELECT pt.*, s.name, s.symbol FROM paper_trades pt
    LEFT JOIN signals s ON pt.signal_id = s.id
    WHERE pt.status = 'open'
  `).all();

  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const currentPrice = await getCurrentPrice(trade.mint);
      if (!currentPrice) continue;

      if (currentPrice >= trade.tp_price) {
        const pnl_pct = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
        const pnl_sol = (CONFIG.MODAL_PER_TRADE * pnl_pct / 100) - CONFIG.FEE_PER_TRADE;

        db.prepare(`
          UPDATE paper_trades SET status='closed', exit_price=?, tp_hit=1, pnl_sol=?, pnl_pct=?, exit_time=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(currentPrice, pnl_sol, pnl_pct, trade.id);

        await notifyTP({ ...trade, exit_price: currentPrice, pnl_sol, pnl_pct });
        console.log(`[TP] ${trade.name}: +${pnl_pct.toFixed(1)}% (+${pnl_sol.toFixed(3)} SOL)`);
      } else if (currentPrice <= trade.sl_price) {
        const pnl_pct = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
        const pnl_sol = (CONFIG.MODAL_PER_TRADE * pnl_pct / 100) - CONFIG.FEE_PER_TRADE;

        db.prepare(`
          UPDATE paper_trades SET status='closed', exit_price=?, sl_hit=1, pnl_sol=?, pnl_pct=?, exit_time=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(currentPrice, pnl_sol, pnl_pct, trade.id);

        await notifySL({ ...trade, exit_price: currentPrice, pnl_sol, pnl_pct });
        console.log(`[SL] ${trade.name}: ${pnl_pct.toFixed(1)}% (${pnl_sol.toFixed(3)} SOL)`);
      }
    } catch (err) {
      console.error(`[Monitor] Error:`, err.message);
    }
  }
}

// ─── Hourly Report ───────────────────────────────────────────────────

export async function generateHourlyReport() {
  const now = new Date();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();

  const stats = db.prepare(`
    SELECT COUNT(*) as total_signals,
           SUM(CASE WHEN filter_passed = 1 THEN 1 ELSE 0 END) as passed_filter
    FROM signals WHERE created_at >= ?
  `).get(hourAgo);

  const tradeStats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as opened,
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
           SUM(CASE WHEN status = 'closed' AND pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN status = 'closed' AND pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
           COALESCE(SUM(pnl_sol), 0) as total_pnl,
           COALESCE(AVG(pnl_pct), 0) as avg_pnl,
           COALESCE(MAX(pnl_pct), 0) as best_pct,
           COALESCE(MIN(pnl_pct), 0) as worst_pct
    FROM paper_trades WHERE entry_time >= ?
  `).get(hourAgo);

  const closed = tradeStats?.closed || 0;
  const wins = tradeStats?.wins || 0;

  const report = {
    report_hour: now.toISOString(),
    total_signals: stats?.total_signals || 0,
    passed_filter: stats?.passed_filter || 0,
    trades_opened: tradeStats?.opened || 0,
    trades_closed: closed,
    wins,
    losses: tradeStats?.losses || 0,
    total_pnl_sol: tradeStats?.total_pnl || 0,
    avg_pnl_pct: tradeStats?.avg_pnl || 0,
    best_trade_pct: tradeStats?.best_pct || 0,
    worst_trade_pct: tradeStats?.worst_pct || 0,
    win_rate: closed > 0 ? wins / closed : 0,
  };

  db.prepare(`
    INSERT INTO hourly_reports (report_hour, total_signals, passed_filter, trades_opened, trades_closed, wins, losses, total_pnl_sol, avg_pnl_pct, best_trade_pct, worst_trade_pct, win_rate, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.report_hour, report.total_signals, report.passed_filter,
    report.trades_opened, report.trades_closed, report.wins, report.losses,
    report.total_pnl_sol, report.avg_pnl_pct, report.best_trade_pct,
    report.worst_trade_pct, report.win_rate, JSON.stringify(report)
  );

  await notifyHourlyReport(report);
  console.log(`[Report] Win rate: ${(report.win_rate * 100).toFixed(1)}% | PnL: ${report.total_pnl_sol.toFixed(3)} SOL`);
}

// ─── Main Scan Loop ─────────────────────────────────────────────────

let scanCount = 0;

export async function runScan() {
  scanCount++;
  console.log(`\n[Scan #${scanCount}] ${new Date().toISOString()}`);

  // 1. Scan DexScreener
  const tokens = await scanDexScreener();
  console.log(`[Scan] ${tokens.length} tokens to check`);

  let passed = 0;
  let failed = 0;

  // 2. Apply filters
  for (const token of tokens) {
    try {
      // Skip if scanned in last 30 min
      const existing = db.prepare("SELECT id FROM signals WHERE mint = ? AND created_at > datetime('now', '-30 minutes')").get(token.mint);
      if (existing) continue;

      const filtered = await applyFilters(token);

      // Save signal
      const stmt = db.prepare(`
        INSERT INTO signals (mint, name, symbol, price_usd, liquidity_usd, market_cap_usd, bundle_score, bundle_count, lp_burned, holder_count, top10_holder_pct, global_fee_ratio, filter_passed, filter_reasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        filtered.mint, filtered.name, filtered.symbol, filtered.price_usd,
        filtered.liquidity_usd, filtered.market_cap_usd, filtered.bundle_score,
        filtered.bundle_count, filtered.lp_burned, filtered.holder_count,
        filtered.top10_holder_pct, filtered.global_fee_ratio, filtered.filter_passed,
        filtered.filter_reasons
      );
      filtered.id = result.lastInsertRowid;

      if (filtered.filter_passed) {
        passed++;
        const trade = openPaperTrade(filtered);
        if (trade) {
          await notifyEntry(trade, filtered);
          console.log(`[PASS] ${filtered.name} ($${Math.round(filtered.liquidity_usd).toLocaleString()} liq) — Paper trade opened`);
          // Small delay to avoid Telegram rate limit
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        failed++;
        console.log(`[FAIL] ${filtered.name} (score: ${filtered.filter_score})`);
      }
    } catch (err) {
      console.error(`[Scan] Error ${token.mint}:`, err.message);
    }
  }

  console.log(`[Scan #${scanCount}] Done: ${passed} passed, ${failed} failed`);

  // 3. Monitor open positions
  await monitorPositions();
}

export { notifyScannerStart };
