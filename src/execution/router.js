import {
  tradingMode,
  createLivePosition,
  canOpenMorePositions,
  openPositionCount,
} from '../db/positions.js';
import { intentById, updateIntentStatus } from '../db/intents.js';
import { logDecisionEvent, updateCandidateStatus } from '../db/candidates.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance, checkLiveReserve } from '../liveExecutor.js';
import { refreshCandidateForExecution } from './positions.js';
import { sendTelegram, sendPositionOpen } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { escapeHtml, fmtEth } from './helpers.js';
import { LIVE_MIN_ETH_RESERVE, NATIVE_ETH } from '../config.js';
import { parseEther, formatEther } from 'viem';

/**
 * Execution router: dry_run / confirm / live.
 */

/** Ambil hint pair (labels/pairAddress) dari kandidat untuk routing V3/V4 yang akurat. */
function dexPairHint(candidate) {
  const dex = candidate?.trending || candidate?.enriched?.dex || candidate?.dex;
  if (!dex) return null;
  return {
    labels: dex.labels || [],
    pairAddress: dex.pairAddress || candidate?.token?.pairAddress || '',
    dexId: dex.dexId || candidate?.token?.dexId || '',
    quoteToken: dex.quoteToken?.address || dex.quoteTokenAddress || '',
  };
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const sizeEth = strat.position_size_eth ?? numSetting('dry_run_buy_eth', 0.05);

  const reserveCheck = await checkLiveReserve(sizeEth);
  if (!reserveCheck.sufficient) {
    throw new Error(
      `Insufficient balance. Need ${sizeEth} ETH + ${LIVE_MIN_ETH_RESERVE} reserve ` +
        `(native ${formatEther(reserveCheck.balance)} + WETH ${formatEther(reserveCheck.wethBalance)} ` +
        `= ${formatEther(reserveCheck.totalBalance)}).`
    );
  }

  const amountWei = parseEther(String(sizeEth));
  const swap = await executeJupiterSwap({
    inputMint: NATIVE_ETH,
    outputMint: selectedRow.candidate.token.mint,
    amount: amountWei,
    dexPair: dexPairHint(selectedRow.candidate),
  });

  if (!swap.outputAmount) {
    swap.outputAmount = await fetchLiveTokenBalance(selectedRow.candidate.token.mint) || '0';
  }
  swap.sizeEth = sizeEth;

  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);

  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    strategyId: strat.id,
    guardrails: {
      sizeEth,
      minReserve: LIVE_MIN_ETH_RESERVE,
    },
    execution: { positionId, swap },
  });

  await sendPositionOpen(positionId);
  return positionId;
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: NATIVE_ETH,
    amount: BigInt(String(amount)),
  });
}

export async function executeConfirmedIntent(chatId, intentId, bot) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') {
    return bot.sendMessage(chatId, 'Pending intent not found.');
  }
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }

  const { decision, candidate } = intent.payload;

  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate,
    });

    if (!freshRow.candidate.filters?.passed) {
      updateIntentStatus(intentId, 'rejected_stale');
      return bot.sendMessage(
        chatId,
        [
          '🛑 <b>Trade intent rejected on fresh check</b>',
          '',
          candidateSummary(freshRow.candidate, decision),
          '',
          `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
        ].join('\n'),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    }

    const strat = activeStrategy();
    const sizeEth = strat.position_size_eth ?? numSetting('dry_run_buy_eth', 0.05);
    const reserveCheck = await checkLiveReserve(sizeEth);
    if (!reserveCheck.sufficient) {
      updateIntentStatus(intentId, 'rejected_insufficient_balance');
      return bot.sendMessage(
        chatId,
        `Insufficient balance. Need ${sizeEth} ETH + ${LIVE_MIN_ETH_RESERVE} reserve ` +
          `(native ${formatEther(reserveCheck.balance)} + WETH ${formatEther(reserveCheck.wethBalance)} ` +
          `= ${formatEther(reserveCheck.totalBalance)}).`,
        { parse_mode: 'HTML' }
      );
    }

    const swap = await executeJupiterSwap({
      inputMint: NATIVE_ETH,
      outputMint: freshRow.candidate.token.mint,
      amount: parseEther(String(sizeEth)),
      dexPair: dexPairHint(freshRow.candidate),
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || '0';
    }
    swap.sizeEth = sizeEth;

    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    updateIntentStatus(intentId, 'executed_live');

    logDecisionEvent({
      batchId: null,
      triggerCandidateId: null,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      strategyId: strat.id,
      execution: { positionId, swap, intentId },
    });

    return sendPositionOpen(positionId);
  } catch (err) {
    updateIntentStatus(intentId, 'execution_failed');
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId, bot) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  updateIntentStatus(intentId, 'rejected');
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
