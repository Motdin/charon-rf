import { db } from './connection.js';
import { now, json, parseJson } from '../utils.js';
import { numSetting, setting, strategyById, activeStrategy } from './settings.js';
import { toRawAmountString } from '../execution/swapMath.js';

export function tradingMode() {
  return setting('trading_mode', process.env.TRADING_MODE || 'dry_run');
}

export function openPositionCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status = 'open'").get().c;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  return openPositionCount() < max;
}

/**
 * Apakah sudah ada posisi TERBUKA untuk mint ini?
 * Mencegah buy ganda token yang sama (trailing/TP belum jalan).
 */
export function hasOpenPositionForMint(mint) {
  if (!mint) return false;
  const row = db
    .prepare("SELECT id FROM dry_run_positions WHERE status = 'open' AND lower(mint) = lower(?) LIMIT 1")
    .get(String(mint));
  return Boolean(row);
}

export function openPositionIdForMint(mint) {
  const row = db
    .prepare("SELECT id FROM dry_run_positions WHERE status = 'open' AND lower(mint) = lower(?) LIMIT 1")
    .get(String(mint));
  return row?.id ?? null;
}

export function openPositions() {
  return db
    .prepare("SELECT * FROM dry_run_positions WHERE status = 'open' ORDER BY opened_at_ms DESC")
    .all()
    .map(rowToPosition);
}

export function positionById(id) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  return row ? rowToPosition(row) : null;
}

function rowToPosition(row) {
  return {
    ...row,
    snapshot: parseJson(row.snapshot_json, {}),
  };
}

function baseInsert({ candidateId, candidate, decision, mode, strategyId, sizeEth, entryPrice, entryMcap, tokenAmountEst, tokenAmountRaw, entrySignature }) {
  const strat = strategyById(strategyId) || activeStrategy();
  const result = db
    .prepare(
      `INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_eth, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, partial_tp_done,
        execution_mode, strategy_id, token_amount_raw, entry_signature, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol || '',
      now(),
      sizeEth,
      entryPrice,
      entryMcap,
      tokenAmountEst,
      entryPrice,
      entryMcap,
      strat.tp_percent ?? 50,
      strat.sl_percent ?? -25,
      strat.trailing_enabled ? 1 : 0,
      strat.trailing_percent ?? 20,
      mode,
      strategyId,
      tokenAmountRaw ?? null,
      entrySignature ?? null,
      json({ candidate, decision })
    );
  return result.lastInsertRowid;
}

export function createDryRunPosition(candidateId, candidate, decision, source = 'dry_run') {
  const strat = activeStrategy();
  const sizeEth = strat.position_size_eth ?? numSetting('dry_run_buy_eth', 0.05);
  const entryPrice = Number(candidate.metrics?.priceUsd) || 0;
  const entryMcap = Number(candidate.metrics?.marketCapUsd) || 0;
  const tokenAmountEst = entryPrice > 0 ? (sizeEth * 2500) / entryPrice : 0;
  return baseInsert({
    candidateId,
    candidate,
    decision,
    mode: 'dry_run',
    strategyId: strat.id,
    sizeEth,
    entryPrice,
    entryMcap,
    tokenAmountEst,
    tokenAmountRaw: toRawAmountString(tokenAmountEst),
  });
}

export function createLivePosition(candidateId, candidate, decision, swap, source = 'live') {
  const strat = activeStrategy();
  const sizeEth = swap.sizeEth ?? strat.position_size_eth ?? 0.05;
  const entryPrice = Number(candidate.metrics?.priceUsd) || 0;
  const entryMcap = Number(candidate.metrics?.marketCapUsd) || 0;
  const tokenAmountEst = swap.outputAmount ? Number(swap.outputAmount) / 1e18 : entryPrice > 0 ? (sizeEth * 2500) / entryPrice : 0;
  return baseInsert({
    candidateId,
    candidate,
    decision,
    mode: 'live',
    strategyId: strat.id,
    sizeEth,
    entryPrice,
    entryMcap,
    tokenAmountEst,
    // outputAmount sudah raw uint256 dari receipt — pakai apa adanya.
    // Fallback estimasi lewat helper agar tidak pernah jadi notasi eksponensial.
    tokenAmountRaw: swap.outputAmount ? String(swap.outputAmount) : toRawAmountString(tokenAmountEst),
    entrySignature: swap.signature,
  });
}

/**
 * Adopsi token yang SUDAH ada di wallet menjadi posisi terpantau.
 *
 * Dipakai untuk token nyasar: pembelian yang transaksinya sukses on-chain tapi
 * posisinya tidak pernah tercatat (mis. bug tx-hilang), atau pembelian manual.
 * Tanpa baris posisi, monitor TP/SL tidak tahu token itu ada dan tidak akan
 * pernah menjualnya.
 *
 * `tokenAmountRaw` WAJIB string uint256 dari saldo on-chain — jangan lewat
 * Number() (kehilangan presisi + notasi eksponensial pada nilai >= 1e21).
 */
export function createAdoptedPosition({
  mint,
  symbol,
  sizeEth,
  entryPrice,
  entryMcap,
  tokenAmountRaw,
  tokenAmountEst,
  strategyId,
  note = '',
}) {
  const strat = strategyById(strategyId) || activeStrategy();
  return baseInsert({
    candidateId: null,
    candidate: {
      token: { mint, symbol: symbol || '', name: symbol || '' },
      metrics: { priceUsd: entryPrice, marketCapUsd: entryMcap },
      signals: { route: 'adopted', sourceCount: 0 },
      filters: { passed: true, failures: [] },
    },
    decision: {
      verdict: 'ADOPTED',
      confidence: 0,
      reason: note || 'Diadopsi manual dari saldo wallet — bukan keputusan agent.',
      risks: ['adopted_position'],
    },
    mode: 'live',
    strategyId: strat.id,
    sizeEth,
    entryPrice,
    entryMcap,
    tokenAmountEst,
    tokenAmountRaw: String(tokenAmountRaw),
  });
}

export function recordTrade({ positionId, mint, side, price, mcap, sizeEth, tokenAmountEst, reason, payload }) {
  db.prepare(
    `INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_eth, token_amount_est, reason, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(positionId, mint, side, now(), price, mcap, sizeEth, tokenAmountEst, reason, json(payload));
}

export function closePosition({ id, exitPrice, exitMcap, exitReason, pnlPercent, pnlEth, exitSignature }) {
  db.prepare(
    `UPDATE dry_run_positions
     SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
         pnl_percent = ?, pnl_eth = ?, exit_signature = ?
     WHERE id = ?`
  ).run(now(), exitPrice, exitMcap, exitReason, pnlPercent, pnlEth, exitSignature ?? null, id);
}

export function updateHighWater({ id, highWaterPrice, highWaterMcap, trailingArmed, pnlPercent, pnlEth }) {
  // pnl_percent / pnl_eth diisi juga untuk posisi OPEN (unrealized)
  // supaya /positions menampilkan PnL live, bukan 0 terus
  db.prepare(
    `UPDATE dry_run_positions
     SET high_water_price = ?, high_water_mcap = ?, trailing_armed = ?,
         pnl_percent = COALESCE(?, pnl_percent),
         pnl_eth = COALESCE(?, pnl_eth)
     WHERE id = ?`
  ).run(
    highWaterPrice,
    highWaterMcap,
    trailingArmed ? 1 : 0,
    Number.isFinite(Number(pnlPercent)) ? Number(pnlPercent) : null,
    Number.isFinite(Number(pnlEth)) ? Number(pnlEth) : null,
    id
  );
}

export function markPartialTpDone(id) {
  db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(id);
}

export function updateTokenAmount(id, amountRaw) {
  db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(amountRaw), id);
}

export function closedPositions(limit = 50) {
  return db
    .prepare("SELECT * FROM dry_run_positions WHERE status = 'closed' ORDER BY closed_at_ms DESC LIMIT ?")
    .all(limit)
    .map(rowToPosition);
}

export function allPositions(limit = 100) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY opened_at_ms DESC LIMIT ?').all(limit).map(rowToPosition);
}
