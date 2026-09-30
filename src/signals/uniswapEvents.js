import { parseAbi, parseAbiItem } from 'viem';
import {
  CHAIN,
  RPC_URL,
  ONCHAIN_POLL_MS,
  ONCHAIN_EVENTS_ENABLED,
  UNISWAP_V3_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  WETH_ADDRESS,
  USDG_ADDRESS,
} from '../config.js';
import { now, pruneSeen, normalizeAddress } from '../utils.js';
import { storeSignalEvent } from '../db/candidates.js';
import { cacheV4Pool } from '../db/v4pools.js';
import { ingestPairSignal, trending, fetchDexPair } from './dexscreener.js';
import { publicClient as client } from '../lib/rpc.js';

/**
 * On-chain Uniswap watcher Robinhood Chain — sumber discovery pasar yang sebenarnya.
 *
 * (Bug lama yang diperbaiki — sebelumnya watcher ini praktis buta:
 *   a. Hanya menonton event V3, padahal pool meme RH hampir semuanya V4
 *      (native-ETH di PoolManager) → semua pool baru tak terlihat.
 *   b. onchainSwaps dikunci alamat POOL sementara trending/onchainActivity
 *      dikunci MINT token → join tak pernah cocok → sinyal on-chain mati.
 *   c. Deteksi sisi WETH pakai substring typo '0bbd7308' (vs 0x0bd7d308…)
 *      → mint selalu salah sisi untuk separuh pool.)
 *
 * Sekarang menonton:
 *   - V4 Initialize + V4 Swap  → semua pool meme baru terdeteksi saat dibuat,
 *     poolKey langsung di-cache ke v4_pools (eksekutor tak perlu rescan),
 *     lalu metrik DexScreener diambil on-demand.
 *   - V3 PoolCreated + V3 Swap → fallback untuk pool WETH lama.
 *   - Swap surge per-mint      → burst swap on-chain = sinyal kelas volume_spike.
 */

const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';

const SWAP_V3 = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);
const V3_POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
);
const V3_POOL_TOKENS_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
const V4_INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'
);
const V4_SWAP = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'
);

export const onchainSwaps = new Map(); // mint -> { count, volumeEth, firstAt, lastAt }
export const onchainNewPools = new Map(); // mint -> { mint, pool, source, seenAt, ... }

// Burst swap on-chain dalam jendela pendek = sinyal kelas volume_spike
const SWAP_SURGE_WINDOW_MS = Number(process.env.ONCHAIN_SURGE_WINDOW_MS || 10 * 60_000);
const SWAP_SURGE_MIN_SWAPS = Number(process.env.ONCHAIN_SURGE_MIN_SWAPS || 4);

const v4PoolsById = new Map(); // poolId(bytes32) -> { currency0, currency1, fee, tickSpacing, hooks, mint, seenAt }
const v3PoolMeta = new Map(); // pool address -> { mint, quoteIsToken0 }

let candidateHandler = null;
const seenOnchain = new Map();
let lastBlock = null;
let consecutiveErrors = 0;
let backoffUntil = 0;
const MAX_BLOCK_RANGE = 50n; // jangan scan terlalu lebar — free RPC sensitif

export function setOnchainCandidateHandler(fn) {
  candidateHandler = fn;
}

// ─── currency helpers ───────────────────────────────────────────────────────

const QUOTE_CURRENCIES = new Set(
  [NATIVE_ZERO, WETH_ADDRESS, USDG_ADDRESS].filter(Boolean).map((a) => normalizeAddress(a))
);

/**
 * Pilih sisi meme dari sepasang currency. null bila kedua sisi quote
 * (ETH/WETH/USDG vs satu sama lain) atau keduanya non-quote — pool seperti
 * itu di luar scope executor (yang hanya mendukung quote ETH/WETH).
 */
export function pickMemeSide(tokenA, tokenB) {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  const aQuote = QUOTE_CURRENCIES.has(a);
  const bQuote = QUOTE_CURRENCIES.has(b);
  if (aQuote && !bQuote) return b;
  if (bQuote && !aQuote) return a;
  return null;
}

/** true jika currency0 adalah sisi quote (ETH native address-0 di V4 ikut dihitung). */
export function quoteSideIsCurrency0(currency0) {
  return QUOTE_CURRENCIES.has(normalizeAddress(currency0));
}

const absBig = (x) => {
  const b = BigInt(x ?? 0n);
  return b < 0n ? -b : b;
};
const weiToEth = (w) => Number(w) / 1e18;

// ─── swap activity tracking (PER-MINT — bukan per-pool) ─────────────────────

function recordSwap(mint, volumeEthAbs) {
  const t = now();
  const prev = onchainSwaps.get(mint);
  let count = prev?.count || 0;
  let volumeEth = prev?.volumeEth || 0;
  let firstAt = prev?.firstAt || 0;
  if (!firstAt || t - firstAt > SWAP_SURGE_WINDOW_MS) {
    count = 0;
    volumeEth = 0;
    firstAt = t;
  }
  onchainSwaps.set(mint, {
    count: count + 1,
    volumeEth: volumeEth + Math.abs(volumeEthAbs || 0),
    firstAt,
    lastAt: t,
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

/** token0/token1 pool V3 dibaca sekali lalu di-cache (null tidak di-cache — coba lagi nanti). */
async function resolveV3PoolMint(pool) {
  const normalized = normalizeAddress(pool);
  if (v3PoolMeta.has(normalized)) return v3PoolMeta.get(normalized);
  let token0;
  let token1;
  try {
    [token0, token1] = await Promise.all([
      client.readContract({ address: normalized, abi: V3_POOL_TOKENS_ABI, functionName: 'token0' }),
      client.readContract({ address: normalized, abi: V3_POOL_TOKENS_ABI, functionName: 'token1' }),
    ]);
  } catch {
    return null; // RPC sibuk — log berikutnya akan mencoba lagi
  }
  const mint = pickMemeSide(token0, token1);
  if (!mint) {
    v3PoolMeta.set(normalized, { mint: null, quoteIsToken0: true });
    return v3PoolMeta.get(normalized);
  }
  const meta = { mint, quoteIsToken0: quoteSideIsCurrency0(token0) };
  v3PoolMeta.set(normalized, meta);
  return meta;
}

// ─── kandidat baru: pool segar + metrik Dex on-demand ───────────────────────

async function announceNewPool({ mint, poolRef, source, extra = {} }) {
  onchainNewPools.set(mint, { mint, pool: poolRef, source, seenAt: now(), ...extra });
  storeSignalEvent(mint, 'new_pool', source, { mint, pool: poolRef, ...extra });

  // Token segar sering belum terindeks di hasil pencarian keyword statis —
  // ambil pair-nya LANGSUNG per-token. Ini yang membuat spike/trending bekerja
  // untuk token sesegar beberapa menit.
  let dex = null;
  try {
    dex = await fetchDexPair(mint);
  } catch {
    /* dexGet sudah menangani backoff */
  }
  if (dex) ingestPairSignal(dex);

  const existing = dex || trending.get(mint) || null;
  if (!candidateHandler) return;
  await candidateHandler({
    mint,
    route: existing ? 'new_pool_dex' : 'new_pool',
    signalMeta: {
      hasVolumeSpike: false,
      hasNewPool: true,
      hasTrending: Boolean(existing),
      hasOnchain: true,
      sourceCount: existing ? 2 : 1,
      sources: existing ? ['new_pool', 'trending'] : ['new_pool'],
      route: existing ? 'dual_source' : 'single_source',
    },
    trendingToken: existing,
    newPool: onchainNewPools.get(mint),
  });
}

// ─── scanners ───────────────────────────────────────────────────────────────

async function scanV3Swaps(fromBlock, toBlock) {
  try {
    const logs = await client.getLogs({ event: SWAP_V3, fromBlock, toBlock });
    consecutiveErrors = 0;
    // Dedupe pool dulu: 1 pool = 2 RPC read maks per siklus, bukan 2 per log
    const slice = logs.slice(0, 150);
    const uniquePools = [...new Set(slice.map((l) => normalizeAddress(l.address)))].slice(0, 40);
    for (const pool of uniquePools) {
      await resolveV3PoolMint(pool);
      if (now() < backoffUntil) return; // RPC mulai ngamuk — sisanya siklus depan
    }
    for (const log of slice) {
      const meta = v3PoolMeta.get(normalizeAddress(log.address));
      if (!meta?.mint) continue;
      // volume dari kaki WETH (ETH ≈ quote); amount int256
      const wei = meta.quoteIsToken0 ? absBig(log.args?.amount0) : absBig(log.args?.amount1);
      recordSwap(meta.mint, weiToEth(wei));
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'swap-v3');
    else if (consecutiveErrors < 3) console.log(`[chain] swap v3 logs: ${err.message}`);
  }
}

async function scanV3PoolCreated(fromBlock, toBlock) {
  if (
    !UNISWAP_V3_FACTORY ||
    UNISWAP_V3_FACTORY === '0x0000000000000000000000000000000000000000' ||
    now() < backoffUntil
  ) {
    return;
  }
  try {
    const created = await client.getLogs({
      address: UNISWAP_V3_FACTORY,
      event: V3_POOL_CREATED,
      fromBlock,
      toBlock,
    });
    consecutiveErrors = 0;
    for (const log of created) {
      const token0 = normalizeAddress(log.args?.token0);
      const token1 = normalizeAddress(log.args?.token1);
      const pool = normalizeAddress(log.args?.pool);
      const mint = pickMemeSide(token0, token1); // fix: dulu substring typo → salah sisi
      if (!mint || !pool) continue;
      const key = `pool:${pool}`;
      if (seenOnchain.has(key)) continue;
      seenOnchain.set(key, now());

      await announceNewPool({
        mint,
        poolRef: pool,
        source: 'uniswap_v3_factory',
        extra: { token0, token1, fee: Number(log.args?.fee || 0), block: Number(log.blockNumber) },
      });
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'poolCreated');
    else if (consecutiveErrors < 5) console.log(`[chain] poolCreated: ${err.message}`);
  }
}

async function scanV4Initialize(fromBlock, toBlock) {
  if (!UNISWAP_V4_POOL_MANAGER || now() < backoffUntil) return;
  try {
    const logs = await client.getLogs({
      address: UNISWAP_V4_POOL_MANAGER,
      event: V4_INITIALIZE,
      fromBlock,
      toBlock,
    });
    consecutiveErrors = 0;
    for (const log of logs) {
      const args = log.args || {};
      const poolId = String(args.id || '').toLowerCase();
      const c0 = normalizeAddress(args.currency0);
      const c1 = normalizeAddress(args.currency1);
      if (!poolId || !c0 || !c1) continue;
      const mint = pickMemeSide(c0, c1);
      if (!mint) continue; // pool tanpa sisi ETH/WETH/USDG (mis. pair USDG–USDG) → skip
      const key = `v4pool:${poolId}`;
      if (seenOnchain.has(key)) continue;
      seenOnchain.set(key, now());

      const entry = {
        currency0: c0,
        currency1: c1,
        fee: Number(args.fee || 0),
        tickSpacing: Number(args.tickSpacing || 0),
        hooks: normalizeAddress(args.hooks || NATIVE_ZERO),
        mint,
        seenAt: now(),
      };
      v4PoolsById.set(poolId, entry);
      // Cache permanen — eksekutor V4 langsung dapat poolKey tanpa rescan log
      try {
        cacheV4Pool(mint, poolId, entry, 'onchain_watch');
      } catch {
        /* cache best-effort */
      }

      await announceNewPool({
        mint,
        poolRef: poolId,
        source: 'uniswap_v4_initialize',
        extra: { poolId, fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks, block: Number(log.blockNumber) },
      });
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'v4-init');
    else if (consecutiveErrors < 5) console.log(`[chain] v4 initialize: ${err.message}`);
  }
}

async function scanV4Swaps(fromBlock, toBlock) {
  if (!UNISWAP_V4_POOL_MANAGER || now() < backoffUntil) return;
  try {
    const logs = await client.getLogs({
      address: UNISWAP_V4_POOL_MANAGER,
      event: V4_SWAP,
      fromBlock,
      toBlock,
    });
    consecutiveErrors = 0;
    for (const log of logs.slice(0, 200)) {
      const poolId = String(log.args?.id || '').toLowerCase();
      const pool = v4PoolsById.get(poolId);
      // poolId tak dikenal = pool dari sebelum boot; log Initialize-nya akan
      // mendaftarkannya saat terlewat dalam rentang scan. Skip (hemat RPC).
      if (!pool?.mint) continue;
      const wei = quoteSideIsCurrency0(pool.currency0) ? absBig(log.args?.amount0) : absBig(log.args?.amount1);
      recordSwap(pool.mint, weiToEth(wei));
    }
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit(err, 'v4-swap');
    else if (consecutiveErrors < 3) console.log(`[chain] v4 swap logs: ${err.message}`);
  }
}

/** Burst swap on-chain = kandidat kelas volume_spike; overlap bila Dex juga punya data. */
async function emitSurgeCandidates() {
  if (!candidateHandler) return;
  for (const [mint, stats] of onchainSwaps) {
    if (stats.count < SWAP_SURGE_MIN_SWAPS) continue;
    if (now() - stats.lastAt > SWAP_SURGE_WINDOW_MS) continue;
    const dex = trending.get(mint) || null;
    const key = `surge:${mint}:${Math.floor(now() / 300_000)}`;
    if (seenOnchain.has(key)) continue;
    seenOnchain.set(key, now());

    storeSignalEvent(mint, 'onchain_swap_surge', dex ? 'onchain_dex_overlap' : 'onchain', {
      swaps: stats.count,
      volumeEth: +stats.volumeEth.toFixed(4),
      dex: Boolean(dex),
    });

    await candidateHandler({
      mint,
      route: dex ? 'onchain_dex_overlap' : 'onchain_surge',
      signalMeta: {
        hasVolumeSpike: true,
        hasNewPool: onchainNewPools.has(mint),
        hasTrending: Boolean(dex),
        hasOnchain: true,
        sourceCount: dex ? 3 : 2,
        sources: dex ? ['volume_spike', 'trending', 'onchain'] : ['volume_spike', 'onchain'],
        route: 'dual_source',
        swapsOnchain: stats.count,
        volumeEthOnchain: +stats.volumeEth.toFixed(4),
      },
      trendingToken: dex,
      newPool: onchainNewPools.get(mint) || null,
    });
  }
}

function pruneAll() {
  pruneSeen(seenOnchain, 20 * 60_000);
  const t = now();
  for (const [mint, stats] of onchainSwaps) {
    if (t - stats.lastAt > SWAP_SURGE_WINDOW_MS * 2) onchainSwaps.delete(mint);
  }
  for (const [mint, pool] of onchainNewPools) {
    if (t - (pool.seenAt || 0) > 6 * 3600_000) onchainNewPools.delete(mint);
  }
  for (const [id, pool] of v4PoolsById) {
    if (t - (pool.seenAt || 0) > 24 * 3600_000) v4PoolsById.delete(id);
  }
  if (v3PoolMeta.size > 2000) {
    for (const key of [...v3PoolMeta.keys()].slice(0, 1000)) v3PoolMeta.delete(key);
  }
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

  // V4 dulu — venue utama meme RH — lalu V3 sebagai fallback
  await scanV4Initialize(fromBlock, toBlock);
  await scanV4Swaps(fromBlock, toBlock);
  await scanV3PoolCreated(fromBlock, toBlock);
  await scanV3Swaps(fromBlock, toBlock);
    await emitSurgeCandidates();
  pruneAll();
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
  console.log(`[chain] watching Uniswap V4+V3 on ${CHAIN.name} (${CHAIN.id}) via ${RPC_URL}`);
  console.log(`[chain] surge: ≥${SWAP_SURGE_MIN_SWAPS} swaps/${Math.round(SWAP_SURGE_WINDOW_MS / 60000)}m → kandidat volume_spike`);
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
