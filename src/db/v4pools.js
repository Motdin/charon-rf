import { db } from './connection.js';
import { now, normalizeAddress } from '../utils.js';

/**
 * Cache poolKey V4 per token — resolusi PoolKey butuh scan log Initialize
 * (rpc publik, rentang jutaan blok), jadi hasilnya disimpan permanen.
 * Tabel dibuat lazy agar tidak menyentuh skema produksi saat QC import-only.
 */

let ensured = false;
function ensureTable() {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS v4_pools (
      pool_id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      currency0 TEXT NOT NULL,
      currency1 TEXT NOT NULL,
      fee INTEGER NOT NULL,
      tick_spacing INTEGER NOT NULL,
      hooks TEXT NOT NULL,
      source TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v4_pools_mint ON v4_pools(mint);
  `);
  ensured = true;
}

export function cacheV4Pool(mint, poolId, poolKey, source = 'logs') {
  ensureTable();
  db.prepare(
    `INSERT OR REPLACE INTO v4_pools
       (pool_id, mint, currency0, currency1, fee, tick_spacing, hooks, source, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(poolId).toLowerCase(),
    normalizeAddress(mint),
    poolKey.currency0.toLowerCase(),
    poolKey.currency1.toLowerCase(),
    Number(poolKey.fee),
    Number(poolKey.tickSpacing),
    poolKey.hooks.toLowerCase(),
    source,
    now()
  );
}

/** Buang pool dari cache (quoter bilang pool ini tak bisa di-swap di PM official). */
export function evictV4Pool(poolId) {
  ensureTable();
  return db
    .prepare('DELETE FROM v4_pools WHERE pool_id = ?')
    .run(String(poolId).toLowerCase()).changes;
}

export function cachedV4PoolsForMint(mint) {
  ensureTable();
  const rows = db
    .prepare('SELECT * FROM v4_pools WHERE mint = ? ORDER BY created_at_ms DESC')
    .all(normalizeAddress(mint));
  return rows.map((row) => ({
    poolId: row.pool_id,
    poolKey: {
      currency0: row.currency0,
      currency1: row.currency1,
      fee: Number(row.fee),
      tickSpacing: Number(row.tick_spacing),
      hooks: row.hooks,
    },
    source: row.source,
  }));
}
