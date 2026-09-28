import axios from 'axios';
import {
  DEXSCREENER_POLL_MS,
  DEXSCREENER_ENABLED,
} from '../config.js';
import { now, pruneSeen, sleep, toNumber, normalizeAddress } from '../utils.js';
import { numSetting, activeStrategy } from '../db/settings.js';
import { storeSignalEvent } from '../db/candidates.js';

/**
 * DexScreener signal source for Robinhood Chain meme tokens.
 * Discovers: trending pairs, volume spikes, new/active pools.
 * These feed the overlap detector alongside on-chain Uniswap events.
 */

const BASE = 'https://api.dexscreener.com';

// Rate-limit state — 429 DexScreener
let rateBackoffUntil = 0;
let consecutive429 = 0;
let last429LogAt = 0;
let cycleCount = 0;

// In-memory latest snapshot per mint
export const trending = new Map(); // mint -> latest pair data
export const volumeSpikes = new Map(); // mint -> spike metadata
export const newPools = new Map(); // mint -> pool metadata

let candidateHandler = null;
const seenDiscovery = new Map();

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export function rateLimitStatus() {
  return {
    backingOff: now() < rateBackoffUntil,
    until: rateBackoffUntil,
    consecutive: consecutive429,
  };
}

function isRateLimited(err) {
  const msg = String(err?.message || '');
  const status = err?.response?.status;
  return status === 429 || /429|rate limit/i.test(msg);
}

function noteRateLimit() {
  consecutive429 = Math.min(consecutive429 + 1, 99);
  const backoffMs = Math.min(180_000, 30_000 * Math.min(consecutive429, 6));
  rateBackoffUntil = now() + backoffMs;
  // Log maksimal 1x / 60 detik — cegah spam hit #600+
  const t = now();
  if (t - last429LogAt > 60_000) {
    last429LogAt = t;
    console.log(
      `[dex] RATE LIMITED — backoff ${Math.round(backoffMs / 1000)}s (total ${consecutive429})`
    );
  }
}

async function dexGet(path) {
  // Selama backoff, JANGAN panggil API sama sekali
  if (now() < rateBackoffUntil) {
    const err = new Error('rate limit backoff active');
    err.code = 'DEX_BACKOFF';
    throw err;
  }
  try {
    const res = await axios.get(`${BASE}${path}`, {
      timeout: 12_000,
      headers: { Accept: 'application/json' },
    });
    consecutive429 = 0;
    return res.data;
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit();
    throw err;
  }
}

function pairToSignal(pair, source) {
  const base = pair.baseToken || {};
  const mint = normalizeAddress(base.address);
  if (!mint) return null;

  const volume = toNumber(pair.volume?.h24);
  const volume5m = toNumber(pair.volume?.h5m) || toNumber(pair.volume?.h1) / 12;
  const liquidity = toNumber(pair.liquidity?.usd);
  const mcap = toNumber(pair.marketCap) || toNumber(pair.fdv);
  const txns24 = toNumber(pair.txns?.h24?.buys) + toNumber(pair.txns?.h24?.sells);
  const buys24 = toNumber(pair.txns?.h24?.buys);
  const sells24 = toNumber(pair.txns?.h24?.sells);
  const priceChange5m = toNumber(pair.priceChange?.m5);
  const priceChange1h = toNumber(pair.priceChange?.h1);
  const pairCreatedAt = toNumber(pair.pairCreatedAt);
  const ageMs = pairCreatedAt > 0 ? now() - pairCreatedAt : null;

  return {
    mint,
    address: mint,
    name: base.name || '',
    symbol: base.symbol || '',
    priceUsd: toNumber(pair.priceUsd),
    market_cap: mcap,
    liquidity,
    volume,
    volume5m,
    buys: buys24,
    sells: sells24,
    swaps: txns24,
    priceChange5m,
    priceChange1h,
    priceChange24h: toNumber(pair.priceChange?.h24),
    pairCreatedAt,
    ageMs,
    pairAddress: pair.pairAddress || '',
    dexId: pair.dexId || '',
    labels: pair.labels || [],
    url: pair.url || '',
    source,
    seenAt: now(),
  };
}

/**
 * Volume spike heuristic: 5m volume is a large share of 24h volume,
 * or 1h volume is elevated relative to liquidity.
 */
function detectVolumeSpike(signal) {
  const { volume5m, volume, liquidity, priceChange5m, swaps } = signal;
  if (!volume || volume < 1000) return false;
  const spikeRatio5m = volume > 0 ? (volume5m * 288) / volume : 0; // annualized-style share
  const volumeToLiq = liquidity > 0 ? volume / liquidity : 0;
  return (
    spikeRatio5m > 8 ||
    volumeToLiq > 3 ||
    (priceChange5m > 5 && swaps > 10) ||
    (priceChange5m < -8 && swaps > 10) // dump is also a signal for dip_buy
  );
}

async function pollTokenProfiles() {
  // Token profiles boost — good for new launches
  try {
    const data = await dexGet('/token-profiles/latest/v1');
    const list = Array.isArray(data) ? data : [];
    for (const item of list.slice(0, 40)) {
      if (item.chainId !== 'robinhood') continue;
      const mint = normalizeAddress(item.tokenAddress);
      if (!mint) continue;
      const key = `profile:${mint}`;
      if (seenDiscovery.has(key)) continue;
      seenDiscovery.set(key, now());

      newPools.set(mint, {
        mint,
        name: item.description?.slice(0, 40) || '',
        symbol: '',
        kind: 'token_profile',
        source: 'dexscreener_profiles',
        seenAt: now(),
      });
      storeSignalEvent(mint, 'new_pool', 'dexscreener_profiles', item);
      await maybeTrigger(mint, { hasNewPool: true, route: 'new_pool' });
    }
  } catch (err) {
    if (isRateLimited(err)) return; // sudah dicatat di dexGet
    console.log(`[dex] profiles: ${err.message}`);
  }
}

async function pollSearchTrending() {
  try {
    const data = await dexGet('/latest/dex/search?q=robinhood');
    const pairs = (data.pairs || []).filter((p) => p.chainId === 'robinhood');
    for (const pair of pairs.slice(0, 30)) {
      const signal = pairToSignal(pair, 'dexscreener_search');
      if (!signal) continue;
      ingestPairSignal(signal);
    }
  } catch (err) {
    if (isRateLimited(err)) return;
    console.log(`[dex] search: ${err.message}`);
  }
}

async function pollTopVolume() {
  // Kurangi keyword: 2x per cycle saja (rotasi), bukan 6 sekaligus
  const all = ['pepe', 'hood', 'moon', 'dog'];
  const start = (cycleCount * 2) % all.length;
  const batch = [all[start], all[(start + 1) % all.length]];
  for (const q of batch) {
    if (now() < rateBackoffUntil) return;
    try {
      const data = await dexGet(`/latest/dex/search?q=${encodeURIComponent(q)}`);
      const pairs = (data.pairs || []).filter((p) => p.chainId === 'robinhood');
      for (const pair of pairs.slice(0, 8)) {
        const signal = pairToSignal(pair, 'dexscreener_trending');
        if (!signal) continue;
        ingestPairSignal(signal);
      }
    } catch (err) {
      if (isRateLimited(err)) return;
      console.log(`[dex] trending(${q}): ${err.message}`);
    }
    await sleep(2000); // lebih sopan ke public API
  }
}

/**
 * Refresh a single token's pair data (used by enrichment / position monitor).
 */
export async function fetchDexPair(mint) {
  if (now() < rateBackoffUntil) return null; // hemat kuota saat backoff
  try {
    const data = await dexGet(`/latest/dex/tokens/${mint}`);
    const pairs = (data.pairs || []).filter((p) => p.chainId === 'robinhood');
    if (!pairs.length) return null;
    // Prefer highest liquidity pair
    pairs.sort((a, b) => toNumber(b.liquidity?.usd) - toNumber(a.liquidity?.usd));
    return pairToSignal(pairs[0], 'dexscreener_token');
  } catch {
    return null;
  }
}

export function ingestPairSignal(signal) {
  const mint = signal.mint;
  trending.set(mint, signal);

  const isSpike = detectVolumeSpike(signal);
  if (isSpike) {
    volumeSpikes.set(mint, { ...signal, spike: true, detectedAt: now() });
    storeSignalEvent(mint, 'volume_spike', signal.source, signal);
  }

  // Fresh pool (age < 6h) counts as "new" signal
  if (signal.ageMs != null && signal.ageMs < 6 * 3600_000) {
    if (!newPools.has(mint)) {
      newPools.set(mint, { ...signal, kind: 'fresh_pair', seenAt: now() });
      storeSignalEvent(mint, 'new_pool', signal.source, signal);
    }
  }

  const sources = [];
  if (isSpike) sources.push('volume_spike');
  if (newPools.has(mint)) sources.push('new_pool');
  if (signal.volume > 20000 && signal.swaps > 80) sources.push('trending');

  const route =
    sources.length >= 3 ? 'multi_source' : sources.length === 2 ? 'dual_source' : sources[0] || 'single_source';

  // Overlap gate is enforced later in strategy; here we just forward with source count
  maybeTrigger(mint, {
    hasVolumeSpike: isSpike,
    hasNewPool: newPools.has(mint),
    hasTrending: sources.includes('trending'),
    hasOnchain: false,
    sourceCount: sources.length,
    sources,
    route,
    trendingToken: signal,
  });
}

async function maybeTrigger(mint, signalMeta) {
  if (!candidateHandler) return;
  const strat = activeStrategy();
  // minimal 1 — token yang sampai sini pasti terdeteksi oleh setidaknya satu sumber
  const sourceCount = Math.max(Number(signalMeta.sourceCount) || 0, signalMeta.hasVolumeSpike ? 1 : 0, 1);
  if (sourceCount < (strat.min_source_count || 1)) return;
  if (strat.require_volume_spike && !signalMeta.hasVolumeSpike) return;

  const key = `trig:${mint}:${signalMeta.route}:${Math.floor(now() / 120_000)}`;
  if (seenDiscovery.has(key)) return;
  seenDiscovery.set(key, now());
  pruneSeen(seenDiscovery, 15 * 60_000);

  await candidateHandler({
    mint,
    route: signalMeta.route,
    signalMeta: { ...signalMeta, sourceCount },
    trendingToken: trending.get(mint) || null,
    volumeSpike: volumeSpikes.get(mint) || null,
    newPool: newPools.get(mint) || null,
  });
}

export async function pollDexScreenerOnce() {
  if (!DEXSCREENER_ENABLED) return;
  if (now() < rateBackoffUntil) {
    const wait = Math.ceil((rateBackoffUntil - now()) / 1000);
    console.log(`[dex] skip poll — rate limit backoff ${wait}s left`);
    return;
  }

  cycleCount++;
  // profiles hanya tiap 3 cycle (hemat kuota 429)
  if (cycleCount % 3 === 1) await pollTokenProfiles();
  if (now() >= rateBackoffUntil) await pollSearchTrending();
  if (now() >= rateBackoffUntil) await pollTopVolume();

  console.log(
    `[dex] snapshot trending=${trending.size} spikes=${volumeSpikes.size} newPools=${newPools.size}` +
      (now() < rateBackoffUntil ? ' · rate-limited' : '')
  );
}

export function startDexScreenerPolling() {
  if (!DEXSCREENER_ENABLED) {
    console.log('[dex] disabled');
    return;
  }
  const loop = async () => {
    try {
      await pollDexScreenerOnce();
    } catch (err) {
      if (isRateLimited(err)) {
        // sudah backoff
      } else {
        console.log(`[dex] poll failed: ${err.message}`);
      }
    }
    // kalau kena 429, perpanjang jeda
    const delay = now() < rateBackoffUntil ? rateBackoffUntil - now() : DEXSCREENER_POLL_MS;
    setTimeout(loop, delay);
  };
  loop();
}
