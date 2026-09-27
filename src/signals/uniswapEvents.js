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

async function processNewBlocks() {
  const latest = await client.getBlockNumber();
  if (lastBlock == null) {
    lastBlock = latest - 50n; // start slightly behind
    return;
  }
  if (latest <= lastBlock) return;

  // Cap the range to avoid huge scans
  const fromBlock = lastBlock + 1n;
  const toBlock = latest > fromBlock + 200n ? fromBlock + 200n : latest;
  lastBlock = toBlock;

  // Scan Uniswap V3 Swap events
  try {
    const logs = await client.getLogs({
      event: SWAP_V3,
      fromBlock,
      toBlock,
    });
    for (const log of logs.slice(0, 200)) {
      // We don't have token address in Swap; track by pool (log.address)
      // Enrichment resolves pool -> tokens later. For overlap we count pool activity.
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
    // some RPC endpoints limit getLogs; ignore and continue
    if (consecutiveErrors < 3) console.log(`[chain] swap logs: ${err.message}`);
  }

  // Scan for PairCreated-like factory events when factory address is set
  try {
    if (UNISWAP_V3_FACTORY && UNISWAP_V3_FACTORY !== '0x0000000000000000000000000000000000000000') {
      const created = await client.getLogs({
        address: UNISWAP_V3_FACTORY,
        event: parseAbiItem(
          'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
        ),
        fromBlock,
        toBlock,
      });
      for (const log of created) {
        const token0 = normalizeAddress(log.args?.token0);
        const token1 = normalizeAddress(log.args?.token1);
        const pool = normalizeAddress(log.args?.pool);
        // Prefer the non-WETH token as the meme candidate
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

        // Trigger overlap with DexScreener if we already know the token
        const existing = trending.get(mint);
        const sourceCount = (existing ? 1 : 0) + 1; // onchain + optional dexscreener
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
    consecutiveErrors++;
    if (consecutiveErrors < 5) console.log(`[chain] poolCreated: ${err.message}`);
    if (consecutiveErrors > 10) consecutiveErrors = 0;
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
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.log(`[chain] poll failed: ${err.message}`);
    }
    setTimeout(loop, ONCHAIN_POLL_MS);
  };
  loop();
}

export function getPublicClient() {
  return client;
}

export function onchainActivity(mint) {
  return onchainSwaps.get(mint) || onchainSwaps.get(normalizeAddress(mint)) || null;
}
