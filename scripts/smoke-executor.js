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
import { readFileSync } from 'node:fs';
import { decodeFunctionData } from 'viem';
import {
  buildV4SwapInput,
  classifyV4Failure,
  getLogsChunked,
  parseRangeLimit,
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
  portionOfRawAmount,
  toRawAmountString,
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

// ── getLogsChunked adaptif (drpc free = 10.000 blok; kasus live #43 VRAX) ──

ok('parseRangeLimit: angka limit dari pesan error', () => {
  assert.equal(parseRangeLimit('ranges over 10000 blocks are not supported on free plan'), 10_000n);
  assert.equal(parseRangeLimit('query returned more than 5,000 blocks'), 5_000n);
  assert.equal(parseRangeLimit('block range too large'), null);
  assert.equal(parseRangeLimit(''), null);
});

/** Fake RPC client: fast-path full range SELALU ditolak dg pesan limit drpc; chunk > maxRange juga ditolak. */
function makeLimitedClient({ maxRange, latest, logMsg }) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() {
      return BigInt(latest);
    },
    async getLogs({ fromBlock, toBlock }) {
      const to = toBlock === 'latest' ? BigInt(latest) : BigInt(toBlock);
      calls.push([BigInt(fromBlock), to]);
      if (to - BigInt(fromBlock) + 1n > BigInt(maxRange)) {
        throw new Error(logMsg ?? `ranges over ${maxRange} blocks are not supported on free plan`);
      }
      return [`log@${fromBlock}-${to}`];
    },
  };
}

/** Rentang dari log palsu 'log@from-to' + verifikasi cakupan kontigu tanpa celah. */
function logRanges(logs) {
  return logs.map((l) => l.replace('log@', '').split('-').map(BigInt));
}
function assertContiguousCoverage(logs, start, latest, maxSpan) {
  const ranges = logRanges(logs);
  assert.ok(ranges.length > 0, 'tidak ada log');
  assert.equal(ranges[0][0], BigInt(start), 'chunk pertama mulai di deployBlock');
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i][0], ranges[i - 1][1] + 1n, 'tidak boleh ada celah antar chunk');
  }
  assert.equal(ranges[ranges.length - 1][1], BigInt(latest), 'chunk terakhir sampai latest');
  for (const [from, to] of ranges) {
    assert.ok(to - from + 1n <= BigInt(maxSpan), `chunk diterima ${from}..${to} melampaui limit`);
  }
}

await okAsync('getLogsChunked: adopsi limit 10.000 dari pesan error (fast path ditolak)', async () => {
  const client = makeLimitedClient({ maxRange: 10_000, latest: 119_999 });
  const logs = await getLogsChunked(client, { address: '0x' + '11'.repeat(20) }, { deployBlock: 100_000 });
  assert.equal(logs.length, 2); // 100000..109999, 110000..119999
  assertContiguousCoverage(logs, 100_000, 119_999, 10_000);
});

await okAsync('getLogsChunked: tanpa angka di pesan → halving adaptif', async () => {
  // Server hanya menerima ≤ 1500 blok; pesan error TIDAK menyebut angka
  const client = makeLimitedClient({ maxRange: 1_500, latest: 3_000, logMsg: 'block range exceeds limit' });
  const logs = await getLogsChunked(client, { address: '0x' + '22'.repeat(20) }, { deployBlock: 1_000 });
  assert.ok(logs.length >= 2, 'range 2000 blok ter-cover penuh via chunk mengecil');
  assertContiguousCoverage(logs, 1_000, 3_000, 1_500);
});

await okAsync('getLogsChunked: error non-limit dilempar ulang', async () => {
  const client = {
    async getBlockNumber() {
      return 5n;
    },
    async getLogs() {
      throw new Error('network unreachable');
    },
  };
  let threw = false;
  try {
    await getLogsChunked(client, {}, { deployBlock: 1 });
  } catch (err) {
    threw = /network unreachable/.test(String(err.message));
  }
  assert.equal(threw, true);
});

// ─── Regresi: setiap pengiriman transaksi WAJIB di-await ─────────────────────
// Insiden nyata: `const hash = walletClient.writeContract(...)` tanpa await →
// tx TETAP tersiar (dompet menunjukkan pembelian) tapi `hash` adalah Promise,
// waitForTransactionReceipt menunggu "[object Promise]" sampai timeout 180 s,
// lalu melempar. Hasilnya: dana keluar, posisi tidak pernah tercatat, tidak ada
// TP/SL, dan wrap ikut di-rollback keliru.
ok('setiap writeContract/sendTransaction di-await (regresi tx-hilang)', () => {
  const src = readFileSync(new URL('../src/liveExecutor.js', import.meta.url), 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(
      ({ line }) =>
        /\b(writeContract|sendTransaction)\s*\(/.test(line) &&
        !/simulateContract/.test(line) &&
        !/\bawait\b/.test(line) &&
        !line.startsWith('*') &&
        !line.startsWith('//')
    );
  assert.equal(
    offenders.length,
    0,
    `pengiriman tx tanpa await di liveExecutor.js: ${offenders.map((o) => `baris ${o.no}`).join(', ')}`
  );
});

ok('kegagalan setelah tx tersiar tidak me-rollback wrap', () => {
  const src = readFileSync(new URL('../src/liveExecutor.js', import.meta.url), 'utf8');
  // Kedua venue harus lewat finalizeSwapFailure, bukan rollbackWrap langsung.
  assert.equal(
    (src.match(/throw await finalizeSwapFailure\(/g) || []).length,
    2,
    'executeSwapV4 dan executeSwapV3 harus memakai finalizeSwapFailure'
  );
  assert.ok(/err\.broadcast = true/.test(src), 'error harus ditandai broadcast agar bisa direkonsiliasi');
});

// ─── Regresi: jalur JUAL tidak boleh diveto heuristik likuiditas ─────────────
// getLiquidity = likuiditas pada tick AKTIF saja. Memecoin yang harganya jatuh
// keluar dari range LP melaporkan 0 padahal pool masih bisa di-swap dengan
// melintasi tick. Memveto rute atas dasar ini mengunci posisi → "token tidak
// bisa dijual, tidak ada pair aktif".
await okAsync('pickMostLiquidPool: allowZeroLiquidity menyelamatkan rute EXIT', async () => {
  const pools = [
    { poolId: '0xaaaa', poolKey: { fee: 3000 } },
    { poolId: '0xbbbb', poolKey: { fee: 10000 } },
  ];
  const fakeClient = {
    async readContract() {
      return 0n; // semua tick-aktif kosong, tapi pool DIKENAL PoolManager
    },
  };
  const sv = '0x' + '2'.repeat(40);

  // Beli (default): tetap ditolak — perilaku lama dipertahankan.
  assert.equal(await pickMostLiquidPool(fakeClient, sv, pools), null);

  // Jual: harus dapat kandidat supaya quoter yang memutuskan.
  const exit = await pickMostLiquidPool(fakeClient, sv, pools, { allowZeroLiquidity: true });
  assert.ok(exit, 'jalur exit harus tetap mendapat pool kandidat');
  assert.equal(exit.poolId, '0xaaaa');
  assert.equal(exit.liquidity, 0n);
});

await okAsync('pickMostLiquidPool: pool HANTU (getLiquidity revert) tetap ditolak saat exit', async () => {
  const pools = [{ poolId: '0xdead', poolKey: {} }];
  const fakeClient = {
    async readContract() {
      throw new Error('execution reverted'); // bukan pool PoolManager ini
    },
  };
  const exit = await pickMostLiquidPool(fakeClient, '0x' + '2'.repeat(40), pools, { allowZeroLiquidity: true });
  assert.equal(exit, null, 'pool hantu tidak boleh dipakai walau untuk exit');
});

ok('cooldown kegagalan hanya memblok BELI, tidak memblok JUAL', () => {
  const src = readFileSync(new URL('../src/liveExecutor.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function executeSwap'));
  const guard = body.slice(0, body.indexOf('const deadline'));
  const coolIdx = guard.indexOf('mintCooldownLeft(memeToken)');
  const buyOnlyIdx = guard.indexOf('if (isNativeIn)');
  assert.ok(coolIdx > -1 && buyOnlyIdx > -1, 'gate cooldown harus ada');
  assert.ok(
    buyOnlyIdx < coolIdx,
    'mintCooldownLeft harus berada DI DALAM cabang isNativeIn (beli) — exit wajib selalu boleh dicoba'
  );
});

ok('resolveSwapRoute melonggarkan gate likuiditas khusus untuk jual', () => {
  const src = readFileSync(new URL('../src/liveExecutor.js', import.meta.url), 'utf8');
  assert.ok(
    /resolveSwapRoute\(memeToken, dexPair, \{ allowZeroLiquidity: !isNativeIn \}\)/.test(src),
    'executeSwap harus meneruskan allowZeroLiquidity untuk sisi jual'
  );
});

// ─── Regresi K-1: presisi uint256 pada partial TP ────────────────────────────
// Saldo memecoin 18-desimal rutin melewati 2^53 dan >= 1e21. Jalur lama
// `Math.floor(Number(raw) * pct)` + `String()` menghasilkan "2.5e+24", yang
// membuat BigInt() di executeLiveSell melempar → partial TP gagal diam-diam.
ok('portionOfRawAmount: BigInt penuh, tanpa notasi eksponensial', () => {
  const raw = '5000000000000000000000000'; // 5 juta token @18 desimal = 5e24

  // Kontrol: jalur LAMA memang rusak untuk nilai ini.
  const legacy = String(Math.floor(Number(raw) * 0.5));
  assert.match(legacy, /e\+/i, 'kontrol: jalur lama menghasilkan eksponensial');
  assert.throws(() => BigInt(legacy), 'kontrol: BigInt() melempar pada hasil lama');

  // Jalur baru.
  const half = portionOfRawAmount(raw, 50);
  assert.equal(half, 2500000000000000000000000n, 'separuh tepat, tanpa kehilangan presisi');
  assert.doesNotMatch(half.toString(), /e\+/i, 'tidak ada notasi eksponensial');
  assert.equal(BigInt(half.toString()), half, 'bisa di-parse ulang oleh BigInt');
});

ok('portionOfRawAmount: floor, persen pecahan, dan batas aman', () => {
  assert.equal(portionOfRawAmount('100', 12.5), 12n, 'persen pecahan akurat + floor');
  assert.equal(portionOfRawAmount('7', 50), 3n, 'floor: jangan pernah jual lebih dari yang dimiliki');
  assert.equal(portionOfRawAmount('1000', 100), 1000n, '100% = seluruhnya');
  assert.equal(portionOfRawAmount('1000', 150), 1000n, '>100% dibatasi ke seluruhnya');
  assert.equal(portionOfRawAmount('1000', 0), 0n, '0% = nol');
  assert.equal(portionOfRawAmount('0', 50), 0n, 'saldo nol aman');

  // Sisa + terjual harus selalu = total (tidak boleh ada token menguap).
  const raw = 123456789012345678901234567n;
  const sell = portionOfRawAmount(raw, 37);
  assert.ok(sell + (raw - sell) === raw, 'sisa + terjual = total');
});

ok('toRawAmountString: estimasi besar tetap string desimal valid', () => {
  // Kontraknya BUKAN presisi sempurna — inputnya float hasil estimasi, jadi
  // kehilangan presisi di luar ~17 digit signifikan memang melekat. Yang
  // dijamin: hasilnya SELALU string desimal yang bisa di-BigInt(), tidak
  // pernah notasi eksponensial. Itulah yang dulu merusak jalur jual.
  const out = toRawAmountString(5_000_000);
  assert.doesNotMatch(out, /e\+/i, '5 juta token tidak jadi eksponensial');
  assert.doesNotThrow(() => BigInt(out), 'selalu bisa di-parse BigInt');

  // Akurat dalam toleransi float (relatif < 1e-12).
  const got = BigInt(out);
  const want = 5000000000000000000000000n;
  const drift = got > want ? got - want : want - got;
  assert.ok(drift * 1_000_000_000_000n < want, `drift float dapat diabaikan (${drift})`);

  // Kontrol: jalur lama pada nilai yang sama memang menghasilkan eksponensial.
  assert.match(String(Math.floor(5_000_000 * 1e18)), /e\+/i, 'kontrol: jalur lama rusak');

  assert.equal(toRawAmountString(0), '0');
  assert.equal(toRawAmountString(-5), '0', 'negatif ditolak');
  assert.equal(toRawAmountString(Infinity), '0', 'Infinity ditolak');
  assert.equal(toRawAmountString(NaN), '0', 'NaN ditolak');
});

ok('partial TP: markPartialTpDone hanya SETELAH jual berhasil', () => {
  const src = readFileSync(new URL('../src/execution/positions.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('// Partial TP'), src.indexOf('// Standard exits'));
  const sellIdx = block.indexOf('await executeLiveSell');
  const markIdx = block.indexOf('markPartialTpDone', sellIdx);
  assert.ok(sellIdx > -1, 'blok partial TP harus memanggil executeLiveSell');
  assert.ok(markIdx > sellIdx, 'markPartialTpDone harus SETELAH jual — kegagalan wajib bisa retry');
  // Tidak boleh ada Number() pada token_amount_raw di blok ini.
  assert.doesNotMatch(
    block,
    /Number\(\s*position\.token_amount_raw/,
    'token_amount_raw tidak boleh lewat Number()'
  );
  assert.match(block, /portionOfRawAmount\(/, 'harus memakai helper BigInt');
});

console.log(`\n✓ smoke-executor PASSED (${passed} tests)`);
