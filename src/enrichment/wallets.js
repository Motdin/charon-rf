import axios from 'axios';
import { BLOCKSCOUT_API, WETH_ADDRESS } from '../config.js';
import { db } from '../db/connection.js';
import { normalizeAddress, toNumber, now, sleep, isAddress } from '../utils.js';

/**
 * Smart-wallet enrichment:
 *   1. Saved wallets (user-tracked) — who holds this token
 *   2. Sniper detection — early buyers within first N blocks / first minutes
 *   3. Bundler / insider heuristic — clustered buys from related wallets
 *
 * Data source: Blockscout holders + transactions endpoints.
 */

// ── saved wallets (persisted in SQLite) ─────────────────────────

export function addSavedWallet(label, address) {
  if (!isAddress(address)) throw new Error('Invalid EVM address');
  const addr = normalizeAddress(address);
  db.prepare(
    `INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label`
  ).run(label || addr.slice(0, 8), addr, now());
  return { label: label || addr.slice(0, 8), address: addr };
}

export function removeSavedWallet(labelOrAddress) {
  const key = String(labelOrAddress || '');
  const res = db.prepare('DELETE FROM saved_wallets WHERE label = ? OR address = ?').run(key, normalizeAddress(key));
  return res.changes > 0;
}

export function listSavedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY created_at_ms ASC').all();
}

// ── Blockscout helpers ──────────────────────────────────────────

async function blockGet(path) {
  try {
    const res = await axios.get(`${BLOCKSCOUT_API}${path}`, { timeout: 12_000 });
    return res.data;
  } catch {
    return null;
  }
}

export async function fetchHolders(mint, limit = 50) {
  const data = await blockGet(`/v2/tokens/${mint}/holders?limit=${limit}`);
  const items = data?.items || [];
  return items.map((h) => ({
    address: normalizeAddress(h.address?.hash || h.address),
    balance: toNumber(h.value),
    share: toNumber(h.value_percent ?? h.percentage),
  }));
}

export async function fetchTokenTransfers(mint, limit = 100) {
  const data = await blockGet(`/v2/tokens/${mint}/transfers?limit=${limit}`);
  return (data?.items || []).map((t) => ({
    from: normalizeAddress(t.from?.hash || t.from),
    to: normalizeAddress(t.to?.hash || t.to),
    txHash: t.transaction_hash || t.tx_hash,
    timestamp: t.timestamp || t.block_timestamp,
    total: toNumber(t.total?.value),
  }));
}

// ── saved-wallet exposure ───────────────────────────────────────

/**
 * How many user-saved wallets currently hold this token.
 */
export async function fetchSavedWalletExposure(mint, holders = null) {
  const saved = listSavedWallets();
  if (!saved.length) return { holderCount: 0, addresses: [], ratio: 0, labels: [] };

  const holderSet = new Set(
    (holders || (await fetchHolders(mint, 100))).map((h) => h.address)
  );

  const hits = saved.filter((w) => holderSet.has(w.address));
  return {
    holderCount: hits.length,
    addresses: hits.map((w) => w.address),
    labels: hits.map((w) => w.label),
    ratio: hits.length / saved.length,
    tracked: saved.length,
  };
}

// ── sniper / insider detection ──────────────────────────────────

/**
 * Snipers = wallets that bought very early (first N transfers, excluding pair).
 * Insiders = snipers that still hold a large share, or clustered co-buyers.
 */
export async function detectSnipersAndInsiders(mint, { pairAddress = null, topN = 15 } = {}) {
  const transfers = await fetchTokenTransfers(mint, 80);
  const holders = await fetchHolders(mint, 50);
  const holderMap = new Map(holders.map((h) => [h.address, h]));

  const pair = pairAddress ? normalizeAddress(pairAddress) : null;
  // First buy-side transfers: to == buyer, from == pair / empty
  const buys = transfers.filter((t) => {
    if (pair && t.from === pair) return true;
    if (!pair && t.from && !holderMap.has(t.from)) return true;
    return false;
  });

  const earlyBuyers = new Map();
  for (const t of buys.slice(-topN).slice(0, topN)) {
    if (!t.to) continue;
    if (earlyBuyers.has(t.to)) earlyBuyers.set(t.to, earlyBuyers.get(t.to) + 1);
    else earlyBuyers.set(t.to, 1);
  }

  const snipers = [...earlyBuyers.entries()].map(([addr, count]) => {
    const h = holderMap.get(addr);
    return {
      address: addr,
      earlyBuys: count,
      stillHolding: Boolean(h),
      currentShare: h?.share ?? 0,
    };
  });

  // Insider heuristic: early buyer still holding > 2% OR multiple early buys
  const insiders = snipers.filter((s) => (s.stillHolding && s.currentShare > 2) || s.earlyBuys >= 3);

  // Bundler heuristic: many distinct early buyers is healthy; few early buyers
  // taking huge share is not. Compute a simple score.
  const sniperShare = snipers.reduce((acc, s) => acc + (s.currentShare || 0), 0);

  return {
    sniperCount: snipers.length,
    insiderCount: insiders.length,
    snipers: snipers.slice(0, 10),
    insiders: insiders.slice(0, 8),
    sniperSharePercent: Math.round(sniperShare * 10) / 10,
    sampleSize: transfers.length,
  };
}

/**
 * Convenience: full smart-money snapshot for a candidate.
 */
export async function fetchSmartMoneyReport(mint, { pairAddress = null } = {}) {
  const [holders, exposure, snipers] = await Promise.all([
    fetchHolders(mint, 50),
    fetchSavedWalletExposure(mint),
    detectSnipersAndInsiders(mint, { pairAddress }),
  ]);

  return {
    holders,
    savedWalletExposure: exposure,
    snipers,
    fetchedAt: now(),
  };
}

// ── strategy helper ─────────────────────────────────────────────

/**
 * Map smart-money report to filter fields + failure strings.
 */
export function evaluateSmartMoney(report, strat) {
  const failures = [];
  const exposure = report?.savedWalletExposure || {};
  const snipers = report?.snipers || {};

  const minSaved = Number(strat.min_saved_wallet_holders || 0);
  if (minSaved > 0 && Number(exposure.holderCount || 0) < minSaved) {
    failures.push(`saved wallet holders: ${exposure.holderCount || 0} < ${minSaved}`);
  }

  const maxInsider = Number(strat.max_insider_count ?? 999);
  if (Number(snipers.insiderCount || 0) > maxInsider) {
    failures.push(`insiders: ${snipers.insiderCount} > ${maxInsider}`);
  }

  const maxSniperShare = Number(strat.max_sniper_share_percent ?? 100);
  if (Number(snipers.sniperSharePercent || 0) > maxSniperShare) {
    failures.push(`sniper share: ${snipers.sniperSharePercent}% > ${maxSniperShare}%`);
  }

  return { passed: failures.length === 0, failures };
}
