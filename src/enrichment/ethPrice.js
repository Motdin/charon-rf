import axios from 'axios';
import { WETH_ADDRESS } from '../config.js';
import { now, toNumber } from '../utils.js';

/**
 * Harga ETH/USD untuk konversi ukuran posisi → estimasi jumlah token.
 *
 * Sebelumnya di-hardcode `2500` di dua tempat (db/positions.js). Angka mati itu
 * dipakai sebagai FALLBACK `token_amount_raw` pada posisi live ketika
 * `swap.outputAmount` kosong — artinya angka yang salah bisa menjadi jumlah
 * yang dipakai saat MENJUAL. Sekarang harganya diambil dari pasar.
 *
 * Getter-nya sengaja SINKRON supaya createDryRunPosition/createLivePosition
 * (fungsi DB sinkron) tidak perlu diubah jadi async. Nilai disegarkan oleh
 * poller latar; selama belum ada data, fallback yang bisa dikonfigurasi dipakai
 * dan dicatat di log.
 */

const FALLBACK_USD = Number(process.env.ETH_USD_FALLBACK || 2500);
const REFRESH_MS = Number(process.env.ETH_USD_REFRESH_MS || 5 * 60_000);
const STALE_MS = Number(process.env.ETH_USD_STALE_MS || 30 * 60_000);

const state = { usd: 0, at: 0, source: 'none', warned: false };

export function ethPriceStatus() {
  return {
    usd: state.usd || FALLBACK_USD,
    at: state.at,
    source: state.usd ? state.source : 'fallback',
    ageMs: state.at ? now() - state.at : null,
    fallbackUsd: FALLBACK_USD,
    fresh: Boolean(state.usd) && now() - state.at < STALE_MS,
  };
}

/** Sinkron: harga terakhir yang diketahui, atau fallback. */
export function ethUsdPrice() {
  if (state.usd > 0 && now() - state.at < STALE_MS) return state.usd;
  if (!state.warned) {
    state.warned = true;
    console.log(
      `[ethprice] belum ada harga ETH segar — pakai fallback $${FALLBACK_USD} (set ETH_USD_FALLBACK bila perlu)`
    );
  }
  return state.usd > 0 ? state.usd : FALLBACK_USD;
}

/** Ambil harga WETH dari DexScreener (pair paling likuid di chain ini). */
export async function refreshEthUsd() {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${WETH_ADDRESS}`, {
      timeout: 10_000,
      headers: { accept: 'application/json' },
    });
    const pairs = Array.isArray(res.data?.pairs) ? res.data.pairs : [];
    // Pair dengan likuiditas terbesar = harga paling dipercaya.
    let best = null;
    for (const p of pairs) {
      const price = toNumber(p.priceUsd);
      const liq = toNumber(p.liquidity?.usd);
      if (price > 0 && (!best || liq > best.liq)) best = { price, liq };
    }
    if (best && best.price > 0) {
      state.usd = best.price;
      state.at = now();
      state.source = 'dexscreener';
      state.warned = false;
      return state.usd;
    }
  } catch (err) {
    console.log(`[ethprice] refresh gagal: ${String(err.message).slice(0, 120)}`);
  }
  return null;
}

let timer = null;
export function startEthPricePolling(intervalMs = REFRESH_MS) {
  if (timer) return;
  const loop = async () => {
    const usd = await refreshEthUsd();
    if (usd) console.log(`[ethprice] ETH ≈ $${usd.toFixed(2)} (dexscreener)`);
    timer = setTimeout(loop, intervalMs);
    if (timer.unref) timer.unref();
  };
  loop();
}
