#!/usr/bin/env node
/**
 * Offline smoke test untuk jalur eksekusi live (V3/V4).
 *
 * GOLDEN TEST: buildV4SwapInput harus menghasilkan calldata BYTE-IDENTIK
 * dengan tx mainnet Robinhood Chain yang SUKSES:
 *   0xbf3f6dc7d2d667bb8c11b1a863757d1d16eea246ea8615b98febd70fe8ed2b4e
 *   (UniversalRouter.execute, command V4_SWAP, ETH → 0x740C…9Ca3, sukses)
 *
 * Jika test ini lulus, encoding kita kompatibel persis dengan router on-chain.
 */
import { strict as assert } from 'node:assert';
import { decodeFunctionData } from 'viem';
import {
  buildV4SwapInput,
  classifyV4Failure,
  pickMostLiquidPool,
  poolIdFromKey,
  UNIVERSAL_ROUTER_ABI,
} from '../src/execution/v4.js';
import {
  isNativeSentinel,
  looksLikeV4PoolId,
  routeKindFromDexPair,
  minOutWithSlippage,
  wrapDeficit,
  reserveVerdict,
} from '../src/execution/swapMath.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
async function okAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Golden V4 calldata ───────────────────────────────────────────────────────
const GOLDEN = {
  poolKey: {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x740c7f5c316c4bfd3e137da87ea5f83514db9ca3',
    fee: 2500,
    tickSpacing: 25, // fee 2500 → tickSpacing 25 (dibaca dari Initialize on-chain, JANGAN ditebak)
    hooks: '0x0000000000000000000000000000000000000000',
  },
  zeroForOne: true,
  amountIn: 235304844383358n, // 0xd6022da9d47e — sama persis dengan value tx asli
  minOut: 0n,
};

// raw_input lengkap tx on-chain yang SUKSES — ground truth.
// String ini self-validating: kalau salah ketik sedikit saja, decodeFunctionData akan melempar error.
const GOLDEN_RAW_TX =
  '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006abc04dc00000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000340000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000240000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000740c7f5c316c4bfd3e137da87ea5f83514db9ca300000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000019000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000d6022da9d47e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d6022da9d47e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000740c7f5c316c4bfd3e137da87ea5f83514db9ca30000000000000000000000000000000000000000000000000000000000000000';

// ─── Tests ────────────────────────────────────────────────────────────────────
console.log('smoke-executor: V4/V3 execution path (offline)');

ok('GOLDEN: raw tx on-chain ter-decode bersih (self-validating)', () => {
  const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: GOLDEN_RAW_TX });
  const [commands, inputs, deadline] = decoded.args;
  assert.equal(commands, '0x10', 'commands on-chain harus V4_SWAP (0x10)');
  assert.equal(inputs.length, 1);
  assert.equal(Number(deadline), 1790706908, 'sanity: deadline golden tx');
});

ok('GOLDEN: builder kita byte-identik dengan tx mainnet yang SUKSES', () => {
  const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: GOLDEN_RAW_TX });
  const [chainCommands, chainInputs] = decoded.args;
  const ours = buildV4SwapInput(GOLDEN);
  assert.equal(ours.commands, chainCommands);
  assert.equal(ours.inputs.length, chainInputs.length);
  assert.equal(ours.inputs[0], chainInputs[0], 'builder output ≠ calldata tx on-chain yang SUKSES');
  assert.equal(ours.currencyIn.toLowerCase(), GOLDEN.poolKey.currency0);
  assert.equal(ours.currencyOut.toLowerCase(), GOLDEN.poolKey.currency1);
});

ok('poolIdFromKey deterministik (66-hex)', () => {
  const id = poolIdFromKey(GOLDEN.poolKey);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(id, poolIdFromKey({ ...GOLDEN.poolKey }));
});

ok('isNativeSentinel', () => {
  assert.ok(isNativeSentinel(null));
  assert.ok(isNativeSentinel(''));
  assert.ok(isNativeSentinel('0x0000000000000000000000000000000000000000'));
  assert.ok(!isNativeSentinel('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'));
});

ok('looksLikeV4PoolId (poolId 32-byte ≠ contract address)', () => {
  assert.ok(looksLikeV4PoolId('0x7e2b24e977f5b0ba22de16b4682f00578200599615ae538f86ac393ab2c7bad9'));
  assert.ok(!looksLikeV4PoolId('0x8366a39CC670B4001A1121B8F6A443A643e40951'));
  assert.ok(!looksLikeV4PoolId(''));
});

ok('routeKindFromDexPair', () => {
  assert.equal(
    routeKindFromDexPair({ labels: ['v4'], pairAddress: '0x7e2b24e977f5b0ba22de16b4682f00578200599615ae538f86ac393ab2c7bad9' }),
    'v4'
  );
  assert.equal(
    routeKindFromDexPair({ labels: ['v3'], pairAddress: '0x8366a39CC670B4001A1121B8F6A443A643e40951' }),
    'v3'
  );
  // poolId tanpa label pun terdeteksi v4 (kasus MOON di insiden user)
  assert.equal(
    routeKindFromDexPair({ labels: [], pairAddress: '0x7e2b24e977f5b0ba22de16b4682f00578200599615ae538f86ac393ab2c7bad9' }),
    'v4'
  );
  assert.equal(routeKindFromDexPair(null), null);
  assert.equal(routeKindFromDexPair({ labels: [], pairAddress: '0x8366a39CC670B4001A1121B8F6A443A643e40951' }), null);
});

ok('minOutWithSlippage', () => {
  // 3% slippage: 1e18 → 0.97e18
  assert.equal(minOutWithSlippage(10n ** 18n, 300), 97n * 10n ** 16n);
  assert.equal(minOutWithSlippage(0n, 300), 0n);
  // slippage aneh di-clamp
  assert.equal(minOutWithSlippage(1000n, 999_999), 0n);
  assert.equal(minOutWithSlippage(1000n, -5), 1000n);
});

ok('wrapDeficit — hanya kekurangan yang di-wrap', () => {
  assert.equal(wrapDeficit(10n ** 18n, 0n), 10n ** 18n);
  assert.equal(wrapDeficit(10n ** 18n, 4n * 10n ** 17n), 6n * 10n ** 17n);
  assert.equal(wrapDeficit(10n ** 18n, 2n * 10n ** 18n), 0n);
});

ok('reserveVerdict — WETH ikut dihitung, reserve tetap native', () => {
  const eth = (n) => BigInt(Math.round(n * 1e18));
  // Sebagian dana di WETH: total cukup + gas native masih ≥ reserve → bisa jalan
  let v = reserveVerdict({
    nativeWei: eth(0.001),
    wethWei: eth(0.001),
    needWei: eth(0.001),
    reserveWei: eth(0.0005),
  });
  assert.equal(v.sufficient, true);
  assert.equal(v.totalOk, true);
  // native habis total → gasOk false → tidak sufficient
  v = reserveVerdict({
    nativeWei: eth(0.0),
    wethWei: eth(0.002),
    needWei: eth(0.001),
    reserveWei: eth(0.0005),
  });
  assert.equal(v.sufficient, false);
  assert.equal(v.gasOk, false);
  // dana total kurang → tidak sufficient
  v = reserveVerdict({
    nativeWei: eth(0.0003),
    wethWei: eth(0.0005),
    needWei: eth(0.001),
    reserveWei: eth(0.0005),
  });
  assert.equal(v.sufficient, false);
  assert.equal(v.totalOk, false);
  // kasus normal: native saja cukup
  v = reserveVerdict({
    nativeWei: eth(0.005),
    wethWei: 0n,
    needWei: eth(0.001),
    reserveWei: eth(0.0005),
  });
  assert.equal(v.sufficient, true);
});

await okAsync('pickMostLiquidPool: pool zero-liquidity DITOLAK (regresi insiden 0x9e7a…c86)', async () => {
  // Regresi nyata: pool kembar (ETH,token,10000,200) tanpa likuiditas menang
  // seleksi karena sentinel -1n, lalu quoter revert UnexpectedRevertBytes.
  const pools = [
    { poolId: '0xaaaa', poolKey: { currency0: '0x' + '0'.repeat(40), currency1: '0x' + '1'.repeat(40), fee: 10000, tickSpacing: 200, hooks: '0x' + '0'.repeat(40) } },
    { poolId: '0xbbbb', poolKey: { currency0: '0x' + '0'.repeat(40), currency1: '0x' + '1'.repeat(40), fee: 3000, tickSpacing: 60, hooks: '0x' + '0'.repeat(40) } },
  ];
  const liqById = { '0xaaaa': 0n, '0xbbbb': 42n };
  const fakeClient = {
    async readContract({ args }) {
      return liqById[args[0]];
    },
  };
  const best = await pickMostLiquidPool(fakeClient, '0x' + '2'.repeat(40), pools);
  assert.equal(best.poolId, '0xbbbb', 'pool ber-liq harus menang');
});

await okAsync('pickMostLiquidPool: semua zero/rusak → null (bukan pool hantu)', async () => {
  const pools = [
    { poolId: '0xaaaa', poolKey: {} },
    { poolId: '0xcccc', poolKey: {} },
  ];
  const fakeClient = {
    async readContract({ args }) {
      if (args[0] === '0xcccc') throw new Error('rpc gagal');
      return 0n;
    },
  };
  const best = await pickMostLiquidPool(fakeClient, '0x' + '2'.repeat(40), pools);
  assert.equal(best, null, 'tanpa pool ber-liq, hasil harus null');
});

ok('classifyV4Failure: selector → dikenali, empty revert → gate hint', () => {
  let cls = classifyV4Failure(new Error('The contract function "quoteExactInputSingle" reverted with the following signature:\n0x6190b2b0'));
  assert.equal(cls.raw, 'selector');
  assert.match(cls.summary, /UnexpectedRevertBytes/);

  cls = classifyV4Failure(new Error('The contract function "execute" reverted.\nDetails: execution reverted'));
  assert.equal(cls.raw, 'empty');
  assert.match(cls.summary, /tanpa reason/);

  cls = classifyV4Failure(new Error('The contract function reverted with signature 0x486aa307'));
  assert.match(cls.summary, /PoolNotInitialized/);

  cls = classifyV4Failure(new Error('some random rpc timeout'));
  assert.equal(cls.raw, 'unknown');
});

console.log(`\n✓ smoke-executor PASSED (${passed} tests)`);
