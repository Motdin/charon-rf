import { db } from './connection.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value)
  );
}

export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < 5000) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) {
    const fallback = strategyById('sniper');
    if (fallback) return fallback;
    return defaultStrategy();
  }
  const config = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
}

export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id')
    .all()
    .map((row) => ({ id: row.id, name: row.name, enabled: Boolean(row.enabled), ...JSON.parse(row.config_json) }));
}

export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (strategyCache.id === id) {
    strategyCache.config = null;
    strategyCache.at = 0;
  }
}

function defaultStrategy() {
  return {
    id: 'sniper',
    name: 'Sniper',
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
    position_size_eth: 0.05,
    max_open_positions: 3,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
    partial_tp: false,
    use_llm: true,
    llm_min_confidence: 50,
  };
}
