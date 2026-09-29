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
 * Menampilkan: venue (V4/V3), pool/poolId, quote V4 untuk beli & jual,
 * dan hasil preflight kontrak — jalankan sebelum mengaktifkan mode live.
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
  let route;
  try {
    route = await resolveSwapRoute(mint);
  } catch (err) {
    console.log(`  ✗ resolver error: ${err.message}`);
    process.exit(1);
  }
  if (!route) {
    console.log('  ✗ tidak ada rute — pool V3 (WETH) maupun V4 (ETH) tidak ditemukan untuk token ini.');
    process.exit(1);
  }
  console.log(`  venue  : ${route.kind.toUpperCase()} (via ${route.source})`);
  if (route.kind === 'v4') {
    const k = route.poolKey;
    console.log(`  poolId : ${route.poolId}`);
    console.log(`  poolKey: c0=${k.currency0} c1=${k.currency1} fee=${k.fee} tickSpacing=${k.tickSpacing} hooks=${k.hooks}`);
  } else {
    console.log(`  pool   : ${route.pool} (fee ${route.fee}, liquidity ${route.liquidity})`);
  }

  if (route.kind === 'v4') {
    const k = route.poolKey;
    const amountIn = parseEther(String(amountEth));
    const weth = normalizeAddress(WETH_ADDRESS);
    const quoteIsNative = k.currency0.toLowerCase() === ZERO || k.currency1.toLowerCase() === ZERO;

    let liq = null;
    try {
      liq = await publicClient.readContract({
        address: normalizeAddress(UNISWAP_V4_STATE_VIEW),
        abi: V4_STATE_VIEW_ABI,
        functionName: 'getLiquidity',
        args: [route.poolId],
      });
      console.log(`  liquidity (StateView): ${liq}`);
    } catch (err) {
      console.log(`  liquidity: gagal baca (${err.shortMessage || err.message})`);
    }

    if (!quoteIsNative) {
      console.log('  ⚠️  pool ber-quote bukan ETH native (kemungkinan WETH) — buy akan wrap dulu via jalur ERC20/Permit2.');
      if (k.currency0.toLowerCase() !== weth && k.currency1.toLowerCase() !== weth) {
        console.log('  ✗ quote currency tidak didukung untuk eksekusi bot.');
        process.exit(1);
      }
    }

    // Quote beli: ETH/WETH → token
    const zeroForOneBuy = quoteIsNative
      ? k.currency0.toLowerCase() === ZERO
      : k.currency0.toLowerCase() === weth;
    try {
      const q = await quoteV4ExactInputSingle(publicClient, normalizeAddress(UNISWAP_V4_QUOTER), {
        poolKey: k,
        zeroForOne: zeroForOneBuy,
        exactAmount: amountIn,
      });
      console.log(`\n  QUOTE BUY  ${amountEth} ${quoteIsNative ? 'ETH' : 'WETH'} → ~${formatUnits(q.amountOut, 18)} token (raw ${q.amountOut})`);
    } catch (err) {
      console.log(`\n  ✗ quote BUY gagal: ${err.shortMessage || err.message}`);
    }
  } else {
    console.log('  (V3 — quote dihitung saat eksekusi via simulasi on-chain)');
  }

  console.log('\nSelesai. Tidak ada transaksi yang dikirim.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
