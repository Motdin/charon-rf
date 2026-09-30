import { encodeAbiParameters, concatHex, keccak256, parseAbi, parseAbiItem } from 'viem';
import { V4_DEPLOY_BLOCK } from '../config.js';

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
 * getLogs dengan fallback chunking — RPC publik ada yang membatasi rentang blok.
 */
async function getLogsChunked(client, params, { deployBlock = V4_DEPLOY_BLOCK, chunkSize = 5_000_000n } = {}) {
  try {
    return await client.getLogs({ ...params, fromBlock: BigInt(deployBlock), toBlock: 'latest' });
  } catch (err) {
    const msg = String(err?.message || err?.shortMessage || '');
    if (!/range|limit|exceed|too many|10_?000|batch/i.test(msg)) throw err;
  }
  const latest = await client.getBlockNumber();
  const out = [];
  let from = BigInt(deployBlock);
  while (from <= latest) {
    const to = from + chunkSize - 1n > latest ? latest : from + chunkSize - 1n;
    // eslint-disable-next-line no-await-in-loop
    const chunk = await client.getLogs({ ...params, fromBlock: from, toBlock: to });
    out.push(...chunk);
    from = to + 1n;
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
