import axios from 'axios';
import {
  ENABLE_LLM,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  LLM_BACKUP_BASE_URL,
  LLM_BACKUP_API_KEY,
  LLM_BACKUP_MODEL,
  LLM_MAX_CALLS_PER_HOUR,
  LLM_MAX_CALLS_PER_DAY,
} from '../config.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { compactForLlm } from '../enrichment/index.js';

/**
 * LLM batch picker — Charon-style asymmetric selection.
 * Given up to N recent candidates, pick at most ONE as BUY.
 */

// ─── Pelindung kuota (free-tier friendly) ────────────────────────────────────
// Kasus nyata: user habis kuota free tier → 429 beruntun untuk tiap kandidat
// yang lolos filter. Tanpa pelindung, bot terus memukul provider (mempercepat
// ban harian) sambil tidak menghasilkan apa-apa. Sekarang:
//   - 429/error  → backoff eksponensial (maks 30 mnt), selama itu 0 panggilan
//   - budget     → maks panggilan per jam & per hari (counter in-memory)
//   - backup     → provider cadangan dicoba otomatis bila utama gagal
const llmState = {
  backoffUntil: 0,
  consecutiveErrors: 0,
  callsHour: 0,
  hourStart: 0,
  callsDay: 0,
  dayStart: 0,
  lastBackoffLogAt: 0,
  backupActive: false,
};

function is429(err) {
  const status = err?.response?.status;
  const msg = String(err?.message || '');
  return status === 429 || /\b429\b|rate limit|too many requests|quota/i.test(msg);
}

/** Status untuk /status telegram + smoke test. */
export function llmStatus() {
  const t = Date.now();
  return {
    backingOff: t < llmState.backoffUntil,
    backoffRemainingSec: Math.max(0, Math.ceil((llmState.backoffUntil - t) / 1000)),
    consecutiveErrors: llmState.consecutiveErrors,
    callsHour: llmState.callsHour,
    maxHour: LLM_MAX_CALLS_PER_HOUR,
    callsDay: llmState.callsDay,
    maxDay: LLM_MAX_CALLS_PER_DAY,
    backupConfigured: Boolean(LLM_BACKUP_BASE_URL && LLM_BACKUP_API_KEY),
    backupActive: llmState.backupActive,
  };
}

/**
 * Cek sebelum satu panggilan HTTP dilakukan. skip=true → jangan panggil API.
 * Dipakai decideCandidateBatch (dan bisa dipakai /learn).
 */
export function llmGuardCheck() {
  const t = Date.now();
  // Reset jendela counter
  if (t - llmState.hourStart > 3600_000) {
    llmState.hourStart = t;
    llmState.callsHour = 0;
  }
  if (t - llmState.dayStart > 86400_000) {
    llmState.dayStart = t;
    llmState.callsDay = 0;
  }
  if (t < llmState.backoffUntil) {
    return { skip: true, reason: `LLM paused — 429 backoff ${Math.ceil((llmState.backoffUntil - t) / 1000)}s tersisa`, kind: 'llm_backoff' };
  }
  if (LLM_MAX_CALLS_PER_HOUR > 0 && llmState.callsHour >= LLM_MAX_CALLS_PER_HOUR) {
    return { skip: true, reason: `LLM budget per jam habis (${llmState.callsHour}/${LLM_MAX_CALLS_PER_HOUR})`, kind: 'llm_budget_hour' };
  }
  if (LLM_MAX_CALLS_PER_DAY > 0 && llmState.callsDay >= LLM_MAX_CALLS_PER_DAY) {
    return { skip: true, reason: `LLM budget per hari habis (${llmState.callsDay}/${LLM_MAX_CALLS_PER_DAY})`, kind: 'llm_budget_day' };
  }
  return { skip: false };
}

export function noteLlmSuccess() {
  llmState.consecutiveErrors = 0;
  llmState.backoffUntil = 0;
}

export function noteLlmFailure(err) {
  llmState.consecutiveErrors++;
  // 429 (mau dihukum maupun tidak) → backoff cepat memanjang; error biasa lebih ringan
  const baseMs = is429(err) ? 5 * 60_000 : 60_000;
  const backoffMs = Math.min(30 * 60_000, baseMs * Math.min(llmState.consecutiveErrors, 6));
  llmState.backoffUntil = Date.now() + backoffMs;
  const t = Date.now();
  if (t - llmState.lastBackoffLogAt > 60_000) {
    llmState.lastBackoffLogAt = t;
    console.log(
      `[llm] ${is429(err) ? '429 rate limit' : 'error'} #${llmState.consecutiveErrors} — pause semua call ${Math.round(backoffMs / 1000)}s`
    );
  }
}

function noteLlmAttempt() {
  llmState.callsHour++;
  llmState.callsDay++;
}

/** Satu request chat/completions ke endpoint tertentu. Throw bila gagal. */
async function chatCompletion({ baseUrl, apiKey, model }, messages) {
  noteLlmAttempt();
  const res = await axios.post(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages,
    },
    {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    }
  );
  return res.data?.choices?.[0]?.message?.content || '';
}

/** Daftar endpoint: utama dulu, cadangan (bila dikonfigurasi) sebagai fallback. */
function llmEndpoints() {
  const eps = [{ baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL, tag: 'primary' }];
  if (LLM_BACKUP_BASE_URL && LLM_BACKUP_API_KEY) {
    eps.push({ baseUrl: LLM_BACKUP_BASE_URL, apiKey: LLM_BACKUP_API_KEY, model: LLM_BACKUP_MODEL || LLM_MODEL, tag: 'backup' });
  }
  return eps;
}

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  try {
    return db
      .prepare("SELECT lesson FROM learning_lessons WHERE status = 'active' ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => row.lesson);
  } catch {
    return [];
  }
}

function strictJsonFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  // Pelindung kuota: jangan pukul API sama sekali saat backoff / budget habis.
  // Kandidat tetap WATCH (fail-safe) — TIDAK ada buy tanpa LLM.
  const guard = llmGuardCheck();
  if (guard.skip) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: guard.reason,
      risks: [guard.kind],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { skipped: guard.kind },
    };
  }

  const system = [
    'You are Charon-RH, a Robinhood Chain (EVM L2) meme-coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Prefer candidates with multiple overlapping signals (volume spike + new pool + on-chain activity).',
    'Penalize high rug scores, thin liquidity, and extreme holder concentration.',
    "The 'anomalies' field lists manipulation signatures (wash volume, hidden holder concentration/sybil) — treat ANY anomaly as a strong reason to PASS, because volume spikes manufactured by wash trading are the most common trap on this chain.",
    'Chart-style price changes are context only — large 24h moves are normal for new meme tokens.',
    'Use pool age and distance from recent highs to judge whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');

  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: '0x mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map((row) =>
      compactForLlm(row.candidate.enriched || { metrics: row.candidate.metrics, meta: row.candidate.token }, row.filters, row.candidate.signals)
    ),
  };

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(user) },
  ];

  // Utama → cadangan (jika LLM_BACKUP_* diset). Tiap percobaan tercatat di budget.
  let content = null;
  let lastErr = null;
  for (const ep of llmEndpoints()) {
    try {
      content = await chatCompletion(ep, messages);
      noteLlmSuccess();
      if (ep.tag === 'backup') {
        llmState.backupActive = true;
        console.log('[llm] provider utama gagal — keputusan dari BACKUP provider');
      } else {
        llmState.backupActive = false;
      }
      break;
    } catch (err) {
      lastErr = err;
      noteLlmFailure(err);
      console.log(`[llm] ${ep.tag} failed: ${String(err.message).slice(0, 160)}`);
    }
  }

  if (content == null) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${lastErr?.message || 'unknown'}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: lastErr?.message || 'unknown' },
    };
  }

  const parsed = strictJsonFromText(content);
  const decision = normalizeDecision(parsed);
  const selectedId = Number(parsed?.selected_candidate_id);
  const selectedMint = String(parsed?.selected_mint || '').toLowerCase();
  const row =
    rows.find((item) => item.id === selectedId) ||
    rows.find((item) => item.candidate.token?.mint === selectedMint);

  return {
    ...decision,
    selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
    selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
    selected_row: decision.verdict === 'BUY' && row ? row : null,
  };
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate, filters: candidate.filters };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
