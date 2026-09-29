/**
 * Pure helpers untuk routing & matematika swap — tanpa IO, mudah di-smoke-test.
 */

// Native ETH direpresentasikan sebagai address(0) di V4 / sentinel di config.
export const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';

export function isNativeSentinel(addr) {
  if (!addr) return true;
  return String(addr).toLowerCase() === NATIVE_ZERO;
}

/** DexScreener "pairAddress" untuk pool V4 adalah poolId 32-byte (bukan contract). */
export function looksLikeV4PoolId(pairAddress) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(pairAddress || ''));
}

export function looksLikeContractAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(addr || ''));
}

/**
 * Tebak venue dari pair DexScreener.
 * Return: 'v4' | 'v3' | null (null = tidak dikenal / perlu deteksi on-chain).
 */
export function routeKindFromDexPair(pair) {
  if (!pair) return null;
  const labels = Array.isArray(pair.labels) ? pair.labels.map((l) => String(l).toLowerCase()) : [];
  if (labels.includes('v4') || looksLikeV4PoolId(pair.pairAddress)) return 'v4';
  if (labels.includes('v3')) return 'v3';
  // dexId "uniswap" tanpa label di chain ini hampir selalu V4/V3; biarkan null
  // supaya resolver jatuh ke deteksi on-chain (factory scan + Initialize logs).
  return null;
}

/** amountOut minimum dengan slippage (basis points). */
export function minOutWithSlippage(quotedOut, slippageBps) {
  const out = BigInt(quotedOut);
  const bps = BigInt(Math.max(0, Math.min(10_000, Number(slippageBps) || 0)));
  return (out * (10_000n - bps)) / 10_000n;
}

/**
 * Berapa ETH yang perlu di-wrap agar saldo WETH >= amountIn.
 * Return 0n jika saldo WETH sudah cukup.
 */
export function wrapDeficit(amountInWei, wethBalanceWei) {
  const need = BigInt(amountInWei);
  const have = BigInt(wethBalanceWei);
  return have >= need ? 0n : need - have;
}

/**
 * Cek kecukupan dana untuk 1 posisi.
 * Syarat:
 *   1. total (native + WETH) >= need + reserve   → dana beli memang ada
 *   2. native >= reserve                          → sisa gas native tidak tergerus
 * Reserve SELALU dihitung dalam native ETH (untuk gas), bukan WETH.
 */
export function reserveVerdict({ nativeWei, wethWei, needWei, reserveWei }) {
  const native = BigInt(nativeWei);
  const weth = BigInt(wethWei);
  const need = BigInt(needWei);
  const reserve = BigInt(reserveWei);
  const total = native + weth;
  const totalOk = total >= need + reserve;
  const gasOk = native >= reserve;
  return {
    nativeWei: native,
    wethWei: weth,
    totalWei: total,
    needWei: need,
    reserveWei: reserve,
    sufficient: totalOk && gasOk,
    totalOk,
    gasOk,
  };
}
