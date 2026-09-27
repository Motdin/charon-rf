import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../config.js';

export const db = new DatabaseSync(DB_PATH);

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function initDb() {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signal_key, mint)
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_eth REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      partial_tp_done INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_eth REAL,
      execution_mode TEXT DEFAULT 'dry_run',
      strategy_id TEXT DEFAULT 'sniper',
      token_amount_raw TEXT,
      entry_signature TEXT,
      exit_signature TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_eth REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'buy',
      size_eth REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      strategy_id TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_lessons_status ON learning_lessons(status, created_at_ms);
  `);

  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');

  seedDefaults();
}

function seedDefaults() {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || '600000',
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    dry_run_buy_eth: '0.05',
  };
  for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

  const stratInsert = db.prepare(
    'INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)'
  );
  const ts = Date.now();

  // Sniper: overlap required, early entry, LLM on
  stratInsert.run(
    'sniper',
    'Sniper',
    1,
    JSON.stringify({
      entry_mode: 'immediate',
      min_source_count: 2,
      require_volume_spike: true,
      pool_age_max_ms: 6 * 3600_000,
      min_mcap_usd: 5000,
      max_mcap_usd: 500000,
      min_liquidity_usd: 5000,
      min_volume_h24_usd: 10000,
      min_txns_h24: 50,
      max_top10_holder_percent: 60,
      min_holders: 20,
      max_ath_distance_pct: 0,
      trending_min_volume_usd: 5000,
      max_rug_score: 0.5,
      require_security_pass: true,
      max_security_risk: 0.5,
      min_saved_wallet_holders: 0,
      max_insider_count: 3,
      max_sniper_share_percent: 30,
      position_size_eth: 0.05,
      max_open_positions: 3,
      tp_percent: 50,
      sl_percent: -25,
      trailing_enabled: true,
      trailing_percent: 20,
      partial_tp: false,
      partial_tp_at_percent: 0,
      partial_tp_sell_percent: 0,
      max_hold_ms: 0,
      use_llm: true,
      llm_min_confidence: 50,
    }),
    ts
  );

  // Dip buy: wait for ATH distance
  stratInsert.run(
    'dip_buy',
    'Dip Buy',
    0,
    JSON.stringify({
      entry_mode: 'wait_for_dip',
      min_source_count: 1,
      require_volume_spike: false,
      pool_age_max_ms: 7 * 86400_000,
      min_mcap_usd: 20000,
      max_mcap_usd: 2000000,
      min_liquidity_usd: 15000,
      min_volume_h24_usd: 5000,
      min_txns_h24: 20,
      max_top10_holder_percent: 70,
      min_holders: 50,
      max_ath_distance_pct: -35,
      trending_min_volume_usd: 0,
      max_rug_score: 0.5,
      require_security_pass: true,
      max_security_risk: 0.5,
      min_saved_wallet_holders: 0,
      max_insider_count: 3,
      max_sniper_share_percent: 35,
      position_size_eth: 0.03,
      max_open_positions: 3,
      tp_percent: 30,
      sl_percent: -20,
      trailing_enabled: true,
      trailing_percent: 15,
      partial_tp: false,
      partial_tp_at_percent: 0,
      partial_tp_sell_percent: 0,
      max_hold_ms: 0,
      use_llm: true,
      llm_min_confidence: 60,
    }),
    ts
  );

  // Smart money: holder quality, partial TP, LLM strict
  stratInsert.run(
    'smart_money',
    'Smart Money',
    0,
    JSON.stringify({
      entry_mode: 'immediate',
      min_source_count: 2,
      require_volume_spike: false,
      pool_age_max_ms: 7 * 86400_000,
      min_mcap_usd: 15000,
      max_mcap_usd: 5000000,
      min_liquidity_usd: 25000,
      min_volume_h24_usd: 25000,
      min_txns_h24: 150,
      max_top10_holder_percent: 45,
      min_holders: 200,
      max_ath_distance_pct: 0,
      trending_min_volume_usd: 15000,
      max_rug_score: 0.3,
      require_security_pass: true,
      max_security_risk: 0.35,
      min_saved_wallet_holders: 1,
      max_insider_count: 1,
      max_sniper_share_percent: 20,
      position_size_eth: 0.05,
      max_open_positions: 3,
      tp_percent: 100,
      sl_percent: -25,
      trailing_enabled: false,
      trailing_percent: 0,
      partial_tp: true,
      partial_tp_at_percent: 100,
      partial_tp_sell_percent: 50,
      max_hold_ms: 0,
      use_llm: true,
      llm_min_confidence: 70,
    }),
    ts
  );

  // Degen: rule-based, no LLM
  stratInsert.run(
    'degen',
    'Degen',
    0,
    JSON.stringify({
      entry_mode: 'immediate',
      min_source_count: 1,
      require_volume_spike: false,
      pool_age_max_ms: 3 * 3600_000,
      min_mcap_usd: 3000,
      max_mcap_usd: 150000,
      min_liquidity_usd: 2000,
      min_volume_h24_usd: 3000,
      min_txns_h24: 20,
      max_top10_holder_percent: 80,
      min_holders: 5,
      max_ath_distance_pct: 0,
      trending_min_volume_usd: 0,
      max_rug_score: 0.7,
      require_security_pass: false,
      max_security_risk: 0.85,
      min_saved_wallet_holders: 0,
      max_insider_count: 5,
      max_sniper_share_percent: 50,
      position_size_eth: 0.02,
      max_open_positions: 5,
      tp_percent: 30,
      sl_percent: -15,
      trailing_enabled: true,
      trailing_percent: 10,
      partial_tp: false,
      partial_tp_at_percent: 0,
      partial_tp_sell_percent: 0,
      max_hold_ms: 3600_000,
      use_llm: false,
      llm_min_confidence: 0,
    }),
    ts
  );
}
