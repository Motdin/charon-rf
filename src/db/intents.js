import { db } from './connection.js';
import { now, json, parseJson } from '../utils.js';

export function createTradeIntent(candidateId, candidate, decision, mode, status = 'pending_confirmation') {
  const sizeEth = Number(candidate.executionRefresh?.sizeEth) || Number(decision?.sizeEth) || 0.05;
  const result = db
    .prepare(
      `INSERT INTO trade_intents (candidate_id, mint, mode, status, side, size_eth, confidence, reason, created_at_ms, updated_at_ms, payload_json)
       VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      candidateId,
      candidate.token.mint,
      mode,
      status,
      sizeEth,
      decision?.confidence ?? null,
      decision?.reason ?? '',
      now(),
      now(),
      json({ candidate, decision })
    );
  return result.lastInsertRowid;
}

export function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(id);
  return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
}

export function pendingIntents() {
  return db
    .prepare("SELECT * FROM trade_intents WHERE status = 'pending_confirmation' ORDER BY created_at_ms DESC")
    .all()
    .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function updateIntentStatus(id, status) {
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), id);
}
