import { createPublicClient, http, parseAbiItem } from 'viem';
import {
  CHAIN,
  RPC_URL,
  ONCHAIN_POLL_MS,
  ONCHAIN_EVENTS_ENABLED,
  UNISWAP_V3_FACTORY,
} from '../config.js';
import { now, pruneSeen, normalizeAddress, toNumber } from '../utils.js';
import { storeSignalEvent } from '../db/candidates.js';
import { ingestPairSignal, trending } from './dexscreener.js';

/**
 * On-chain Uniswap event watcher for Robinhood Chain.
 * Acts as the second overlap source:
 *   - PairCreated (new pools / "graduated" equivalent)
 *   - Swap volume bursts (fee activity / economic activity)
 *
 * These combine with DexScreener signals for Charon-style overlap gating.
 */

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

// Uniswap V2-style PairCreated (V3 factory uses different event but we also watch generic Swap logs)
const PAIR_CREATED = parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)');
const SWAP_V3 = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

export const onchainSwaps = new Map(); // mint -> { count, volumeEth, lastAt }
export const onchainNewPools = new Map();

let candidateHandler = null;
const seenOnchain = new Map();
let lastBlock = null;
let consecutiveErrors = 0;
// Backoff saat RPC rate-limit (429 / Too Many Requests)
let backoffUntil = 0;
const MAX_BLOCK_RANGE = 50n; // jangan scan terlalu lebar — free RPC sensitif

export function setOnchainCandidateHandler(fn) {
  candidateHandler = fn;
}

function recordSwap(mint, volumeEthAbs) {
  const prev = onchainSwaps.get(mint) || { count: 0, volumeEth: 0, lastAt: 0 };
  onchainSwaps.set(mint, {
    count: prev.count + 1,
    volumeEth: prev.volumeEth + volumeEthAbs,
    lastAt: now(),
  });
}

function isRateLimited(err) {
  const msg = String(err?.message || err?.shortMessage || err?.details || '');
  return /429|Too Many Requests|rate.?limit|exceeded|timeout|Request failed/i.test(msg);
}

function noteRateLimit(err, tag = 'logs') {
  consecutiveErrors++;
  const backoffMs = Math.min(120_000, 5_000 * 2 ** Math.min(consecutiveErrors, 5));
  backoffUntil = now() + backoffMs;
  console.log(`[chain] ${tag}: ${isRateLimited(err) ? 'RATE LIMITED' : 'error'} — backoff ${Math.round(backoffMs / 1000)}s`);
}

async function processNewBlocks() {
  if (now() < backoffUntil) return;

  const latest = await client.getBlockNumber();
  if (lastBlock == null) {
    // mulai sedikit di belakang tipis, jangan langsung scan 50 block
    lastBlock = latest > 20n ? latest - 20n : latest;
    return;
  }
  if (latest <= lastBlock) return;

  const fromBlock = lastBlock + 1n;
  const toBlock = latest > fromBlock + MAX_BLOCK_RANGE ? fromBlock + MAX_BLOCK_RANGE : latest;
  lastBlock = toBlock;

  // Scan Uniswap V3 Swap events (dengan batas kecil)
  try {
    const logs = await client.getLogs({
      event: SWAP_V3,
      fromBlock,
      toBlock,
    });
    consecutiveErrors = 0;
    for (const log of logs.slice(0, 80)) {
      const pool = normalizeAddress(log.address);
      recordSwap(pool, 0);
      if (log.args && onchainSwaps.get(pool)?.count === 3) {
        storeSignalEvent(pool, 'onchain_swap', 'uniswap_v3', {
          pool,
          block: Number(log.blockNumber),
          tx: log.transactionHash,
        });
      }
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'swap');
    else if (consecutiveErrors < 3) console.log(`[chain] swap logs: ${err.message}`);
  }

  // PoolCreated — hanya jika factory diset, dan skip saat sedang backoff
  try {
    if (
      UNISWAP_V3_FACTORY &&
      UNISWAP_V3_FACTORY !== '0x0000000000000000000000000000000000000000' &&
      now() >= backoffUntil
    ) {
      const created = await client.getLogs({
        address: UNISWAP_V3_FACTORY,
        event: parseAbiItem(
          'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
        ),
        fromBlock,
        toBlock,
      });
      consecutiveErrors = 0;
      for (const log of created) {
        const token0 = normalizeAddress(log.args?.token0);
        const token1 = normalizeAddress(log.args?.token1);
        const pool = normalizeAddress(log.args?.pool);
        const mint = token0 && !token0.includes('0bbd7308') ? token0 : token1;
        if (!mint) continue;
        const key = `pool:${pool}`;
        if (seenOnchain.has(key)) continue;
        seenOnchain.set(key, now());

        onchainNewPools.set(mint, {
          mint,
          pool,
          token0,
          token1,
          fee: Number(log.args?.fee || 0),
          block: Number(log.blockNumber),
          seenAt: now(),
        });
        storeSignalEvent(mint, 'new_pool', 'uniswap_v3_factory', log.args);

        const existing = trending.get(mint);
        const sourceCount = (existing ? 1 : 0) + 1;
        if (candidateHandler) {
          await candidateHandler({
            mint,
            route: existing ? 'new_pool_dex' : 'new_pool',
            signalMeta: {
              hasVolumeSpike: false,
              hasNewPool: true,
              hasTrending: Boolean(existing),
              hasOnchain: true,
              sourceCount,
              sources: existing ? ['new_pool', 'trending'] : ['new_pool'],
              route: existing ? 'dual_source' : 'single_source',
            },
            trendingToken: existing || null,
            newPool: onchainNewPools.get(mint),
          });
        }
      }
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'poolCreated');
    else if (consecutiveErrors < 5) console.log(`[chain] poolCreated: ${err.message}`);
  }

  // Emit overlap candidates when on-chain swap activity coincides with DexScreener volume
  for (const [pool, stats] of onchainSwaps) {
    if (stats.count < 5) continue;
    const dex = trending.get(pool);
    if (!dex) continue;
    const key = `overlap:${pool}:${Math.floor(now() / 300_000)}`;
    if (seenOnchain.has(key)) continue;
    seenOnchain.set(key, now());
    pruneSeen(seenOnchain, 20 * 60_000);

    if (candidateHandler) {
      await candidateHandler({
        mint: pool,
        route: 'onchain_dex_overlap',
        signalMeta: {
          hasVolumeSpike: true,
          hasNewPool: onchainNewPools.has(pool),
          hasTrending: true,
          hasOnchain: true,
          sourceCount: 2,
          sources: ['volume_spike', 'onchain'],
          route: 'dual_source',
        },
        trendingToken: dex,
      });
    }
  }
}

export async function pollOnchainOnce() {
  if (!ONCHAIN_EVENTS_ENABLED) return;
  await processNewBlocks();
}

export function startOnchainPolling() {
  if (!ONCHAIN_EVENTS_ENABLED) {
    console.log('[chain] disabled');
    return;
  }
  console.log(`[chain] watching Uniswap on ${CHAIN.name} (${CHAIN.id}) via ${RPC_URL}`);
  const loop = async () => {
    try {
      await pollOnchainOnce();
    } catch (err) {
      if (isRateLimited(err)) noteRateLimit(err, 'poll');
      else console.log(`[chain] poll failed: ${err.message}`);
    }
    // perpanjang interval saat sedang backoff
    const wait = now() < backoffUntil ? Math.max(5000, backoffUntil - now()) : ONCHAIN_POLL_MS;
    setTimeout(loop, wait);
  };
  loop();
}

export function getPublicClient() {
  return client;
}

export function onchainActivity(mint) {
  return onchainSwaps.get(mint) || onchainSwaps.get(normalizeAddress(mint)) || null;
}
