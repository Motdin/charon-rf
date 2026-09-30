import {
  createWalletClient,
  parseAbi,
  formatEther,
  parseEther,
  maxUint160,
  maxUint256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import {
  CHAIN,
  RPC_URL,
  PRIVATE_KEY,
  WETH_ADDRESS,
  UNISWAP_ROUTER,
  UNISWAP_V3_FACTORY,
  UNISWAP_UNIVERSAL_ROUTER,
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_QUOTER,
  UNISWAP_V4_STATE_VIEW,
  PERMIT2_ADDRESS,
  LIVE_V4_ENABLED,
  LIVE_UNWRAP_ON_FAIL,
  SWAP_DEADLINE_SECONDS,
  SLIPPAGE_BPS,
  LIVE_MIN_ETH_RESERVE,
  CHAIN_ID,
  NATIVE_ETH,
} from './config.js';
import { normalizeAddress, pruneSeen } from './utils.js';
import { publicClient, createFailoverHttpTransport } from './lib/rpc.js';
import {
  buildV4SwapInput,
  classifyV4Failure,
  findV4Pools,
  pickMostLiquidPool,
  poolIdFromKey,
  quoteV4ExactInputSingle,
  UNIVERSAL_ROUTER_ABI,
} from './execution/v4.js';
import {
  isNativeSentinel,
  looksLikeV4PoolId,
  routeKindFromDexPair,
  minOutWithSlippage,
  wrapDeficit,
  reserveVerdict,
} from './execution/swapMath.js';
import { cacheV4Pool, cachedV4PoolsForMint, evictV4Pool } from './db/v4pools.js';

/**
 * Live executor Robinhood Chain.
 *
 * Prinsip keamanan dana (hasil insiden ETH-terkunci-di-WETH):
 *   1. QUOTE & SIMULATE sebelum side effect on-chain bila memungkinkan.
 *   2. Wrap HANYA selisih kekurangan WETH; native reserve untuk gas tak disentuh.
 *   3. Gagal total → WETH yang baru di-wrap otomatis di-unwrap kembali.
 *   4. Router diverifikasi punya bytecode sebelum satu wei pun bergerak.
 *
 * Jalur swap:
 *   - Uniswap V4 (Universal Router 0x8876…0904, pool ber-quote ETH native) — utama untuk meme RH
 *   - Uniswap V3 (SwapRouter02 0xCaf6…5cb2, pool ber-quote WETH)
 */

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256) returns ()',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// SwapRouter02 exactInputSingle (V3)
const V3_ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams calldata params) payable returns (uint256 amountOut)',
]);

const V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const V3_POOL_ABI = parseAbi([
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
]);

const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration) returns ()',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

const FEE_TIERS = [100, 500, 3000, 10000];
const ZERO = '0x0000000000000000000000000000000000000000';
const PERMIT2_EXPIRY_S = 30 * 24 * 3600; // 30 hari

/**
 * Cooldown per-mint untuk kegagalan eksekusi struktural (quote/sim revert).
 * Mencegah LLM memilih token yang sama berulang-ulang dan memenuhi Telegram
 * dengan kegagalan yang identik (kasus nyata: pool kembar zero-liq, token
 * ber-gate). Kedaluwarsa otomatis setelah 30 menit.
 */
const MINT_FAIL_COOLDOWN_MS = Number(process.env.LIVE_MINT_FAIL_COOLDOWN_MS || 30 * 60_000);
const mintFailCooldown = new Map(); // mint → lastFailMs

/**
 * Cooldown khusus "route tidak ditemukan" — HANYA memblok BELI.
 * Terpisah dari mintFailCooldown: jalur JUAL tidak boleh ikut terblokir
 * (exit posisi harus selalu dicoba ulang).
 */
const ROUTELESS_COOLDOWN_MS = Number(process.env.LIVE_ROUTELESS_COOLDOWN_MS || 30 * 60_000);
const routelessCooldown = new Map(); // mint → lastRoutelessMs

function blockMint(meme) {
  // Buang entri kedaluwarsa agar Map tidak tumbuh tanpa batas di uptime panjang
  pruneSeen(mintFailCooldown, MINT_FAIL_COOLDOWN_MS);
  mintFailCooldown.set(meme, Date.now());
}

function mintCooldownLeft(meme) {
  const last = mintFailCooldown.get(meme);
  if (!last) return 0;
  return Math.max(0, MINT_FAIL_COOLDOWN_MS - (Date.now() - last));
}

function blockRoutelessMint(meme) {
  pruneSeen(routelessCooldown, ROUTELESS_COOLDOWN_MS);
  routelessCooldown.set(meme, Date.now());
}

function routelessCooldownLeft(meme) {
  const last = routelessCooldown.get(meme);
  if (!last) return 0;
  return Math.max(0, ROUTELESS_COOLDOWN_MS - (Date.now() - last));
}

let walletClient = null;
let account = null;
let preflightCache = null;

function ensureWallet() {
  if (walletClient) return { walletClient, account };
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not set — required for live execution.');
  const key = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  account = privateKeyToAccount(key);
  walletClient = createWalletClient({
    account,
    chain: CHAIN,
    transport: createFailoverHttpTransport(),
  });
  return { walletClient, account };
}

export function liveWalletPubkey() {
  if (!PRIVATE_KEY) return null;
  try {
    const { account } = ensureWallet();
    return account.address;
  } catch {
    return null;
  }
}

// ─── Saldo & reserve ──────────────────────────────────────────────────────────

export async function liveWalletBalanceLamports() {
  const { account } = ensureWallet();
  return publicClient.getBalance({ address: account.address });
}

async function wethBalance(address) {
  return publicClient.readContract({
    address: normalizeAddress(WETH_ADDRESS),
    abi: WETH_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

export async function walletBalances() {
  const { account } = ensureWallet();
  const [nativeWei, wethWei] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    wethBalance(account.address),
  ]);
  return { nativeWei, wethWei, totalWei: nativeWei + wethWei };
}

export async function fetchLiveTokenBalance(mint) {
  const { account } = ensureWallet();
  return publicClient.readContract({
    address: normalizeAddress(mint),
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
}

/**
 * Reserve check WETH-aware: dana posisi boleh berasal dari WETH,
 * tapi reserve (gas) harus selalu tersedia sebagai native ETH.
 */
export async function checkLiveReserve(needEth) {
  const { nativeWei, wethWei, totalWei } = await walletBalances();
  const need = parseEther(String(needEth));
  const reserve = parseEther(String(LIVE_MIN_ETH_RESERVE));
  const verdict = reserveVerdict({ nativeWei, wethWei, needWei: need, reserveWei: reserve });
  return {
    balance: verdict.nativeWei, // kompatibel lama (native only)
    wethBalance: verdict.wethWei,
    totalBalance: totalWei,
    sufficient: verdict.sufficient,
    need,
    reserve,
  };
}

// ─── Preflight: kontrak harus BENAR-BENAR ADA di chain ini ────────────────────

async function hasCode(address) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  try {
    const code = await publicClient.getBytecode({ address });
    return Boolean(code && code !== '0x');
  } catch {
    return false;
  }
}

/**
 * Verifikasi semua kontrak eksekusi punya bytecode di Robinhood Chain.
 * Alamat canonical mainnet (mis. SwapRouter02 0x68b3…45fc) = EOA mati di sini.
 * Return { checks, ok, missing }.
 */
export async function preflightLiveExecutor({ force = false } = {}) {
  if (preflightCache && !force) return preflightCache;
  const targets = [
    ['WETH', WETH_ADDRESS],
    ['UNISWAP_ROUTER (V3 SwapRouter02)', UNISWAP_ROUTER],
    ['UNISWAP_V3_FACTORY', UNISWAP_V3_FACTORY],
  ];
  if (LIVE_V4_ENABLED) {
    targets.push(
      ['UNISWAP_UNIVERSAL_ROUTER (V4)', UNISWAP_UNIVERSAL_ROUTER],
      ['UNISWAP_V4_POOL_MANAGER', UNISWAP_V4_POOL_MANAGER],
      ['UNISWAP_V4_QUOTER', UNISWAP_V4_QUOTER],
      ['PERMIT2_ADDRESS', PERMIT2_ADDRESS]
    );
  }
  const checks = [];
  for (const [label, address] of targets) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await hasCode(address);
    checks.push({ label, address, ok });
  }
  const missing = checks.filter((c) => !c.ok);
  preflightCache = { checks, ok: missing.length === 0, missing };
  return preflightCache;
}

async function assertContract(address, label) {
  if (!(await hasCode(address))) {
    throw new Error(
      `${label} (${address}) is NOT a contract on chain ${CHAIN_ID} — refusing to send funds. ` +
        `Check your .env (jangan pakai alamat canonical mainnet).`
    );
  }
}

// ─── Wrap / unwrap WETH ───────────────────────────────────────────────────────

async function wrapWeth(amountWei) {
  const { walletClient } = ensureWallet();
  const hash = await walletClient.writeContract({
    address: normalizeAddress(WETH_ADDRESS),
    abi: WETH_ABI,
    functionName: 'deposit',
    value: BigInt(amountWei),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function unwrapWeth(amountWei) {
  const { walletClient } = ensureWallet();
  const hash = await walletClient.writeContract({
    address: normalizeAddress(WETH_ADDRESS),
    abi: WETH_ABI,
    functionName: 'withdraw',
    args: [BigInt(amountWei)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Pastikan saldo WETH >= amountWei; wrap HANYA deficitnya.
 * Reserve native untuk gas tidak boleh disentuh.
 * Return jumlah yang baru di-wrap (untuk rollback bila perlu).
 */
async function ensureWethCoverage(amountWei, reserveWei) {
  const { account } = ensureWallet();
  const need = BigInt(amountWei);
  const [wethBal, nativeBal] = await Promise.all([
    wethBalance(account.address),
    publicClient.getBalance({ address: account.address }),
  ]);
  const deficit = wrapDeficit(need, wethBal);
  if (deficit <= 0n) return { wrapped: 0n, wethBalance: wethBal };
  const spendableNative = nativeBal > reserveWei ? nativeBal - reserveWei : 0n;
  if (deficit > spendableNative) {
    throw new Error(
      `Insufficient native ETH to wrap ${formatEther(deficit)} WETH while keeping ` +
        `${formatEther(reserveWei)} gas reserve (native: ${formatEther(nativeBal)}, weth: ${formatEther(wethBal)}).`
    );
  }
  await wrapWeth(deficit);
  return { wrapped: deficit, wethBalance: wethBal + deficit };
}

/** Rollback: kembalikan WETH yang baru di-wrap ke native ETH. Best-effort. */
async function rollbackWrap(wrappedWei) {
  if (!LIVE_UNWRAP_ON_FAIL || BigInt(wrappedWei) <= 0n) return;
  try {
    await unwrapWeth(wrappedWei);
    console.log(`[live] rollback unwrap OK — ${formatEther(wrappedWei)} ETH kembali native`);
  } catch (err) {
    console.log(
      `[live] rollback unwrap FAILED: ${err.message} — ` +
        `${formatEther(wrappedWei)} WETH tersisa di wallet (aman, bisa withdraw manual)`
    );
  }
}

// ─── Approvals ────────────────────────────────────────────────────────────────

async function ensureAllowance(token, spender, amount) {
  const { walletClient, account } = ensureWallet();
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, spender],
  });
  if (BigInt(current) >= BigInt(amount)) return;
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, BigInt(amount)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Approval jalur Permit2 (dibutuhkan V4 untuk input ERC20):
 *   1. token.approve(Permit2, max) — sekali per token
 *   2. permit2.approve(token, UniversalRouter, max, expiry) — per (token, spender)
 */
async function ensurePermit2Allowance(token, amount) {
  const { walletClient, account } = ensureWallet();
  const permit2 = normalizeAddress(PERMIT2_ADDRESS);
  const router = normalizeAddress(UNISWAP_UNIVERSAL_ROUTER);

  const erc20Allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, permit2],
  });
  if (BigInt(erc20Allowance) < BigInt(amount)) {
    const hash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [permit2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const [p2Amount, p2Expiration] = await publicClient.readContract({
    address: permit2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [account.address, token, router],
  });
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(p2Amount) < BigInt(amount) || BigInt(p2Expiration) < nowS + 3600n) {
    const hash = await walletClient.writeContract({
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, router, maxUint160, Number(nowS + BigInt(PERMIT2_EXPIRY_S))],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

// ─── Resolusi rute (V4 utama, V3 fallback) ────────────────────────────────────

async function fetchDexPairHint(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const pairs = (res.data?.pairs || []).filter((p) => p.chainId === 'robinhood');
    if (!pairs.length) return null;
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      labels: p.labels || [],
      pairAddress: p.pairAddress || '',
      dexId: p.dexId || '',
      quoteToken: p.quoteToken?.address || '',
      liquidityUsd: Number(p.liquidity?.usd || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Hanya pool TANPA hooks yang dieksekusi lewat Universal Router stock.
 * Pool ber-hook di chain ini (mis. BagsV4Hook dengan biaya 2% & rute router
 * khusus bags) bisa revert di UR resmi — lebih aman dilewati sampai dukungan
 * hook eksplisit ditambahkan.
 */
function filterHooklessPools(pools, meme, seen = new Set()) {
  const out = [];
  for (const entry of pools || []) {
    const hooks = String(entry.poolKey?.hooks || ZERO).toLowerCase();
    if (hooks !== ZERO) {
      if (!seen.has('logged:' + meme)) {
        seen.add('logged:' + meme);
        console.log(`[route] pool V4 ber-hooks (${hooks.slice(0, 10)}…) untuk ${meme.slice(0, 10)}… dilewati — belum didukung`);
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

async function resolveV4Route(meme, { poolIdHint = null, mintCurrencies = null } = {}) {
  // 1) cache dulu — scan log itu mahal
  const cached = filterHooklessPools(cachedV4PoolsForMint(meme), meme);
  if (cached.length) {
    const best = await pickMostLiquidPool(
      publicClient,
      normalizeAddress(UNISWAP_V4_STATE_VIEW),
      cached
    );
    if (best) {
      return { kind: 'v4', poolId: best.poolId, poolKey: best.poolKey, source: 'cache' };
    }
  }

  // 2) scan log Initialize (dengan hint poolId DexScreener bila ada)
  const pm = normalizeAddress(UNISWAP_V4_POOL_MANAGER);
  const found = await findV4Pools(publicClient, pm, {
    poolIdHint,
    currencies: poolIdHint ? null : mintCurrencies,
  });
  const supported = [];
  for (const entry of filterHooklessPools(found, meme)) {
    const { currency0, currency1 } = entry.poolKey;
    const currencies = [currency0.toLowerCase(), currency1.toLowerCase()];
    if (!currencies.includes(meme)) continue;
    const quote = currencies[0] === meme ? currencies[1] : currencies[0];
    if (quote !== ZERO && quote !== normalizeAddress(WETH_ADDRESS)) continue; // hanya ETH/WETH quote
    cacheV4Pool(meme, entry.poolId, entry.poolKey, poolIdHint ? 'dex_poolid' : 'logs_scan');
    supported.push(entry);
  }
  if (!supported.length) return null;
  const best = await pickMostLiquidPool(publicClient, normalizeAddress(UNISWAP_V4_STATE_VIEW), supported);
  if (!best) return null;
  return { kind: 'v4', poolId: best.poolId, poolKey: best.poolKey, source: poolIdHint ? 'dex' : 'logs', liquidity: best.liquidity };
}

async function resolveV3Route(meme, { pairHint = null } = {}) {
  const factory = normalizeAddress(UNISWAP_V3_FACTORY);
  const weth = normalizeAddress(WETH_ADDRESS);

  const tiers = [...FEE_TIERS];
  if (pairHint?.fee != null && !tiers.includes(pairHint.fee)) tiers.unshift(pairHint.fee);
  if (pairHint?.fee != null) tiers.sort((a, b) => (a === pairHint.fee ? -1 : b === pairHint.fee ? 1 : 0));

  for (const fee of tiers) {
    let pool;
    try {
      // eslint-disable-next-line no-await-in-loop
      pool = await publicClient.readContract({
        address: factory,
        abi: V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [meme, weth, fee],
      });
    } catch {
      continue;
    }
    if (!pool || normalizeAddress(pool) === ZERO) continue;
    let liquidity = 0n;
    try {
      // eslint-disable-next-line no-await-in-loop
      liquidity = await publicClient.readContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: 'liquidity',
      });
    } catch {
      /* pool aneh — skip */
    }
    if (liquidity > 0n) {
      return { kind: 'v3', fee, pool: normalizeAddress(pool), liquidity, source: pairHint ? 'dex+factory' : 'factory' };
    }
  }
  return null;
}

/**
 * Tentukan venue terbaik untuk token meme:
 *   1. hint DexScreener (labels v4 + 32-byte poolId, atau v3 + pair contract)
 *   2. cache pool V4
 *   3. scan factory V3 (cepat, 4 eth_call)
 *   4. scan log Initialize V4 (mahal, ter-cache setelahnya)
 */
export async function resolveSwapRoute(meme, dexPair = null) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(meme)) throw new Error(`Invalid meme token address: ${meme}`);
  const hint = dexPair || (await fetchDexPairHint(meme));
  const hintKind = routeKindFromDexPair(hint);

  if (LIVE_V4_ENABLED && (hintKind === 'v4' || looksLikeV4PoolId(hint?.pairAddress))) {
    const route = await resolveV4Route(meme, { poolIdHint: hint?.pairAddress });
    if (route) return route;
    console.log('[route] dex v4 hint tapi pool tidak ketemu on-chain — fallback');
  }

  if (hintKind === 'v3' && hint?.pairAddress) {
    let fee = null;
    try {
      fee = Number(
        await publicClient.readContract({
          address: normalizeAddress(hint.pairAddress),
          abi: V3_POOL_ABI,
          functionName: 'fee',
        })
      );
    } catch {
      /* bukan pool V3 valid */
    }
    const route = await resolveV3Route(meme, { pairHint: fee != null ? { fee } : null });
    if (route) return route;
  }

  if (LIVE_V4_ENABLED) {
    const cached = await resolveV4Route(meme, {});
    if (cached) return cached;
  }

  const v3 = await resolveV3Route(meme, {});
  if (v3) return v3;

  if (LIVE_V4_ENABLED) {
    // scan semua pool yang memuat meme (quote ETH native maupun WETH)
    const v4 = await resolveV4Route(meme, { mintCurrencies: [meme, null] });
    if (v4) return v4;
  }

  return null;
}

// ─── Eksekusi V4 (Universal Router, native ETH didukung) ──────────────────────

async function executeSwapV4({ poolKey, amountIn, isNativeIn, memeToken, deadline }) {
  const { walletClient, account } = ensureWallet();
  const ur = normalizeAddress(UNISWAP_UNIVERSAL_ROUTER);
  const amountInBI = BigInt(amountIn);

  await assertContract(ur, 'UNISWAP_UNIVERSAL_ROUTER');
  await assertContract(normalizeAddress(UNISWAP_V4_POOL_MANAGER), 'UNISWAP_V4_POOL_MANAGER');
  await assertContract(normalizeAddress(UNISWAP_V4_QUOTER), 'UNISWAP_V4_QUOTER');

  const c0 = poolKey.currency0.toLowerCase();
  const c1 = poolKey.currency1.toLowerCase();
  const weth = normalizeAddress(WETH_ADDRESS);
  const meme = normalizeAddress(memeToken);

  // Currency input: buy = quote pool (ETH native kalau ada, kalau tidak WETH);
  // sell = token meme. Wajib salah satu currency pool.
  const currencyIn = isNativeIn ? (c0 === ZERO || c1 === ZERO ? ZERO : weth) : meme;
  if (c0 !== currencyIn && c1 !== currencyIn) {
    throw new Error(
      `Pool V4 tidak memuat currency input ${currencyIn} (c0=${c0}, c1=${c1}) — quote currency tidak didukung.`
    );
  }
  const zeroForOne = c0 === currencyIn;
  const inputIsErc20 = currencyIn !== ZERO;
  const currencyInAddress = currencyIn === ZERO ? ZERO : normalizeAddress(currencyIn);
  const poolId = poolIdFromKey(poolKey);

  /** Gagal di tahap quote = pool ini tidak bisa dipakai → evict cache + cooldown mint. */
  function poisonPool(err, prefix) {
    const cls = classifyV4Failure(err);
    evictV4Pool(poolId);
    blockMint(normalizeAddress(memeToken));
    throw new Error(`${prefix}: ${cls.summary} (pool ${poolId.slice(0, 12)}… dibuang dari cache)`);
  }

  // 1) QUOTE MURNI DULU — nol side effect on-chain. Kalau pool busuk
  //    (tidak ter-inisialisasi di PM official / zero-liq / venue lain),
  //    berhenti di sini sebelum satu wei di-wrap atau satu approval terkirim.
  let quote;
  try {
    quote = await quoteV4ExactInputSingle(
      publicClient,
      normalizeAddress(UNISWAP_V4_QUOTER),
      { poolKey, zeroForOne, exactAmount: amountInBI }
    );
  } catch (err) {
    poisonPool(err, 'V4 quote gagal');
  }
  if (quote.amountOut <= 0n) {
    poisonPool(new Error('quote amountOut = 0'), 'V4 pool tanpa output');
  }
  const minOut = minOutWithSlippage(quote.amountOut, SLIPPAGE_BPS);

  const { commands, inputs } = buildV4SwapInput({
    poolKey,
    zeroForOne,
    amountIn: amountInBI,
    minOut,
  });

  let wrapped = 0n;
  try {
    // 2) Side effect HANYA setelah quote valid: wrap deficit + approval.
    if (isNativeIn && currencyIn === weth) {
      // pool ber-quote WETH → wrap deficit, settle via WETH (ERC20 path)
      const cov = await ensureWethCoverage(amountInBI, parseEther(String(LIVE_MIN_ETH_RESERVE)));
      wrapped = cov.wrapped;
    }
    if (inputIsErc20) {
      // input ERC20 (WETH hasil wrap atau token meme saat jual) → butuh jalur Permit2
      await assertContract(normalizeAddress(PERMIT2_ADDRESS), 'PERMIT2_ADDRESS');
      await ensurePermit2Allowance(currencyInAddress, amountInBI);
    }

    const value = currencyIn === ZERO ? amountInBI : 0n;

    // 3) SIMULASI penuh sebelum satu wei bergerak.
    let request;
    try {
      ({ request } = await publicClient.simulateContract({
        address: ur,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [commands, inputs, BigInt(deadline)],
        value,
        account: account.address,
      }));
    } catch (err) {
      const cls = classifyV4Failure(err);
      // revert tanpa reason pada state yang allowance/saldonya sudah benar →
      // hampir pasti token punya gate transfer di pool ini → cooldown mint.
      if (cls.raw === 'empty') blockMint(normalizeAddress(memeToken));
      throw new Error(`V4 simulate gagal: ${cls.summary} — dana TIDAK bergerak`);
    }

    const beforeNative = await publicClient.getBalance({ address: account.address });
    const beforeToken = !isNativeIn
      ? 0n
      : await fetchLiveTokenBalance(memeToken);

    const hash = walletClient.writeContract({ ...request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    let received;
    if (isNativeIn) {
      const afterToken = await fetchLiveTokenBalance(memeToken);
      received = afterToken - beforeToken;
      if (received <= 0n) received = quote.amountOut;
    } else {
      const afterNative = await publicClient.getBalance({ address: account.address });
      const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || 0);
      received = afterNative - beforeNative + gasCost + value;
      if (received <= 0n) received = quote.amountOut;
    }

    return {
      signature: hash,
      outputAmount: received.toString(),
      minOut: minOut.toString(),
      quotedOut: quote.amountOut.toString(),
      route: 'v4',
      poolId: poolIdFromKey(poolKey),
      chainId: CHAIN_ID,
      status: receipt.status,
    };
  } catch (err) {
    await rollbackWrap(wrapped);
    throw err;
  }
}

// ─── Eksekusi V3 (SwapRouter02, wrap WETH) ────────────────────────────────────

async function executeSwapV3({ route, amountIn, isNativeIn, memeToken, deadline }) {
  const { walletClient, account } = ensureWallet();
  const router = normalizeAddress(UNISWAP_ROUTER);
  const weth = normalizeAddress(WETH_ADDRESS);
  const amountInBI = BigInt(amountIn);

  await assertContract(router, 'UNISWAP_ROUTER (V3 SwapRouter02)');

  const tokenIn = isNativeIn ? weth : normalizeAddress(memeToken);
  const tokenOut = isNativeIn ? normalizeAddress(memeToken) : weth;

  let wrapped = 0n;
  try {
    if (isNativeIn) {
      const cov = await ensureWethCoverage(amountInBI, parseEther(String(LIVE_MIN_ETH_RESERVE)));
      wrapped = cov.wrapped;
    }
    await ensureAllowance(tokenIn, router, amountInBI);

    // Dengan saldo+allowance yang sudah nyata, simulasi sekarang akurat.
    const baseParams = {
      tokenIn,
      tokenOut,
      fee: route.fee,
      recipient: account.address,
      amountIn: amountInBI,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };
    let sim;
    try {
      sim = await publicClient.simulateContract({
        address: router,
        abi: V3_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [baseParams],
        account: account.address,
      });
    } catch (err) {
      const cls = classifyV4Failure(err);
      throw new Error(`V3 quote/sim gagal: ${cls.summary} — dana TIDAK bergerak`);
    }
    const quotedOut = BigInt(sim.result);
    if (quotedOut <= 0n) throw new Error('v3 simulate returned 0 out');
    const minOut = minOutWithSlippage(quotedOut, SLIPPAGE_BPS);

    const finalParams = { ...baseParams, amountOutMinimum: minOut };
    let request;
    try {
      ({ request } = await publicClient.simulateContract({
        address: router,
        abi: V3_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [finalParams],
        account: account.address,
      }));
    } catch (err) {
      const cls = classifyV4Failure(err);
      throw new Error(`V3 simulate(final) gagal: ${cls.summary} — dana TIDAK bergerak`);
    }

    const beforeToken = isNativeIn ? await fetchLiveTokenBalance(memeToken) : 0n;
    const beforeWeth = !isNativeIn ? await wethBalance(account.address) : 0n;

    const hash = walletClient.writeContract({ ...request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    let received;
    if (isNativeIn) {
      const afterToken = await fetchLiveTokenBalance(memeToken);
      received = afterToken - beforeToken;
      if (received <= 0n) received = quotedOut;
    } else {
      const afterWeth = await wethBalance(account.address);
      const wethGained = afterWeth - beforeWeth;
      received = wethGained > 0n ? wethGained : quotedOut;
      // jual → keluar sebagai WETH; langsung unwrap ke native ETH.
      // Swap SUDAH sukses di sini — jangan mask kegagalan unwrap sebagai
      // kegagalan swap (posisi monitor bisa salah menyangka sell gagal).
      if (wethGained > 0n) {
        try {
          await unwrapWeth(wethGained);
        } catch (unwrapErr) {
          console.log(`[live] v3 sell unwrap gagal (WETH aman di wallet): ${unwrapErr.message}`);
        }
      }
    }

    return {
      signature: hash,
      outputAmount: received.toString(),
      minOut: minOut.toString(),
      quotedOut: quotedOut.toString(),
      route: 'v3',
      fee: route.fee,
      pool: route.pool,
      chainId: CHAIN_ID,
      status: receipt.status,
    };
  } catch (err) {
    await rollbackWrap(wrapped);
    throw err;
  }
}

/** Revoke approval ERC20 ke spender (berguna membersihkan approve ke alamat mati). */
export async function revokeApproval(token, spender) {
  const { walletClient, account } = ensureWallet();
  const t = normalizeAddress(token);
  const s = normalizeAddress(spender);
  const current = await publicClient.readContract({
    address: t,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, s],
  });
  if (BigInt(current) === 0n) return { alreadyZero: true, allowance: '0', hash: null };
  const hash = await walletClient.writeContract({
    address: t,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [s, 0n],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { alreadyZero: false, allowance: current.toString(), hash };
}

// ─── API utama (nama dipertahankan dari Charon) ───────────────────────────────

/**
 * Execute a swap: inputMint → outputMint untuk `amount` raw unit input.
 * Native ETH sentinel = 0x000…0000 / null.
 * Otomatis memilih venue terbaik (V4 native-ETH, V4 WETH, atau V3).
 */
export async function executeJupiterSwap({ inputMint, outputMint, amount, dexPair = null, route = null }) {
  // Name kept similar to Charon (it was Jupiter on Solana); this is Uniswap on RH Chain.
  ensureWallet();
  const amountIn = BigInt(amount);
  const isNativeIn = isNativeSentinel(inputMint);
  const isNativeOut = isNativeSentinel(outputMint);
  if (isNativeIn === isNativeOut) {
    throw new Error(`Swap harus melibatkan tepat satu sisi native ETH (in=${inputMint}, out=${outputMint})`);
  }
  const memeToken = normalizeAddress(isNativeIn ? outputMint : inputMint);
  const coolLeft = mintCooldownLeft(memeToken);
  if (coolLeft > 0) {
    throw new Error(
      `${memeToken.slice(0, 12)}… sedang cooldown eksekusi (${Math.ceil(coolLeft / 60000)} menit lagi) — ` +
        `gagal struktural sebelumnya; dilewati demi keamanan`
    );
  }
  if (isNativeIn) {
    const rlLeft = routelessCooldownLeft(memeToken);
    if (rlLeft > 0) {
      throw new Error(
        `${memeToken.slice(0, 12)}… tidak punya swap route (${Math.ceil(rlLeft / 60000)} menit cooldown lagi) — ` +
          `pool V3/V4 tidak ditemukan; dilewati tanpa rescan`
      );
    }
  }
  const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS;

  const resolved = route || (await resolveSwapRoute(memeToken, dexPair));
  if (!resolved) {
    // Cooldown HANYA untuk beli — jangan rescan ~5 juta blok untuk token tanpa
    // route setiap siklus (kasus #48/#52: VRAX/CC dipindai berulang-ulang).
    // Untuk JUAL sengaja tidak di-cooldown: exit posisi harus terus dicoba.
    if (isNativeIn) blockRoutelessMint(memeToken);
    const venue = String(dexPair?.dexId || '').toLowerCase();
    const venueNote =
      venue && !venue.includes('uniswap')
        ? ` Pair DexScreener ada di venue "${dexPair.dexId}" — di luar Uniswap, eksekutor ini tidak mendukungnya.`
        : '';
    throw new Error(
      `No swap route for ${memeToken} — tidak ada pool V3 (WETH) maupun V4 (ETH) dengan likuiditas. ` +
        `(${isNativeIn ? 'mint cooldown 30 menit; ' : ''}jika terus terjadi: pool mungkin ber-quote non-ETH/WETH,` +
        ` pool sudah ada sebelum blok V4_DEPLOY_BLOCK, atau RPC menolak rentang log — lihat baris [route] di log).${venueNote}`
    );
  }

  console.log(
    `[live] route ${resolved.kind.toUpperCase()} via ${resolved.source} ` +
      (resolved.kind === 'v4' ? `poolId ${resolved.poolId?.slice(0, 12)}…` : `fee ${resolved.fee} pool ${resolved.pool?.slice(0, 12)}…`)
  );

  const params = {
    amountIn,
    isNativeIn,
    memeToken,
    deadline,
  };
  const swap =
    resolved.kind === 'v4'
      ? await executeSwapV4({ ...params, poolKey: resolved.poolKey })
      : await executeSwapV3({ ...params, route: resolved });

  swap.sizeEth = Number(formatEther(isNativeIn ? amountIn : 0n));
  return swap;
}
