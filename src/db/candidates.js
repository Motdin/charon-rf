import { db } from './connection.js';
import { now, json, parseJson } from '../utils.js';

export function upsertCandidate(candidate, signalKey) {
  const mint = candidate.token.mint;
  const ts = now();
  const existing = db.prepare('SELECT id FROM candidates WHERE mint = ? AND signal_key = ?').get(mint, signalKey);
  const candidateJson = json(candidate);
  const filterJson = json(candidate.filters);

  if (existing) {
    db.prepare('UPDATE candidates SET candidate_json = ?, filter_result_json = ?, updated_at_ms = ? WHERE id = ?').run(
      candidateJson,
      filterJson,
      ts,
      existing.id
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signal_key, candidate_json, filter_result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(mint, 'new', ts, ts, signalKey, candidateJson, filterJson);
  return result.lastInsertRowid;
}

export function updateCandidateStatus(id, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), id);
}

export function updateCandidateSnapshot(id, candidate) {
  db.prepare('UPDATE candidates SET candidate_json = ?, filter_result_json = ?, updated_at_ms = ? WHERE id = ?').run(
    json(candidate),
    json(candidate.filters),
    now(),
    id
  );
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? rowToCandidate(row) : null;
}

export function recentEligibleCandidates(limit = 10) {
  const maxAge = Number(process.env.LLM_CANDIDATE_MAX_AGE_MS || 600_000);
  const cutoff = now() - maxAge;
  const rows = db
    .prepare(
      `SELECT * FROM candidates
       WHERE created_at_ms >= ? AND json_extract(filter_result_json, '$.passed') = 1
       ORDER BY created_at_ms DESC LIMIT ?`
    )
    .all(cutoff, limit);
  return rows.map(rowToCandidate);
}

function rowToCandidate(row) {
  return {
    id: row.id,
    mint: row.mint,
    status: row.status,
    created_at_ms: row.created_at_ms,
    candidate: parseJson(row.candidate_json, {}),
    filters: parseJson(row.filter_result_json, { passed: false, failures: [] }),
  };
}

export function storeSignalEvent(mint, kind, source, payload) {
  db.prepare('INSERT INTO signal_events (mint, kind, at_ms, source, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    mint,
    kind,
    now(),
    source,
    json(payload)
  );
}

export function storeDecision(candidateId, candidate, decision) {
  const result = db
    .prepare(
      `INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      candidateId,
      candidate.token?.mint || candidate.mint,
      now(),
      decision.verdict,
      decision.confidence,
      decision.reason || '',
      json(decision.risks || []),
      json(decision.raw || decision)
    );
  return result.lastInsertRowid;
}

export function storeBatchDecision(triggerCandidateId, rows, decision) {
  const result = db
    .prepare(
      `INSERT INTO llm_batches (created_at_ms, trigger_candidate_id, selected_candidate_id, selected_mint, verdict, confidence, reason, risks_json, raw_json, candidate_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      now(),
      triggerCandidateId,
      decision.selected_candidate_id,
      decision.selected_mint,
      decision.verdict,
      decision.confidence,
      decision.reason || '',
      json(decision.risks || []),
      json(decision.raw || decision),
      json(rows.map((r) => r.id))
    );
  return result.lastInsertRowid;
}

export function logDecisionEvent(event) {
  db.prepare(
    `INSERT INTO decision_logs (at_ms, batch_id, trigger_candidate_id, selected_candidate_id, selected_mint, mode, action, verdict, confidence, reason, strategy_id, guardrails_json, token_json, candidate_json, batch_json, execution_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    now(),
    event.batchId ?? null,
    event.triggerCandidateId ?? null,
    event.selectedRow?.id ?? null,
    event.selectedRow?.candidate?.token?.mint ?? event.selectedRow?.mint ?? null,
    event.mode || 'dry_run',
    event.action,
    event.decision?.verdict ?? null,
    event.decision?.confidence ?? null,
    event.decision?.reason ?? null,
    event.strategyId || null,
    json(event.guardrails || {}),
    json(event.selectedRow?.candidate?.token || event.token || {}),
    json(event.selectedRow?.candidate || event.candidate || {}),
    json(event.rows || event.batch || []),
    json(event.execution || {})
  );
}

export function storePriceAlert({ mint, strategyId, alertType, targetPriceUsd, targetAthDistancePercent, signal, expiresMs }) {
  db.prepare(
    `INSERT INTO price_alerts (mint, strategy_id, alert_type, target_price_usd, target_ath_distance_percent, candidate_json, signals_json, status, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    mint,
    strategyId,
    alertType,
    targetPriceUsd ?? null,
    targetAthDistancePercent ?? null,
    json(signal || {}),
    json(signal || {}),
    now(),
    now() + expiresMs
  );
}

export function pendingPriceAlerts() {
  return db
    .prepare("SELECT * FROM price_alerts WHERE status = 'pending' AND expires_at_ms > ?")
    .all(now())
    .map((row) => ({
      ...row,
      candidate: parseJson(row.candidate_json, {}),
      signals: parseJson(row.signals_json, {}),
    }));
}

export function triggerPriceAlert(id) {
  db.prepare("UPDATE price_alerts SET status = 'triggered', triggered_at_ms = ? WHERE id = ?").run(now(), id);
}
