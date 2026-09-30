#!/usr/bin/env node
/**
 * Probe rute swap untuk sebuah token — READ-ONLY, tidak mengirim transaksi
 * dan tidak butuh PRIVATE_KEY.
 *
 *   node scripts/probe-route.js <mint> [amountEth]
 *
 * Contoh:
 *   node scripts/probe-route.js 0x55fdc2cebae7d2f0e014fb910e37160ef17b4d94 0.001
 *
 * Yang diperiksa:
 *   1. preflight kontrak router
 *   2. rute BELI (gate likuiditas normal) dan rute JUAL (gate dilonggarkan)
 *   3. likuiditas tick-aktif — DILAPORKAN, bukan dipakai memveto
 *   4. QUOTE BULAK-BALIK: beli X ETH → Y token → jual Y token → Z ETH.
 *      Z jauh di bawah X (atau jual revert padahal beli sukses) = honeypot
 *      atau likuiditas satu arah. Inilah tes yang membedakan
 *      "pool benar-benar kering" dari "bot gagal menemukan pool".
 */
import '../src/config.js';
import { parseEther, formatEther, formatUnits } from 'viem';
import { resolveSwapRoute, preflightLiveExecutor } from '../src/liveExecutor.js';
import { quoteV4ExactInputSingle } from '../src/execution/v4.js';
import { publicClient } from '../src/lib/rpc.js';
import {
  UNISWAP_V4_QUOTER,
  UNISWAP_V4_STATE_VIEW,
  WETH_ADDRESS,
} from '../src/config.js';
import { V4_STATE_VIEW_ABI } from '../src/execution/v4.js';
import { normalizeAddress } from '../src/utils.js';

const ZERO = '0x0000000000000000000000000000000000000000';

function describeRoute(label, route) {
  if (!route) {
    console.log(`  ${label}: ✗ tidak ada rute`);
    return;
  }
  console.log(`  ${label}: ${route.kind.toUpperCase()} via ${route.source}`);
  if (route.kind === 'v4') {
    const k = route.poolKey;
    console.log(`      poolId  ${route.poolId}`);
    console.log(`      poolKey c0=${k.currency0} c1=${k.currency1} fee=${k.fee} ts=${k.tickSpacing} hooks=${k.hooks}`);
  } else {
    console.log(`      pool ${route.pool} (fee ${route.fee}, liquidity ${route.liquidity})`);
  }
}

async function readLiquidity(poolId) {
  try {
    return await publicClient.readContract({
      address: normalizeAddress(UNISWAP_V4_STATE_VIEW),
      abi: V4_STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId],
    });
  } catch (err) {
    return { error: err.shortMessage || err.message };
  }
}

async function main() {
  const mint = process.argv[2]?.toLowerCase();
  const amountEth = Number(process.argv[3] || '0.001');
  if (!/^0x[0-9a-f]{40}$/.test(mint || '')) {
    console.error('Usage: node scripts/probe-route.js <mint 0x…40hex> [amountEth]');
    process.exit(1);
  }

  console.log('── preflight kontrak ──');
  const pf = await preflightLiveExecutor({ force: true });
  for (const c of pf.checks) console.log(`  ${c.ok ? '✓' : '✗ MISSING'} ${c.label} ${c.address}`);
  if (!pf.ok) console.log('  ⚠️  ada kontrak hilang — mode live akan menolak jalan');

  console.log(`\n── resolusi rute untuk ${mint} ──`);
  let buyRoute = null;
  let sellRoute = null;
  try {
    buyRoute = await resolveSwapRoute(mint);
  } catch (err) {
    console.log(`  ✗ resolver (beli) error: ${err.message}`);
  }
  try {
    // Gate likuiditas dilonggarkan — persis seperti jalur exit sekarang.
    sellRoute = await resolveSwapRoute(mint, null, { allowZeroLiquidity: true });
  } catch (err) {
    console.log(`  ✗ resolver (jual) error: ${err.message}`);
  }
  describeRoute('rute BELI ', buyRoute);
  describeRoute('rute JUAL ', sellRoute);

  if (!buyRoute && !sellRoute) {
    console.log('\n✗ Tidak ada pool V3 (WETH) maupun V4 (ETH/WETH) untuk token ini di PoolManager/Factory resmi.');
    console.log('  Kemungkinan: LP sudah ditarik sepenuhnya (rug), pool di venue lain,');
    console.log('  atau pool ber-hooks (belum didukung eksekutor).');
    process.exit(1);
  }
  if (!buyRoute && sellRoute) {
    console.log('\n  ℹ️  Rute jual ADA tapi rute beli tidak — likuiditas tick-aktif 0.');
    console.log('     Pool masih bisa di-swap dengan melintasi tick; exit tetap layak dicoba.');
  }

  const route = sellRoute || buyRoute;
  if (route.kind !== 'v4') {
    console.log('\n  (V3 — quote dihitung saat eksekusi via simulasi on-chain, butuh saldo & allowance nyata)');
    console.log('\nSelesai. Tidak ada transaksi yang dikirim.');
    return;
  }

  const k = route.poolKey;
  const weth = normalizeAddress(WETH_ADDRESS);
  const quoteIsNative = k.currency0.toLowerCase() === ZERO || k.currency1.toLowerCase() === ZERO;

  const liq = await readLiquidity(route.poolId);
  if (liq && typeof liq === 'object' && liq.error) {
    console.log(`\n  liquidity (StateView): gagal baca (${liq.error}) — pool kemungkinan bukan milik PoolManager ini`);
  } else {
    console.log(`\n  liquidity tick-aktif (StateView): ${liq}`);
    if (liq === 0n) {
      console.log('    ⚠️  0 = tidak ada LP pada tick AKTIF. Ini BUKAN bukti pool kosong:');
      console.log('        harga bisa saja keluar dari range LP. Quote di bawah yang menentukan.');
    }
  }

  if (!quoteIsNative && k.currency0.toLowerCase() !== weth && k.currency1.toLowerCase() !== weth) {
    console.log('  ✗ quote currency bukan ETH/WETH — tidak didukung eksekutor bot.');
    process.exit(1);
  }

  const amountIn = parseEther(String(amountEth));
  const zeroForOneBuy = quoteIsNative
    ? k.currency0.toLowerCase() === ZERO
    : k.currency0.toLowerCase() === weth;

  // ── Quote BELI ──
  let bought = null;
  try {
    const q = await quoteV4ExactInputSingle(publicClient, normalizeAddress(UNISWAP_V4_QUOTER), {
      poolKey: k,
      zeroForOne: zeroForOneBuy,
      exactAmount: amountIn,
    });
    bought = q.amountOut;
    console.log(`\n  QUOTE BELI  ${amountEth} ${quoteIsNative ? 'ETH' : 'WETH'} → ~${formatUnits(bought, 18)} token (raw ${bought})`);
  } catch (err) {
    console.log(`\n  ✗ quote BELI gagal: ${err.shortMessage || err.message}`);
  }

  // ── Quote JUAL (arah sebaliknya) — inti diagnosis "tidak bisa dijual" ──
  const sellAmount = bought && bought > 0n ? bought : parseEther('1000');
  let back = null;
  try {
    const q = await quoteV4ExactInputSingle(publicClient, normalizeAddress(UNISWAP_V4_QUOTER), {
      poolKey: k,
      zeroForOne: !zeroForOneBuy,
      exactAmount: sellAmount,
    });
    back = q.amountOut;
    console.log(`  QUOTE JUAL  ${formatUnits(sellAmount, 18)} token → ~${formatEther(back)} ${quoteIsNative ? 'ETH' : 'WETH'} (raw ${back})`);
  } catch (err) {
    console.log(`  ✗ quote JUAL gagal: ${err.shortMessage || err.message}`);
  }

  // ── Verdict ──
  console.log('\n── kesimpulan ──');
  if (bought && back) {
    const ratio = Number(formatEther(back)) / amountEth;
    console.log(`  Bulak-balik: ${amountEth} → ${formatEther(back)} ETH (${(ratio * 100).toFixed(1)}% kembali)`);
    if (ratio < 0.5) {
      console.log('  🔴 Kehilangan >50% dalam sekali bulak-balik — pajak sangat tinggi atau likuiditas nyaris habis.');
    } else if (ratio < 0.9) {
      console.log('  🟡 Selip/pajak besar, tapi token MASIH BISA DIJUAL.');
    } else {
      console.log('  🟢 Pool sehat dua arah — token bisa dijual.');
    }
  } else if (bought && !back) {
    console.log('  🔴 BELI bisa di-quote tapi JUAL revert → ciri kuat HONEYPOT (transfer/jual di-gate).');
    console.log('     Jalankan juga: /security <mint> di Telegram untuk konfirmasi.');
  } else if (!bought && back) {
    console.log('  🟡 JUAL bisa di-quote, BELI tidak — exit tetap mungkin. Coba jual.');
  } else {
    console.log('  🔴 Dua arah gagal di-quote → pool ini tidak bisa di-swap di PoolManager resmi');
    console.log('     (LP ditarik habis / pool hidup di venue lain).');
  }

  console.log('\nSelesai. Tidak ada transaksi yang dikirim.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
