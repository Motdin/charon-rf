import {
  openPositions,
  positionById,
  closePosition,
  updateHighWater,
  markPartialTpDone,
  updateTokenAmount,
  recordTrade,
  tradingMode,
} from '../db/positions.js';
import { strategyById, activeStrategy, numSetting } from '../db/settings.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { enrichToken } from '../enrichment/index.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { fetchDexPair, trending } from '../signals/dexscreener.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit, sendTelegram } from '../telegram/send.js';
import { now, toNumber, firstPositiveNumber, fmtPct } from '../utils.js';

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

  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }

  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));

  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlEth = Number(position.size_eth) * pnlPercent / 100;

  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
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
  const loop = async () => {
    try {
      await monitorPositions();
    } catch (err) {
      console.log(`[position] monitor error: ${err.message}`);
    }
    setTimeout(loop, period);
  };
  loop();
}
