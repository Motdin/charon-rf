import { encodeAbiParameters, concatHex, keccak256, parseAbi, parseAbiItem } from 'viem';
import { V4_DEPLOY_BLOCK, LOG_SCAN_CHUNK_BLOCKS, LOG_SCAN_PACE_MS } from '../config.js';
import { sleep } from '../utils.js';

/**
 * Uniswap V4 di Robinhood Chain — helper murni + reader on-chain.
 *
 * Encoding V4_SWAP diverifikasi byte-identik dengan tx mainnet yang SUKSES:
 *   tx 0xbf3f6dc7d2d667bb8c11b1a863757d1d16eea246ea8615b98febd70fe8ed2b4e
 *   commands = 0x10 (V4_SWAP), actions = 0x060c0f (SWAP_EXACT_IN_SINGLE/SETTLE_ALL/TAKE_ALL)
 *
 * UniversalRouter RH = build standar Uniswap (bukan fork berbeda) — lihat
 * scripts/smoke-executor.js untuk golden test terhadap tx tersebut.
 */

// ─── Konstanta perintah ───────────────────────────────────────────────────────
export const V4_COMMAND_V4_SWAP = '0x10';
export const V4_ACTION_SWAP_EXACT_IN_SINGLE = '0x06';
export const V4_ACTION_SETTLE_ALL = '0x0c';
export const V4_ACTION_TAKE_ALL = '0x0f';

export const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export const V4_STATE_VIEW_ABI = parseAbi([
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

// PoolManager.Initialize — id, currency0, currency1 indexed; sisanya di data.
export const V4_INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'
);

const POOL_KEY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
};

// ─── Builder calldata (pure) ──────────────────────────────────────────────────

/**
 * Bangun (commands, inputs) untuk 1x V4_SWAP exact-in single-hop.
 * actions = [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
 * params  = [ExactInputSingleParams, settle(currencyIn, maxIn), take(currencyOut, minOut)]
 */
export function buildV4SwapInput({ poolKey, zeroForOne, amountIn, minOut }) {
  const amountInBI = BigInt(amountIn);
  const minOutBI = BigInt(minOut);

  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'poolKey', ...POOL_KEY_TUPLE },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [
      {
        poolKey,
        zeroForOne: Boolean(zeroForOne),
        amountIn: amountInBI,
        amountOutMinimum: minOutBI,
        hookData: '0x',
      },
    ]
  );

  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [currencyIn, amountInBI]
  );
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [currencyOut, minOutBI]
  );

  const actions = concatHex([
    V4_ACTION_SWAP_EXACT_IN_SINGLE,
    V4_ACTION_SETTLE_ALL,
    V4_ACTION_TAKE_ALL,
  ]);

  const input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]]
  );

  return {
    commands: V4_COMMAND_V4_SWAP,
    inputs: [input],
    currencyIn,
    currencyOut,
  };
}

/** poolId = keccak256(abi.encode(poolKey)). */
export function poolIdFromKey(poolKey) {
  return keccak256(encodeAbiParameters([POOL_KEY_TUPLE], [poolKey]));
}

// ─── Pembaca on-chain ─────────────────────────────────────────────────────────

function decodeInitializeLog(log) {
  const a = log.args || {};
  if (a.currency0 == null || a.currency1 == null) return null;
  return {
    poolId: a.id,
    poolKey: {
      currency0: a.currency0,
      currency1: a.currency1,
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
      hooks: a.hooks,
    },
    blockNumber: log.blockNumber,
  };
}

/**
 * Ekstrak batas blok maksimum dari pesan error RPC.
 * drpc free: "ranges over 10000 blocks are not supported on free plan"
 */
export function parseRangeLimit(msg) {
  const m = String(msg || '').match(/(\d[\d_,]*)\s*blocks/i);
  if (!m) return null;
  try {
    const n = BigInt(m[1].replace(/[_,]/g, ''));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function isRangeLimitError(err) {
  const msg = String(err?.message || err?.shortMessage || err?.details || '');
  return /range|limit|exceed|too many|batch|blocks/i.test(msg);
}

/**
 * getLogs dengan chunking ADAPTIF — RPC publik membatasi rentang blok per call
 * (drpc free = 10.000 blok → scan Initialize ~5 juta blok gagal total;
 * kasus live #43 VRAX). Strategi:
 *   1) fast path: coba full range (beberapa RPC mengizinkan)
 *   2) limit error → pakai angka limit dari pesan error, atau
 *      LOG_SCAN_CHUNK_BLOCKS (default 10.000 — aman semua free plan)
 *   3) masih ditolak → chunk dibelah dua sampai diterima (min 500 blok)
 *   4) 429 per-chunk → sleep sejenak lalu retry chunk yang sama
 */
export async function getLogsChunked(client, params, { deployBlock = V4_DEPLOY_BLOCK, chunkSize = null } = {}) {
  const fromStart = BigInt(deployBlock);
  let derived = chunkSize ? BigInt(chunkSize) : null;
  try {
    return await client.getLogs({ ...params, fromBlock: fromStart, toBlock: 'latest' });
  } catch (err) {
    if (!isRangeLimitError(err)) throw err;
    if (!derived) {
      derived =
        parseRangeLimit(err?.message) ||
        parseRangeLimit(err?.details) ||
        BigInt(LOG_SCAN_CHUNK_BLOCKS || 10_000);
    }
  }

  const latest = await client.getBlockNumber();
  if (latest <= fromStart) return [];

  let chunk = derived > 0n ? derived : 10_000n;
  const MIN_CHUNK = 500n;
  const out = [];
  let from = fromStart;
  let iter = 0;
  let retries429 = 0;

  console.log(`[route] scan logs chunked: blok ${fromStart}→${latest} (~${(latest - fromStart) / chunk} chunk @${chunk})`);

  while (from <= latest) {
    if (++iter > 30_000) throw new Error('log scan abort: iterasi chunk berlebihan');
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    try {
      // eslint-disable-next-line no-await-in-loop
      const part = await client.getLogs({ ...params, fromBlock: from, toBlock: to });
      out.push(...part);
      from = to + 1n;
      retries429 = 0;
      if (from <= latest && LOG_SCAN_PACE_MS > 0) {
        await sleep(LOG_SCAN_PACE_MS);
      }
    } catch (err) {
      const text = String(err?.message || err?.shortMessage || err?.details || '');
      if (/\b429\b|too many requests|rate.?limit/i.test(text) && retries429 < 5) {
        retries429++;
        await sleep(1500 * retries429);
        continue; // retry chunk yang sama
      }
      if (isRangeLimitError(err) && chunk > MIN_CHUNK) {
        const parsed = parseRangeLimit(err?.message) || parseRangeLimit(err?.details);
        chunk = parsed && parsed < chunk ? parsed : chunk / 2n;
        if (chunk < MIN_CHUNK) chunk = MIN_CHUNK;
        console.log(`[route] RPC menolak rentang — chunk diturunkan ke ${chunk} blok`);
        continue;
      }
      throw err;
    }
  }
  return out;
}

/**
 * Cari pool V4 untuk sebuah pasangan.
 * Prioritas: poolIdHint (dari DexScreener pairAddress) → 1 log pasti.
 * Fallback: filter Initialize by currency pair (dua arah urutan).
 */
export async function findV4Pools(client, poolManager, { poolIdHint = null, currencies = null } = {}) {
  const base = { address: poolManager, event: V4_INITIALIZE_EVENT, strict: true };

  if (poolIdHint) {
    const logs = await getLogsChunked(client, { ...base, args: { id: poolIdHint } });
    return logs.map(decodeInitializeLog).filter(Boolean);
  }

  if (Array.isArray(currencies) && currencies.length) {
    const [a, b] = currencies;
    const seen = new Set();
    const out = [];
    const combos = b
      ? [
          { currency0: a, currency1: b },
          { currency0: b, currency1: a },
        ]
      : [{ currency1: a }, { currency0: a }];
    for (const args of combos) {
      // eslint-disable-next-line no-await-in-loop
      const logs = await getLogsChunked(client, { ...base, args });
      for (const log of logs) {
        const decoded = decodeInitializeLog(log);
        if (!decoded || seen.has(decoded.poolId)) continue;
        seen.add(decoded.poolId);
        out.push(decoded);
      }
    }
    return out;
  }

  return [];
}

/**
 * Pilih pool dengan likuiditas TERBESAR via StateView.getLiquidity.
 * Pool tanpa likuiditas aktif (liq = 0: baru di-initialize, pair kembar
 * lintas PoolManager, atau LP sudah ditarik) DITOLAK — menukar di pool
 * zero-liq hanya menghasilkan quoter revert (UnexpectedRevertBytes) dan
 * nyata terjadi live (token 0x9e7a…c86, pool 0x1057c266…c2307).
 */
export async function pickMostLiquidPool(client, stateView, pools) {
  let best = null;
  let bestLiq = 0n; // sentinel 0, bukan -1: pool zero-liquidity tak pernah menang
  for (const entry of pools || []) {
    let liq = 0n;
    try {
      // eslint-disable-next-line no-await-in-loop
      liq = await client.readContract({
        address: stateView,
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getLiquidity',
        args: [entry.poolId],
      });
    } catch {
      continue;
    }
    if (liq > bestLiq) {
      bestLiq = liq;
      best = { ...entry, liquidity: liq };
    }
  }
  return best;
}

// ─── Klasifikasi kegagalan (pesan ramah untuk Telegram) ───────────────────────

/**
 * Selector revert yang relevan di jalur V4 (diverifikasi on-chain 2026-09-30):
 *   0x6190b2b0 UnexpectedRevertBytes(bytes) — QuoterRevert membungkus revert
 *     asli PoolManager (pool kelihatan di log tapi tidak bisa di-swap:
 *     tidak ter-inisialisasi di PM ini / nol likuiditas / venue lain).
 *   0x486aa307 PoolNotInitialized()
 *   0x9f65e7f8 V4TooLittleReceived() — output < minOut (harga bergerak)
 *   0xbe8b8507 V4TooMuchRequested() — settle melampaui batas
 *   0x2c4029e9 ExecutionFailed(uint256,bytes) — sub-perintah UR gagal
 */
const V4_REVERT_TABLE = [
  ['0x6190b2b0', 'UnexpectedRevertBytes', 'pool tak bisa di-swap di PoolManager ini (belum di-initialize di sini / tanpa likuiditas / pool kembar venue lain)'],
  ['0x486aa307', 'PoolNotInitialized', 'pool belum ter-initialize di PoolManager official — poolId ini hidup di venue lain'],
  ['0x9f65e7f8', 'V4TooLittleReceived', 'output di bawah minOut — harga bergerak saat eksekusi (slippage), coba lagi'],
  ['0xbe8b8507', 'V4TooMuchRequested', 'settle melebihi batas input — rute bermasalah'],
  ['0x2c4029e9', 'ExecutionFailed', 'sub-perintah Universal Router gagal'],
];

function collectErrorText(err) {
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 6) {
    for (const key of ['shortMessage', 'data', 'message']) {
      if (cur[key]) parts.push(String(cur[key]));
    }
    if (Array.isArray(cur.metaMessages)) parts.push(...cur.metaMessages.map(String));
    cur = cur.cause;
    depth++;
  }
  return parts.join(' ');
}

/**
 * Ubah error viem yang bertele-tele menjadi ringkasan 1 baris.
 * Return: { raw: 'empty'|'selector'|'unknown', code, summary }
 */
export function classifyV4Failure(err) {
  const text = collectErrorText(err);
  const selectors = text.match(/0x[0-9a-fA-F]{8}\b/g) || [];
  for (const [sig, code, hint] of V4_REVERT_TABLE) {
    const found = selectors.find((s) => s.toLowerCase() === sig);
    if (found) return { raw: 'selector', code: found, summary: `${code} — ${hint}` };
  }
  // revert polos tanpa data (require tanpa reason: gate transfer token, settle gagal, dll)
  if (/execution reverted/i.test(text) && !selectors.length) {
    return {
      raw: 'empty',
      code: null,
      summary:
        'revert tanpa reason — umumnya token membatasi transfer pool ini (gate/hook) atau settle WETH gagal; mint dilewati sementara',
    };
  }
  const firstLine = String(err?.shortMessage || err?.message || err).split('\n')[0].slice(0, 180);
  return { raw: 'unknown', code: null, summary: firstLine || 'kesalahan tidak dikenal' };
}

/**
 * Quote exact-in via V4Quoter resmi.
 * Fungsi quoter non-view by design tapi return normal saat dipanggil eth_call —
 * aman dipakai via readContract tanpa mengubah state.
 */
export async function quoteV4ExactInputSingle(client, quoter, { poolKey, zeroForOne, exactAmount, hookData = '0x' }) {
  const result = await client.readContract({
    address: quoter,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey,
        zeroForOne: Boolean(zeroForOne),
        exactAmount: BigInt(exactAmount),
        hookData,
      },
    ],
  });
  const [amountOut, gasEstimate] = result;
  return { amountOut: BigInt(amountOut), gasEstimate: BigInt(gasEstimate) };
}
