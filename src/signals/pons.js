import axios from 'axios';
import { PONS_ENABLED, PONS_POLL_MS, PONS_API_BASE, PONS_LOOKBACK_MS } from '../config.js';
import { now, pruneSeen, normalizeAddress, toNumber, sleep } from '../utils.js';
import { storeSignalEvent } from '../db/candidates.js';
import { ingestPairSignal, trending } from './dexscreener.js';

/**
 * Pons launchpad signal source for Robinhood Chain.
 *
 * Pons is the local launchpad (docs.ponsfamily.com):
 *   - v1: fixed 1B supply, WETH pool, LP locked at creation, graduation threshold
 *   - v2: bonding curve → graduates into locked Uniswap V4 pool
 *
 * Public API (no key):
 *   GET https://www.ponsfamily.com/api/pons-launches
 *   GET https://www.ponsfamily.com/api/pons-token/{token}
 *   GET https://www.ponsfamily.com/api/pons-market/{token}
 *
 * This replaces the "graduated / new pool" signal Charon got from Pump.fun:
 * a fresh launch with + graduation progress is a strong early-entry candidate.
 */

const seen = new Map();
export const ponsLaunches = new Map(); // token -> launch record
export const ponsGraduated = new Map(); // token -> graduated record

let candidateHandler = null;

export function setPonsCandidateHandler(fn) {
  candidateHandler = fn;
}

async function ponsGet(path, params = {}) {
  const url = new URL(`${PONS_API_BASE.replace(/\/$/, '')}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await axios.get(url.toString(), {
    timeout: 15_000,
    headers: { Accept: 'application/json', 'User-Agent': 'charon-rh/1.0' },
  });
  return res.data;
}

function mapLaunch(row) {
  const token = normalizeAddress(row.token);
  return {
    mint: token,
    address: token,
    name: row.name || '',
    symbol: row.symbol || '',
    description: (row.description || '').slice(0, 200),
    logo: row.logo || '',
    deployer: normalizeAddress(row.deployer),
    pool: normalizeAddress(row.pool),
    pairToken: normalizeAddress(row.pairToken),
    factory: normalizeAddress(row.factory),
    txHash: row.transactionHash || '',
    blockNumber: toNumber(row.blockNumber),
    launchedAt: row.launchedAt || null,
    launchedAtMs: row.launchedAt ? Date.parse(row.launchedAt) : null,
    initialBuyEth: toNumber(row.initialBuyWei) / 1e18,
    priceUsd: toNumber(row.priceUsd),
    marketCapUsd: toNumber(row.marketCapUsd),
    liquidityUsd: toNumber(row.liquidityUsd),
    graduated: Boolean(row.graduated),
    graduationProgressPct: toNumber(row.graduationProgressPct),
    pairedPrincipalEth: row.pairedPrincipalEth != null ? toNumber(row.pairedPrincipalEth) : null,
    graduationThresholdEth: row.graduationThresholdEth != null ? toNumber(row.graduationThresholdEth) : null,
    graduatedAt: row.graduatedAt || null,
    latestBuyAt: row.latestBuyAt || null,
    source: 'pons',
    seenAt: now(),
  };
}

/**
 * Ingest one Pons launch into the candidate pipeline.
 */
async function ingestLaunch(launch, { reason = 'new_launch' } = {}) {
  const mint = launch.mint;
  if (!mint) return;

  ponsLaunches.set(mint, launch);
  if (launch.graduated) ponsGraduated.set(mint, launch);

  // Bridge into DexScreener pair shape so overlap logic still works
  const pairSignal = {
    mint,
    address: mint,
    name: launch.name,
    symbol: launch.symbol,
    priceUsd: launch.priceUsd,
    market_cap: launch.marketCapUsd,
    liquidity: launch.liquidityUsd,
    volume: 0,
    volume5m: 0,
    buys: 0,
    sells: 0,
    swaps: 0,
    pairCreatedAt: launch.launchedAtMs,
    ageMs: launch.launchedAtMs ? now() - launch.launchedAtMs : null,
    pairAddress: launch.pool,
    dexId: 'pons',
    source: 'pons',
    seenAt: now(),
  };
  ingestPairSignal(pairSignal);

  const sources = ['launchpad'];
  if (launch.graduated) sources.push('graduated');
  if (launch.graduationProgressPct >= 80) sources.push('near_graduation');
  if (launch.initialBuyEth > 0.5) sources.push('dev_buy');
  if (reason === 'active_buys') sources.push('active_buys');

  const sourceCount = sources.length;
  const route = launch.graduated ? 'pons_graduated' : 'pons_launch';

  storeSignalEvent(mint, launch.graduated ? 'graduated' : 'new_pool', 'pons', launch);

  if (!candidateHandler) return;

  // Strategy-level source gate is enforced later in filterCandidate;
  // here we forward with the full source bag.
  await candidateHandler({
    mint,
    route,
    signalMeta: {
      hasVolumeSpike: sourceCount >= 2,
      hasNewPool: true,
      hasTrending: Boolean(trending.get(mint)),
      hasOnchain: false,
      hasLaunchpad: true,
      hasGraduated: launch.graduated,
      sourceCount: Math.max(sourceCount, 1),
      sources,
      route: sourceCount >= 2 ? 'dual_source' : 'single_source',
    },
    trendingToken: trending.get(mint) || pairSignal,
    newPool: launch,
    ponsLaunch: launch,
  });
}

/**
 * Poll the Pons launch feed once.
 */
export async function pollPonsOnce() {
  if (!PONS_ENABLED) return;
  try {
    const data = await ponsGet('/pons-launches', { limit: 100 });
    const rows = Array.isArray(data) ? data : data?.launches || [];
    const cutoff = now() - PONS_LOOKBACK_MS;

    let fresh = 0;
    let graduatedHits = 0;
    for (const raw of rows) {
      const launch = mapLaunch(raw);
      if (!launch.mint) continue;

      const age = launch.launchedAtMs ? now() - launch.launchedAtMs : 0;
      const isRecent = launch.launchedAtMs == null || launch.launchedAtMs >= cutoff;

      const key = `pons:${launch.mint}`;
      const isNew = !seen.has(key);
      const wasNotGrad = !ponsGraduated.has(launch.mint);
      const nowGrad = launch.graduated;

      // Fresh launch within lookback OR newly graduated
      if (isRecent && isNew) {
        seen.set(key, now());
        fresh++;
        await ingestLaunch(launch, { reason: 'new_launch' });
      } else if (nowGrad && wasNotGrad && isNew) {
        seen.set(key, now());
        graduatedHits++;
        await ingestLaunch(launch, { reason: 'graduated' });
      }
    }

    pruneSeen(seen, 6 * 60 * 60_000);
    console.log(`[pons] ${rows.length} launches · ${fresh} fresh · ${graduatedHits} graduated · tracking ${ponsLaunches.size}`);
  } catch (err) {
    console.log(`[pons] ${err.message}`);
  }
}

export function startPonsPolling() {
  if (!PONS_ENABLED) {
    console.log('[pons] disabled');
    return;
  }
  console.log(`[pons] watching launches via ${PONS_API_BASE}`);
  const loop = async () => {
    try {
      await pollPonsOnce();
    } catch (err) {
      console.log(`[pons] poll failed: ${err.message}`);
    }
    setTimeout(loop, PONS_POLL_MS);
  };
  loop();
}

/**
 * Fetch full token details (optional enrichment).
 */
export async function fetchPonsToken(mint) {
  try {
    return await ponsGet(`/pons-token/${normalizeAddress(mint)}`);
  } catch {
    return null;
  }
}

export async function fetchPonsMarket(mint) {
  try {
    return await ponsGet(`/pons-market/${normalizeAddress(mint)}`);
  } catch {
    return null;
  }
}

export function ponsLaunchFor(mint) {
  return ponsLaunches.get(normalizeAddress(mint)) || null;
}
