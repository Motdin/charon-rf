import {
  openPositions,
  positionById,
  closePosition,
  updateHighWater,
  markPartialTpDone,
  updateTokenAmount,
  recordTrade,
  tradingMode,
  createAdoptedPosition,
  hasOpenPositionForMint,
  openPositionIdForMint,
} from '../db/positions.js';
import { strategyById, activeStrategy, numSetting } from '../db/settings.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { enrichToken } from '../enrichment/index.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { fetchDexPair, trending } from '../signals/dexscreener.js';
import { executeLiveSell } from './router.js';
import { fetchLiveTokenBalance, resolveSwapRoute } from '../liveExecutor.js';
import { sendPositionExit, sendTelegram } from '../telegram/send.js';
import { now, toNumber, firstPositiveNumber, fmtPct } from '../utils.js';
import { startBlockWatcher } from '../lib/blockWatcher.js';

/**
 * Position manager — Charon-style TP / SL / trailing / partial TP / max hold.
 */

const sellInProgress = new Set();

/**
 * Refresh a position's PnL and decide exit.
 */
export async function refreshPosition(position, { autoExit = true } = {}) {
  const mint = position.mint;
  const dex = trending.get(mint) || (await fetchDexPair(mint));

  const price = firstPositiveNumber(toNumber(dex?.priceUsd), position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(toNumber(dex?.market_cap), position.high_water_mcap, position.entry_mcap);

  // PnL berdasarkan HARGA USD (bukan market cap / volume)
  const entryPrice = Number(position.entry_price);
  const entryMcap = Number(position.entry_mcap);

  if ((!Number.isFinite(entryPrice) || entryPrice <= 0) && (!Number.isFinite(entryMcap) || entryMcap <= 0)) {
    return null;
  }

  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap || 0));

  // Prioritas: rasio harga USD → fallback rasio mcap
  let pnlPercent;
  if (entryPrice > 0 && price > 0) {
    pnlPercent = (price / entryPrice - 1) * 100;
  } else {
    pnlPercent = (Number(mcap) / entryMcap - 1) * 100;
  }
  let pnlEth = (Number(position.size_eth) * pnlPercent) / 100;

  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);

  // Trailing: jarak turun dari high-water HARGA (bukan mcap)
  const trailDrop =
    highWaterPrice > 0 && price > 0
      ? (price / highWaterPrice - 1) * 100
      : highWaterMcap > 0
        ? (Number(mcap) / highWaterMcap - 1) * 100
        : 0;
  const trailingHit =
    trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));

  let exitReason = null;

  // Max hold
  const strat = strategyById(position.strategy_id) || activeStrategy();
  if (strat?.max_hold_ms > 0 && now() - position.opened_at_ms >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    markPartialTpDone(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          updateTokenAmount(position.id, remaining);
          recordTrade({
            positionId: position.id,
            mint: position.mint,
            side: 'sell',
            price,
            mcap,
            sizeEth: position.size_eth * (strat.partial_tp_sell_percent / 100),
            tokenAmountEst: sellAmount,
            reason: 'PARTIAL_TP',
            payload: { pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining },
          });
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    } else {
      // dry-run partial bookkeeping
      recordTrade({
        positionId: position.id,
        mint: position.mint,
        side: 'sell',
        price,
        mcap,
        sizeEth: position.size_eth * (strat.partial_tp_sell_percent / 100),
        tokenAmountEst: Number(position.token_amount_est || 0) * (strat.partial_tp_sell_percent / 100),
        reason: 'PARTIAL_TP',
        payload: { pnlPercent, dryRun: true },
      });
    }
  }

  // Standard exits
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  updateHighWater({
    id: position.id,
    highWaterPrice,
    highWaterMcap,
    trailingArmed,
    pnlPercent,
    pnlEth,
  });

  let finalPnlPercent = pnlPercent;
  let finalPnlEth = pnlEth;
  let closed = false;

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedWei = Number(sell.outputAmount || 0);
    const receivedEth = receivedWei > 0 ? receivedWei / 1e18 : null;
    if (receivedEth != null) {
      finalPnlEth = receivedEth - Number(position.size_eth);
      finalPnlPercent = (receivedEth / Number(position.size_eth) - 1) * 100;
    }

    closePosition({
      id: position.id,
      exitPrice: price,
      exitMcap: mcap,
      exitReason,
      pnlPercent: finalPnlPercent,
      pnlEth: finalPnlEth,
      exitSignature: sell.signature,
    });
    recordTrade({
      positionId: position.id,
      mint: position.mint,
      side: 'sell',
      price,
      mcap,
      sizeEth: position.size_eth,
      tokenAmountEst: position.token_amount_est,
      reason: exitReason,
      payload: { pnlPercent: finalPnlPercent, pnlEth: finalPnlEth, receivedEth, sell },
    });
    closed = true;
  } else if (exitReason && autoExit) {
    closePosition({
      id: position.id,
      exitPrice: price,
      exitMcap: mcap,
      exitReason,
      pnlPercent,
      pnlEth,
    });
    recordTrade({
      positionId: position.id,
      mint: position.mint,
      side: 'sell',
      price,
      mcap,
      sizeEth: position.size_eth,
      tokenAmountEst: position.token_amount_est,
      reason: exitReason,
      payload: { pnlPercent, pnlEth, dryRun: true },
    });
    closed = true;
  }

  return {
    ...position,
    status: closed ? 'closed' : position.status,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    price,
    mcap,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlEth: finalPnlEth,
    pnl_eth: finalPnlEth,
  };
}

/**
 * Re-check filters before execution (anti-stale).
 */
export async function refreshCandidateForExecution(row) {
  const mint = row.candidate?.token?.mint || row.mint;
  const enriched = await enrichToken(mint);
  const strat = activeStrategy();

  const signals = row.candidate?.signals || {
    route: 'refresh',
    sourceCount: 1,
    hasVolumeSpike: false,
    hasNewPool: false,
    hasTrending: true,
    hasOnchain: false,
    strategy: strat.id,
  };

  const refreshed = {
    ...row.candidate,
    token: {
      ...row.candidate.token,
      name: enriched.meta.name || row.candidate.token.name,
      symbol: enriched.meta.symbol || row.candidate.token.symbol,
    },
    metrics: enriched.metrics,
    holders: enriched.holdersData,
    trending: enriched.dex,
    onchain: enriched.onchain,
    signals,
    enriched,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
    },
  };

  refreshed.filters = filterCandidate(refreshed);

  // Execution hard guards
  const failures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    failures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    failures.push('execution price: missing');
  }
  if (failures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...failures],
    };
  }

  try {
    updateCandidateSnapshot(row.id, refreshed);
  } catch {
    /* ignore */
  }

  return { ...row, candidate: refreshed };
}

export async function monitorPositions() {
  const positions = openPositions();
  for (const position of positions) {
    const result = await refreshPosition(position, { autoExit: true }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) {
      await sendPositionExit(result);
    }
  }
}

export function startPositionMonitor(intervalMs) {
  const period = intervalMs || numSetting('position_check_ms', 10_000) || 10_000;
  let busy = false;
  const tick = async (reason = 'poll') => {
    if (busy) return;
    busy = true;
    try {
      await monitorPositions();
    } catch (err) {
      console.log(`[position] monitor error (${reason}): ${err.message}`);
    } finally {
      busy = false;
    }
  };

  // Poll tetap jalan sebagai baseline
  const loop = async () => {
    await tick('poll');
    setTimeout(loop, period);
  };
  loop();

  // WebSocket newHeads → monitor lebih responsif
  startBlockWatcher(async (blockNumber) => {
    await tick(`ws:${blockNumber}`);
  }).then((res) => {
    if (res.ok) console.log('[position] ws block watcher active — poll fallback tetap jalan');
  });
}

/**
 * Close manual posisi (dry_run / live).
 * /close <id> — atau /close <symbol/CA> untuk yang open.
 */
export async function closePositionManually(selector, { reason = 'MANUAL' } = {}) {
  const key = String(selector || '').toLowerCase();
  const open = openPositions();
  const position =
    open.find((p) => String(p.id) === String(selector)) ||
    open.find((p) => (p.mint || '').toLowerCase() === key) ||
    open.find((p) => (p.symbol || '').toLowerCase() === key) ||
    open.find((p) => (p.mint || '').toLowerCase().includes(key) && key.length > 3);

  if (!position) {
    return { ok: false, error: `Posisi open tidak ditemukan: ${selector}` };
  }

  const dex = await fetchDexPair(position.mint);
  const price = Number(dex?.priceUsd || position.entry_price || 0);
  const mcap = Number(dex?.market_cap || position.entry_mcap || 0);
  const entryPrice = Number(position.entry_price) || 1;
  const pnlPercent = price > 0 && entryPrice > 0 ? (price / entryPrice - 1) * 100 : Number(position.pnl_percent || 0);
  const pnlEth = (Number(position.size_eth) * pnlPercent) / 100;

  let exitSignature = null;
  let receivedEth = null;

  if (position.execution_mode === 'live') {
    const sell = await executeLiveSell(position, reason);
    exitSignature = sell.signature;
    const wei = Number(sell.outputAmount || 0);
    if (wei > 0) receivedEth = wei / 1e18;
  }

  const finalPnlEth = receivedEth != null ? receivedEth - Number(position.size_eth) : pnlEth;
  const finalPnlPct =
    receivedEth != null ? (receivedEth / Number(position.size_eth) - 1) * 100 : pnlPercent;

  closePosition({
    id: position.id,
    exitPrice: price,
    exitMcap: mcap,
    exitReason: reason,
    pnlPercent: finalPnlPct,
    pnlEth: finalPnlEth,
    exitSignature,
  });

  recordTrade({
    positionId: position.id,
    mint: position.mint,
    side: 'sell',
    price,
    mcap,
    sizeEth: position.size_eth,
    tokenAmountEst: position.token_amount_est,
    reason,
    payload: { manual: true, pnlPercent: finalPnlPct, pnlEth: finalPnlEth, receivedEth, exitSignature },
  });

  return {
    ok: true,
    position: {
      ...position,
      status: 'closed',
      pnl_percent: finalPnlPct,
      pnl_eth: finalPnlEth,
      exit_price: price,
      exit_reason: reason,
    },
  };
}

/**
 * Adopsi token yang sudah ada di wallet menjadi posisi terpantau (/adopt).
 *
 * Latar: kalau sebuah pembelian sukses on-chain tapi posisinya gagal tercatat,
 * token itu duduk di wallet TANPA TP/SL — monitor tidak tahu token itu ada.
 * /adopt menutup celah itu tanpa mengirim transaksi apa pun.
 *
 * Saldo dibaca langsung dari chain sebagai BigInt dan disimpan apa adanya
 * (string uint256) — tidak lewat Number(), yang akan merusak nilai >= 1e21.
 */
export async function adoptWalletPosition(mint, { sizeEth = null, entryPriceUsd = null } = {}) {
  const addr = String(mint || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return { ok: false, error: 'Alamat token tidak valid (harus 0x + 40 hex).' };
  }
  if (hasOpenPositionForMint(addr)) {
    return { ok: false, error: `Sudah ada posisi terbuka #${openPositionIdForMint(addr)} untuk token ini.` };
  }

  // 1) Saldo nyata on-chain — ini yang menentukan ada/tidaknya sesuatu untuk diadopsi.
  let balanceRaw;
  try {
    balanceRaw = await fetchLiveTokenBalance(addr);
  } catch (err) {
    return { ok: false, error: `Gagal baca saldo token: ${err.message}. Pastikan PRIVATE_KEY terpasang.` };
  }
  if (!balanceRaw || balanceRaw <= 0n) {
    return { ok: false, error: 'Saldo token di wallet = 0 — tidak ada yang bisa diadopsi.' };
  }

  // 2) Harga/metadata pasar (best-effort — token rug sering sudah hilang dari aggregator).
  let enriched = null;
  try {
    enriched = await enrichToken(addr);
  } catch {
    /* lanjut tanpa enrichment */
  }
  const decimals = Number(enriched?.meta?.decimals) || 18;
  const tokenAmountEst = Number(balanceRaw) / 10 ** decimals;
  const marketPrice = Number(enriched?.metrics?.priceUsd) || 0;
  const entryPrice = Number(entryPriceUsd) > 0 ? Number(entryPriceUsd) : marketPrice;
  const entryMcap = Number(enriched?.metrics?.marketCapUsd) || 0;

  if (!(entryPrice > 0)) {
    return {
      ok: false,
      error:
        'Harga token tidak diketahui (tidak ada di DexScreener/GMGN) dan tidak Anda sebutkan. ' +
        'Ulangi dengan harga entry eksplisit: /adopt <mint> <size_eth> <entry_price_usd>',
    };
  }

  const strat = activeStrategy();
  const size = Number(sizeEth) > 0 ? Number(sizeEth) : Number(strat.position_size_eth) || 0.05;

  // 3) Apakah token ini benar-benar bisa dijual? Adopsi token rug hanya memberi
  //    rasa aman palsu — laporkan apa adanya (read-only, tanpa transaksi).
  let sellable = null;
  let routeNote = '';
  try {
    const route = await resolveSwapRoute(addr, null, { allowZeroLiquidity: true });
    sellable = Boolean(route);
    routeNote = route
      ? `rute exit: ${route.kind.toUpperCase()} via ${route.source}`
      : 'TIDAK ada rute exit — pool V3/V4 tidak ditemukan (kemungkinan LP sudah ditarik / rug).';
  } catch (err) {
    sellable = false;
    routeNote = `cek rute exit gagal: ${err.message}`;
  }

  const positionId = createAdoptedPosition({
    mint: addr,
    symbol: enriched?.meta?.symbol || addr.slice(0, 8),
    sizeEth: size,
    entryPrice,
    entryMcap,
    tokenAmountRaw: balanceRaw.toString(),
    tokenAmountEst,
    strategyId: strat.id,
    note: `Adopsi manual dari saldo wallet. ${routeNote}`,
  });

  return {
    ok: true,
    positionId,
    position: positionById(positionId),
    sellable,
    routeNote,
    balanceRaw: balanceRaw.toString(),
    tokenAmountEst,
    entryPrice,
    usedMarketPrice: !(Number(entryPriceUsd) > 0),
    sizeEth: size,
  };
}
