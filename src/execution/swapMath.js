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

/**
 * Ambil `percent`% dari jumlah raw uint256, seluruhnya dalam BigInt.
 *
 * JANGAN pernah memakai Number() untuk ini. Saldo memecoin 18-desimal rutin
 * melewati 2^53, dan begitu nilainya >= 1e21 `String(number)` berubah jadi
 * notasi eksponensial ("2.5e+24") yang membuat BigInt() melempar di jalur jual.
 * Itu bug nyata: partial TP gagal diam-diam dan tidak pernah dicoba ulang.
 *
 * Pembulatan ke bawah (floor) — jangan pernah mencoba menjual lebih dari yang dimiliki.
 */
export function portionOfRawAmount(rawAmount, percent) {
  const raw = BigInt(rawAmount);
  if (raw <= 0n) return 0n;
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0) return 0n;
  if (pct >= 100) return raw;
  // basis 1e6 agar persen pecahan (mis. 12,5%) tetap akurat
  const scaled = BigInt(Math.round(pct * 10_000));
  return (raw * scaled) / 1_000_000n;
}

/**
 * Konversi jumlah token (float, hasil estimasi) ke string raw uint256.
 *
 * BigInt(Number) menerima Number integral berapa pun besarnya tanpa melewati
 * String(), jadi bebas dari notasi eksponensial. Presisi float tetap terbatas —
 * ini memang hanya estimasi — tapi hasilnya selalu string desimal yang valid
 * untuk BigInt() di hilir.
 */
export function toRawAmountString(amount, decimals = 18) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const scaled = Math.round(n * 10 ** Number(decimals));
  if (!Number.isFinite(scaled)) return '0';
  return BigInt(scaled).toString();
}
