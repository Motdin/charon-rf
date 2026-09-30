import axios from 'axios';
import { BLOCKSCOUT_API, CHAIN_ID } from '../config.js';
import { normalizeAddress, toNumber, sleep } from '../utils.js';

/**
 * Blockscout enrichment for Robinhood Chain.
 * Provides holder count, top-holder concentration, basic token meta.
 */

const cache = new Map();
const CACHE_TTL_MS = 3 * 60_000;

async function blockGet(path) {
  const res = await axios.get(`${BLOCKSCOUT_API}${path}`, {
    timeout: 12_000,
    headers: { Accept: 'application/json' },
  });
  return res.data;
}

export async function fetchTokenInfo(mint) {
  const key = `info:${normalizeAddress(mint)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const data = await blockGet(`/v2/tokens/${mint}`);
    const value = {
      address: normalizeAddress(data.address || mint),
      name: data.name || '',
      symbol: data.symbol || '',
      decimals: Number(data.decimals || 18),
      totalSupply: data.total_supply || null,
      holders: toNumber(data.holders),
      exchangeRate: toNumber(data.exchange_rate),
      iconUrl: data.icon_url || null,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export async function fetchHolders(mint, limit = 30) {
  const key = `holders:${normalizeAddress(mint)}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const data = await blockGet(`/v2/tokens/${mint}/holders?limit=${limit}`);
    const items = data.items || [];
    const holders = items.map((h) => ({
      address: normalizeAddress(h.address?.hash || h.address),
      balance: toNumber(h.value),
      share: toNumber(h.value_percent ?? h.percentage),
    }));

    // Approximate top-10 concentration (percent fields may be string)
    let top10 = 0;
    for (let i = 0; i < Math.min(10, holders.length); i++) {
      top10 += holders[i].share || 0;
    }

    const value = {
      holders,
      holderCount: items.length,
      top10Percent: top10,
      maxHolderPercent: holders[0]?.share || 0,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return { holders: [], holderCount: 0, top10Percent: 0, maxHolderPercent: 0 };
  }
}

/**
 * Saved-wallet exposure: check if any tracked wallet holds this token.
 * (Kept simple — balance check via Blockscout address endpoint.)
 */
export async function fetchSavedWalletExposure(mint, savedAddresses = []) {
  if (!savedAddresses.length) {
    return { holderCount: 0, addresses: [] };
  }
  const found = [];
  for (const addr of savedAddresses.slice(0, 10)) {
    try {
      const data = await blockGet(`/v2/tokens/${mint}/instances/${addr}`); // may 404
      if (data) found.push(addr);
    } catch {
      // ignore
    }
    await sleep(150);
  }
  return { holderCount: found.length, addresses: found };
}

/**
 * Build a rug-risk score 0..1 from available data (higher = riskier).
 */
export function estimateRugScore({ liquidityUsd, holderCount, top10Percent, ageMs, volume24h }) {
  let score = 0;
  if (liquidityUsd < 5000) score += 0.3;
  else if (liquidityUsd < 15000) score += 0.15;
  if (holderCount < 20) score += 0.25;
  else if (holderCount < 50) score += 0.1;
  if (top10Percent > 70) score += 0.25;
  else if (top10Percent > 50) score += 0.12;
  // Holder banyak tapi konsentrasi tak terlihat sama sekali → data disembunyikan
  // di sumber / supply disebar sybil (signature insiden #33: 380 holder, Top10 0%)
  if (holderCount >= 100 && top10Percent === 0) score += 0.15;
  if (ageMs != null && ageMs < 3600_000) score += 0.15;
  if (volume24h > 0 && liquidityUsd > 0 && volume24h / liquidityUsd > 20) score += 0.15;
  return Math.min(1, score);
}

export function chainLabel() {
  return `robinhood:${CHAIN_ID}`;
}
