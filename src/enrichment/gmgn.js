import { randomUUID } from 'node:crypto';
import { GMGN_API_KEY, GMGN_ENABLED, GMGN_CHAIN, GMGN_BASE_URL, GMGN_CACHE_TTL_MS } from '../config.js';
import { now, sleep, toNumber, normalizeAddress, firstPositiveNumber } from '../utils.js';
import { numSetting } from '../db/settings.js';

/**
 * GMGN OpenAPI adapter for Robinhood Chain (free-tier friendly).
 *
 * Free tier: 5 weight. Every call is budgeted so we never hard-fail the
 * pipeline — when weight is exhausted or GMGN errors, callers fall back to
 * DexScreener + Blockscout (see enrichment/index.js).
 *
 * Endpoint: GET {GMGN_BASE_URL}/v1/token/info?chain=robinhood&address=0x…
 * Auth:     X-APIKEY: <GMGN_API_KEY>
 */

// Free tier weight budget (configurable via env GMGN_WEIGHT_BUDGET)
let weightBudget = Number(process.env.GMGN_WEIGHT_BUDGET || 5);
let weightSpent = 0;
let weightWindowStart = now();
const WEIGHT_WINDOW_MS = Number(process.env.GMGN_WEIGHT_WINDOW_MS || 60_000);

// Cost table — token info is the workhorse call. Keep it at 1.
const WEIGHT_COST = {
  tokenInfo: 1,
  trending: 1,
  holders: 1,
};

const cache = new Map();
let lastRequestAt = 0;
let queue = Promise.resolve();
const backoff = { until: 0, reason: '' };

// ── weight budget ──────────────────────────────────────────────

function resetWeightWindowIfExpired() {
  if (now() - weightWindowStart >= WEIGHT_WINDOW_MS) {
    weightSpent = 0;
    weightWindowStart = now();
  }
}

function weightRemaining() {
  resetWeightWindowIfExpired();
  return Math.max(0, weightBudget - weightSpent);
}

function tryConsumeWeight(kind = 'tokenInfo') {
  resetWeightWindowIfExpired();
  const cost = WEIGHT_COST[kind] ?? 1;
  if (weightSpent + cost > weightBudget) return false;
  weightSpent += cost;
  return true;
}

export function gmgnWeightStatus() {
  resetWeightWindowIfExpired();
  return {
    budget: weightBudget,
    spent: weightSpent,
    remaining: weightRemaining(),
    windowMs: WEIGHT_WINDOW_MS,
    windowStartedAt: weightWindowStart,
    backoffUntil: backoff.until,
    backoffReason: backoff.reason,
    enabled: GMGN_ENABLED && Boolean(GMGN_API_KEY),
  };
}

export function gmgnAvailable() {
  return GMGN_ENABLED && Boolean(GMGN_API_KEY) && weightRemaining() > 0 && now() >= backoff.until;
}

// ── HTTP ───────────────────────────────────────────────────────

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
}

async function pace() {
  const delayMs = Math.max(0, numSetting('gmgn_request_delay_ms', 2500));
  if (!delayMs) return;
  const elapsed = now() - lastRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastRequestAt = now();
}

async function gmgnFetch(pathname, { params = {}, weightKind = 'tokenInfo' } = {}) {
  if (!GMGN_ENABLED || !GMGN_API_KEY) {
    const err = new Error('GMGN disabled or GMGN_API_KEY missing');
    err.code = 'GMGN_DISABLED';
    throw err;
  }
  if (now() < backoff.until) {
    const err = new Error(`GMGN backing off: ${backoff.reason}`);
    err.code = 'GMGN_BACKOFF';
    throw err;
  }
  if (!tryConsumeWeight(weightKind)) {
    const err = new Error(`GMGN free-tier weight exhausted (${weightSpent}/${weightBudget} in window)`);
    err.code = 'GMGN_WEIGHT_EXHAUSTED';
    throw err;
  }

  const run = queue.then(async () => {
    const url = new URL(`${GMGN_BASE_URL.replace(/\/$/, '')}${pathname}`);
    appendParams(url, {
      ...params,
      timestamp: Math.floor(now() / 1000),
      client_id: randomUUID(),
    });

    await pace();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-APIKEY': GMGN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const text = await res.text().catch(() => '');
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (res.ok) return payload;

    const message = `${res.status} ${payload?.code || ''} ${payload?.message || payload?.error || text}`.trim();
    const rateLimited = res.status === 429 || /rate limit|weight|quota|temporarily/i.test(message);

    if (rateLimited || res.status === 403) {
      const resetAtMs = Number(payload?.reset_at || 0) * 1000;
      const fallbackMs = res.status === 403 ? 5 * 60_000 : 60_000;
      backoff.until = resetAtMs > now() ? resetAtMs : now() + fallbackMs;
      backoff.reason = message.slice(0, 200);
      console.log(`[gmgn] backoff until ${new Date(backoff.until).toISOString()} (${backoff.reason})`);
    }

    const err = new Error(message.slice(0, 240));
    err.response = { status: res.status, data: payload };
    throw err;
  });

  queue = run.catch(() => {});
  return run;
}

// ── public API ─────────────────────────────────────────────────

function unwrapTokenPayload(payload) {
  return payload?.data?.data || payload?.data || payload || null;
}

function mapTokenInfo(raw, mint) {
  if (!raw) return null;
  const price = firstPositiveNumber(raw.price, raw.usd_price);
  const supply = toNumber(raw.circulating_supply ?? raw.total_supply);
  const mcap = firstPositiveNumber(raw.market_cap, raw.mcap, price && supply ? price * supply : null);

  return {
    source: 'gmgn',
    chain: GMGN_CHAIN,
    address: normalizeAddress(raw.address || mint),
    name: raw.name || '',
    symbol: raw.symbol || raw.ticker || '',
    priceUsd: price,
    marketCapUsd: mcap,
    liquidityUsd: firstPositiveNumber(raw.liquidity, raw.liquidity_usd),
    holderCount: toNumber(raw.holder_count ?? raw.holders),
    totalFeeSol: toNumber(raw.total_fee),
    tradeFeeSol: toNumber(raw.trade_fee),
    volume24hUsd: toNumber(raw.volume_24h ?? raw.volume24h),
    smartMoney: raw.smart_money ?? null,
    socials: {
      twitter: raw.link?.twitter_username || raw.twitter || '',
      website: raw.link?.website || raw.website || '',
      telegram: raw.link?.telegram || raw.telegram || '',
    },
    raw,
    fetchedAt: now(),
  };
}

/**
 * Fetch token info from GMGN. Returns null on any failure so callers
 * can fall back to DexScreener + Blockscout without special-casing.
 */
export async function fetchGmgnTokenInfo(mint, { useCache = true } = {}) {
  const key = normalizeAddress(mint);
  if (!GMGN_ENABLED || !GMGN_API_KEY) return null;

  const hit = cache.get(key);
  if (useCache && hit && now() - hit.at < GMGN_CACHE_TTL_MS) return hit.value;

  if (!gmgnAvailable()) {
    // Weight gone or backing off — signal fallback immediately
    return null;
  }

  try {
    const payload = await gmgnFetch('/v1/token/info', {
      params: { chain: GMGN_CHAIN, address: key },
      weightKind: 'tokenInfo',
    });
    const mapped = mapTokenInfo(unwrapTokenPayload(payload), key);
    cache.set(key, { at: now(), value: mapped });
    return mapped;
  } catch (err) {
    if (err.code === 'GMGN_WEIGHT_EXHAUSTED' || err.code === 'GMGN_BACKOFF' || err.code === 'GMGN_DISABLED') {
      // silent fallback — expected path
      return null;
    }
    console.log(`[gmgn] token ${key.slice(0, 10)}… ${err.message}`);
    cache.set(key, { at: now(), value: null });
    return null;
  }
}

/**
 * GMGN trending / rank (costs 1 weight). Optional — only call when budget allows.
 */
export async function fetchGmgnTrending({ limit = 20 } = {}) {
  if (!gmgnAvailable()) return [];
  try {
    const payload = await gmgnFetch('/v1/rank/swaps', {
      params: { chain: GMGN_CHAIN, interval: '5m', orderby: 'swaps', direction: 'desc', limit },
      weightKind: 'trending',
    });
    const rows = payload?.data?.data?.rank || payload?.data?.rank || payload?.data || [];
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err.code === 'GMGN_WEIGHT_EXHAUSTED' || err.code === 'GMGN_BACKOFF') return [];
    console.log(`[gmgn] trending ${err.message}`);
    return [];
  }
}

export function resetGmgnWeight() {
  weightSpent = 0;
  weightWindowStart = now();
  backoff.until = 0;
  backoff.reason = '';
}

export function clearGmgnCache() {
  cache.clear();
}
