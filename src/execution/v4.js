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

/** Pilih pool dengan likuiditas terbesar via StateView.getLiquidity. */
export async function pickMostLiquidPool(client, stateView, pools) {
  let best = null;
  let bestLiq = -1n;
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
