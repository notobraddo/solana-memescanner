/**
 * Database setup — SQLite for paper trading records, signals, stats
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'trades.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    name TEXT,
    symbol TEXT,
    price_usd REAL,
    liquidity_usd REAL,
    market_cap_usd REAL,
    bundle_score REAL,
    bundle_count INTEGER,
    lp_burned INTEGER,
    holder_count INTEGER,
    top10_holder_pct REAL,
    global_fee_ratio REAL,
    filter_passed INTEGER DEFAULT 0,
    filter_score INTEGER DEFAULT 0,
    filter_reasons TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER,
    mint TEXT NOT NULL,
    entry_price REAL,
    exit_price REAL,
    amount_sol REAL DEFAULT 1.0,
    fee_sol REAL DEFAULT 0.03,
    entry_type TEXT DEFAULT 'market',
    status TEXT DEFAULT 'open',
    tp_price REAL,
    sl_price REAL,
    tp_hit INTEGER DEFAULT 0,
    sl_hit INTEGER DEFAULT 0,
    pnl_sol REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    entry_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    exit_time DATETIME,
    FOREIGN KEY (signal_id) REFERENCES signals(id)
  );

  CREATE TABLE IF NOT EXISTS hourly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_hour DATETIME NOT NULL,
    total_signals INTEGER DEFAULT 0,
    passed_filter INTEGER DEFAULT 0,
    trades_opened INTEGER DEFAULT 0,
    trades_closed INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_pnl_sol REAL DEFAULT 0,
    avg_pnl_pct REAL DEFAULT 0,
    best_trade_pct REAL DEFAULT 0,
    worst_trade_pct REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    report_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auto_learn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    metric_value REAL,
    sample_count INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
  CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON paper_trades(status);
  CREATE INDEX IF NOT EXISTS idx_trades_mint ON paper_trades(mint);
`);

export default db;
