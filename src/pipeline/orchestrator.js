import { numSetting, boolSetting, activeStrategy } from '../db/settings.js';
import {
  upsertCandidate,
  updateCandidateStatus,
  recentEligibleCandidates,
  candidateById,
  storeDecision,
  storeBatchDecision,
  logDecisionEvent,
} from '../db/candidates.js';
import { buildCandidate } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import {
  createDryRunPosition,
  createLivePosition,
  canOpenMorePositions,
  openPositionCount,
  hasOpenPositionForMint,
  openPositionIdForMint,
  tradingMode,
} from '../db/positions.js';
import { createTradeIntent } from '../db/intents.js';
import { executeLiveBuy } from '../execution/router.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { sendTelegram, sendPositionOpen, sendTradeIntent, sendBatchReveal } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { short, escapeHtml, now, pruneSeen } from '../utils.js';
import { storePriceAlert } from '../db/candidates.js';

export const seenSignalCandidates = new Map();

/**
 * Main entry: a signal arrived from DexScreener / on-chain / price alert.
 */
export async function processCandidateFromSignals(signalPayload) {
  const strat = activeStrategy();

  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skip`);
    return;
  }

  const mint = signalPayload.mint;
  // 1 posisi terbuka per token — jangan beli ganda selama posisi lama masih hold
  if (hasOpenPositionForMint(mint)) {
    const pid = openPositionIdForMint(mint);
    console.log(`[agent] already holding ${mint.slice(0, 10)}… (#${pid}), skip duplicate`);
    return;
  }
  const signalKey = `${mint}:${signalPayload.route || 'x'}:${Math.floor(now() / 300_000)}`;
  if (seenSignalCandidates.has(signalKey)) return;
  seenSignalCandidates.set(signalKey, now());
  // Bucket 5-menit — buang entri > 30 menit agar Map tidak tumbuh tanpa batas
  pruneSeen(seenSignalCandidates, 30 * 60_000);

  // Dip buy: arm a price alert instead of buying immediately
  if (strat.entry_mode === 'wait_for_dip' && strat.max_ath_distance_pct < 0) {
    const trend = signalPayload.trendingToken;
    const alreadyDipped = trend?.priceChange24h != null && trend.priceChange24h <= strat.max_ath_distance_pct;
    if (!alreadyDipped) {
      const targetPrice = trend?.priceUsd ? trend.priceUsd * (1 + strat.max_ath_distance_pct / 100) : null;
      storePriceAlert({
        mint,
        strategyId: strat.id,
        alertType: 'dip_target',
        targetPriceUsd: targetPrice,
        targetAthDistancePercent: strat.max_ath_distance_pct,
        signal: trend || { mint },
        expiresMs: 24 * 3600_000,
      });
      console.log(`[agent] dip alert armed for ${mint.slice(0, 10)}…`);
      return;
    }
  }

  let candidate;
  try {
    candidate = await buildCandidate(signalPayload);
  } catch (err) {
    console.log(`[agent] build failed ${mint.slice(0, 10)}…: ${err.message}`);
    return;
  }

  const candidateId = upsertCandidate(candidate, signalKey);

  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.symbol || mint.slice(0, 10)}… ${candidate.filters.failures.join('; ')}`);
    return;
  }

  console.log(
    `[candidate] PASS ${candidate.token.symbol || mint.slice(0, 10)}… sources=${candidate.signals.sourceCount} route=${candidate.signals.route}`
  );

  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? 50,
      suggested_sl_percent: strat.sl_percent ?? -25,
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }

  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;

  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };

  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  // Threshold dari strategi aktif dulu, fallback ke setting global
  const minConfidence =
    Number(strat.llm_min_confidence) || numSetting('llm_min_confidence', 75);
  const approved =
    selectedRow &&
    boolSetting('agent_enabled', true) &&
    batchDecision.verdict === 'BUY' &&
    Number(batchDecision.confidence) >= minConfidence;

  if (approved) {
    if (!canOpenMorePositions()) {
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        strategyId: strat.id,
        guardrails: {
          maxOpenPositions: strat.max_open_positions ?? numSetting('max_open_positions', 3),
          openPositions: openPositionCount(),
          confidence: batchDecision.confidence,
          minConfidence,
        },
      });
      // Beri tahu user via Telegram — jangan diam saat slot penuh
      await sendTelegram([
        `🛑 <b>BUY ditolak — slot penuh</b>`,
        `Conf ${batchDecision.confidence} ≥ min ${minConfidence} ✓`,
        `Posisi: ${openPositionCount()}/${strat.max_open_positions ?? numSetting('max_open_positions', 3)}`,
        '',
        candidateSummary(selectedRow.candidate, batchDecision),
      ].join('\n'));
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      strategyId: strat.id,
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: minConfidence,
        actualConfidence: batchDecision.confidence,
        verdict: batchDecision.verdict,
        openPositions: openPositionCount(),
        maxOpenPositions: strat.max_open_positions ?? numSetting('max_open_positions', 3),
      },
    });
    // Log alasan penolakan ke Telegram agar tidak terlihat "freeze"
    if (selectedRow && batchDecision.verdict === 'BUY') {
      const why =
        Number(batchDecision.confidence) < minConfidence
          ? `conf ${batchDecision.confidence} < min ${minConfidence}`
          : !boolSetting('agent_enabled', true)
            ? 'agent OFF'
            : 'other guard';
      await sendTelegram(
        `🟡 <b>BUY tidak dieksekusi</b>\n${escapeHtml(why)}\n\n${candidateSummary(selectedRow.candidate, batchDecision)}`
      );
    }
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const strat = activeStrategy();

  // Guard ulang tepat sebelum eksekusi (race dengan signal berikutnya)
  const mintCheck = selectedRow?.candidate?.token?.mint;
  if (mintCheck && hasOpenPositionForMint(mintCheck)) {
    console.log(`[agent] skip buy ${mintCheck.slice(0, 10)}… — already open #${openPositionIdForMint(mintCheck)}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode,
      action: 'entry_skipped_duplicate_mint',
      strategyId: strat.id,
      guardrails: { openPositionId: openPositionIdForMint(mintCheck) },
    });
    return;
  }

  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);

  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      strategyId: strat.id,
      guardrails: { failures: freshSelectedRow.candidate.filters?.failures || [] },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows,
      decision,
      mode,
      action: 'dry_run_entry',
      strategyId: strat.id,
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows,
      decision,
      mode,
      action: 'confirm_intent_created',
      strategyId: strat.id,
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, rows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows,
      decision,
      mode,
      action: 'live_entry_failed',
      strategyId: strat.id,
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}
