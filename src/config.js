/**
 * Config — all tunable parameters
 */
export const CONFIG = {
  // Telegram
TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '1404877677',

  // Trading — wallet 1 SOL, entry 0.03 SOL per trade
  WALLET_BALANCE_SOL: 1.0,
  MODAL_PER_TRADE: 0.03,        // SOL per trade
  FEE_PER_TRADE: 0.005,         // SOL (gas/transaction cost)
  DEFAULT_TP1_PCT: 20,          // TP1: +20%
  DEFAULT_TP2_PCT: 50,          // TP2: +50%
  DEFAULT_TP3_PCT: 100,         // TP3: +100%
  DEFAULT_SL_PCT: 10,           // SL: -10%
  DEFAULT_ENTRY_MODE: 'LIMIT',  // LIMIT or MARKET

  // Filters
  MIN_LIQUIDITY_USD: 20000,
  MAX_BUNDLE_SCORE: 30,
  MAX_BUNDLE_COUNT: 3,
  MIN_LP_BURNED: 1,
  MAX_TOP10_HOLDER_PCT: 40,
  MIN_GLOBAL_FEE_RATIO: 0.008,
  MIN_HOLDER_COUNT: 20,

  // Scan interval
  SCAN_INTERVAL_MS: 60000,
  REPORT_INTERVAL_MIN: 60,

  // Solana
  RPC_URL: 'https://solana-mainnet.g.alchemy.com/v2/TM1nScPxx_HBO9PfNOLBRHZku5Swb_Ac',
  FALLBACK_RPCS: [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
  ],

  // DexScreener
  DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex',

  // Pump.fun (blocked by Cloudflare — disabled)
  PUMP_FUN_API: 'https://frontend-api.pump.fun',

  // Dashboard
  DASHBOARD_PORT: 3210,
};
