import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { db } from '../db/connection.js';
import { now, json, parseJson, fmtPct, fmtEth } from '../utils.js';

/**
 * Learning loop — analisa trade tertutup via LLM → simpan lesson
 * → disuntik ke prompt keputusan berikutnya (activeLessonsForPrompt).
 *
 * Charon-parity: /learn <window> · /lessons
 */

export function parseWindow(arg) {
  const t = String(arg || '24h').toLowerCase().trim();
  const map = {
    '1h': 3600_000,
    '6h': 6 * 3600_000,
    '24h': 24 * 3600_000,
    '1d': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
    '168h': 7 * 24 * 3600_000,
  };
  if (map[t]) return { windowMs: map[t], label: t };
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) {
    return { windowMs: n >= 1000 ? n : n * 3600_000, label: t };
  }
  return { windowMs: 24 * 3600_000, label: '24h' };
}

export function collectClosedTrades(windowMs, limit = 40) {
  const cutoff = now() - windowMs;
  return db
    .prepare(
      `SELECT id, mint, symbol, status, opened_at_ms, closed_at_ms, size_eth,
              entry_price, exit_price, entry_mcap, exit_mcap,
              exit_reason, pnl_percent, pnl_eth, strategy_id, execution_mode
       FROM dry_run_positions
       WHERE status = 'closed' AND closed_at_ms IS NOT NULL AND closed_at_ms >= ?
       ORDER BY closed_at_ms DESC LIMIT ?`
    )
    .all(cutoff, limit);
}

export function summarizeTrades(trades) {
  const wins = trades.filter((t) => Number(t.pnl_percent || 0) > 0);
  const losses = trades.filter((t) => Number(t.pnl_percent || 0) <= 0);
  const netPct = trades.reduce((a, t) => a + Number(t.pnl_percent || 0), 0);
  const netEth = trades.reduce((a, t) => a + Number(t.pnl_eth || 0), 0);
  const byReason = {};
  for (const t of trades) {
    const r = t.exit_reason || 'UNKNOWN';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPct,
    netEth,
    avgWin: wins.length ? wins.reduce((a, t) => a + Number(t.pnl_percent || 0), 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + Number(t.pnl_percent || 0), 0) / losses.length : 0,
    byReason,
  };
}

function compactTradeForLlm(t) {
  return {
    symbol: t.symbol || t.mint?.slice(0, 10),
    mint: t.mint,
    strategy: t.strategy_id,
    hold_min: t.closed_at_ms && t.opened_at_ms ? Math.round((t.closed_at_ms - t.opened_at_ms) / 60000) : null,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    entry_mcap: t.entry_mcap,
    pnl_percent: Number(t.pnl_percent || 0),
    pnl_eth: Number(t.pnl_eth || 0),
    exit_reason: t.exit_reason,
  };
}

function strictJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).trim());
  } catch {
    const m = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Generate lessons via LLM from closed trades.
 * Returns { lessons: [{lesson, evidence}], summary, raw }
 */
export async function generateLessons(trades) {
  const summary = summarizeTrades(trades);
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      lessons: ruleBasedLessons(trades, summary),
      summary,
      source: 'rule-based (LLM off)',
    };
  }
  if (!trades.length) {
    return { lessons: [], summary, source: 'no trades' };
  }

  const system = [
    'You are Charon-RH learning engine for a Solana-style trench agent on Robinhood Chain.',
    'You receive closed dry-run/live trades and must extract reusable LESSONS.',
    'Return strict JSON only: {"lessons":[{"lesson":"string","evidence":"string","severity":"low|medium|high"}]}',
    'Rules:',
    '- 1 to 5 lessons, each under 200 chars, actionable, in English.',
    '- Focus on patterns: bad exit reasons, hold time, win rate, SL overshoot, mcap range, strategy.',
    '- Do not invent stats not present in the data.',
    '- evidence must cite concrete numbers from the trades (e.g. "3/5 SL at avg -32% vs target -15%").',
  ].join(' ');

  const user = {
    window_summary: summary,
    trades: trades.map(compactTradeForLlm),
  };

  try {
    const res = await axios.post(
      `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        model: LLM_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(user) },
        ],
      },
      {
        timeout: LLM_TIMEOUT_MS,
        headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
      }
    );
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJson(content);
    const list = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    const lessons = list
      .slice(0, 5)
      .map((x) => ({
        lesson: String(x.lesson || '').slice(0, 300),
        evidence: String(x.evidence || '').slice(0, 300),
        severity: ['low', 'medium', 'high'].includes(String(x.severity)) ? String(x.severity) : 'medium',
      }))
      .filter((x) => x.lesson);

    if (!lessons.length) return { lessons: ruleBasedLessons(trades, summary), summary, source: 'llm-empty→rules' };
    return { lessons, summary, source: 'llm' };
  } catch (err) {
    console.log(`[learn] llm failed: ${err.message}`);
    return { lessons: ruleBasedLessons(trades, summary), summary, source: `llm-error→rules (${err.message.slice(0, 60)})` };
  }
}

/** Fallback statistik sederhana */
function ruleBasedLessons(trades, summary) {
  const out = [];
  if (summary.count < 3) {
    out.push({
      lesson: 'Not enough closed trades yet for reliable lessons — keep observing dry-run.',
      evidence: `${summary.count} trades in window`,
      severity: 'low',
    });
    return out;
  }
  if (summary.winRate < 40) {
    out.push({
      lesson: 'Win rate below 40% — tighten filters (mcap, holders, security) or raise LLM confidence.',
      evidence: `win rate ${summary.winRate.toFixed(1)}% over ${summary.count} trades`,
      severity: 'high',
    });
  }
  const sl = summary.byReason?.SL || 0;
  if (sl >= Math.ceil(summary.count * 0.4)) {
    out.push({
      lesson: 'Too many SL exits — consider wider SL or better entry (not near local top).',
      evidence: `${sl}/${summary.count} exited via SL, avg loss ${summary.avgLoss.toFixed(1)}%`,
      severity: 'medium',
    });
  }
  if (summary.avgLoss < -25) {
    out.push({
      lesson: 'Average loss deeper than −25% despite SL — reduce position size or check SL overshoot.',
      evidence: `avg loss ${summary.avgLoss.toFixed(1)}%`,
      severity: 'high',
    });
  }
  if (summary.netPct > 10) {
    out.push({
      lesson: 'Net positive — current strategy settings are working, keep them.',
      evidence: `net ${fmtPct(summary.netPct)} (${fmtEth(summary.netEth)})`,
      severity: 'low',
    });
  }
  return out.slice(0, 5);
}

export function storeLessons(lessons, evidenceBlob) {
  const stmt = db.prepare(
    `INSERT INTO learning_lessons (created_at_ms, status, lesson, evidence_json) VALUES (?, 'active', ?, ?)`
  );
  const ids = [];
  for (const l of lessons) {
    const text = l.lesson + (l.evidence ? ` [${l.evidence}]` : '');
    const result = stmt.run(now(), text, json({ ...l, batch: evidenceBlob }));
    ids.push(result.lastInsertRowid);
  }
  return ids;
}

export function listLessons(status = 'active', limit = 20) {
  return db
    .prepare(`SELECT * FROM learning_lessons WHERE status = ? ORDER BY id DESC LIMIT ?`)
    .all(status, limit)
    .map((r) => ({ ...r, evidence: parseJson(r.evidence_json, {}) }));
}

export function archiveLesson(id) {
  return db.prepare(`UPDATE learning_lessons SET status = 'archived' WHERE id = ?`).run(id).changes > 0;
}

export function deleteLesson(id) {
  return db.prepare(`DELETE FROM learning_lessons WHERE id = ?`).run(id).changes > 0;
}

export function formatLearnReport(result, label) {
  const s = result.summary;
  const lines = [
    `📚 <b>Learn report</b> — window ${escapeHtml(label)} · source: ${escapeHtml(result.source)}`,
    `Trades: ${s.count} (${s.wins}W/${s.losses}L) · win rate ${s.winRate.toFixed(1)}%`,
    `Net: ${fmtPct(s.netPct)} (${fmtEth(s.netEth)})`,
    `Avg win ${s.avgWin.toFixed(1)}% · avg loss ${s.avgLoss.toFixed(1)}%`,
    `Exits: ${Object.entries(s.byReason).map(([k, v]) => `${k}×${v}`).join(' · ') || '—'}`,
    '',
    `<b>${result.lessons.length} lesson(s) stored:</b>`,
  ];
  for (const l of result.lessons) {
    const tag = l.severity === 'high' ? '🔴' : l.severity === 'low' ? '🟢' : '🟡';
    lines.push(`${tag} ${escapeHtml(l.lesson)}`);
    if (l.evidence) lines.push(`   <i>${escapeHtml(l.evidence)}</i>`);
  }
  lines.push('', 'Injected into next LLM decisions automatically.');
  return lines.join('\n');
}

// kecil: escapeHtml lokal agar tidak circular import
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
