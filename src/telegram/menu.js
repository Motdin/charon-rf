import {
  activeStrategy,
  allStrategies,
  strategyById,
  setActiveStrategy,
  updateStrategyConfig,
  numSetting,
  boolSetting,
  setSetting,
} from '../db/settings.js';
import { tradingMode } from '../db/positions.js';
import { escapeHtml, fmtUsd, fmtEth } from '../utils.js';

/**
 * Telegram strategy settings menu — Charon-parity.
 *
 * /menu              → main keyboard
 * /menu strategy     → strategy picker + editor
 * /stratset <id> <key> <value>  → hot-edit one param (SQLite, no restart)
 *
 * All values live in the strategies table and are hot-read by activeStrategy().
 */

// Editable strategy keys → { label, type, hint }
export const STRATEGY_FIELDS = {
  entry_mode: { label: 'Entry mode', type: 'enum', options: ['immediate', 'wait_for_dip'] },
  min_source_count: { label: 'Min source count', type: 'int', min: 1, max: 5 },
  require_volume_spike: { label: 'Require volume spike', type: 'bool' },
  pool_age_max_ms: { label: 'Pool age max (ms)', type: 'int', min: 0 },
  min_mcap_usd: { label: 'Min mcap USD', type: 'num', min: 0 },
  max_mcap_usd: { label: 'Max mcap USD', type: 'num', min: 0 },
  min_liquidity_usd: { label: 'Min liquidity USD', type: 'num', min: 0 },
  min_volume_h24_usd: { label: 'Min vol 24h USD', type: 'num', min: 0 },
  min_txns_h24: { label: 'Min txns 24h', type: 'int', min: 0 },
  min_holders: { label: 'Min holders', type: 'int', min: 0 },
  max_top10_holder_percent: { label: 'Max top10 holders %', type: 'num', min: 0, max: 100 },
  max_ath_distance_pct: { label: 'Max ATH distance %', type: 'num', max: 0 },
  trending_min_volume_usd: { label: 'Trending min vol USD', type: 'num', min: 0 },
  max_rug_score: { label: 'Max rug score', type: 'num', min: 0, max: 1 },
  position_size_eth: { label: 'Position size ETH', type: 'num', min: 0 },
  max_open_positions: { label: 'Max open positions', type: 'int', min: 1, max: 20 },
  tp_percent: { label: 'Take profit %', type: 'num' },
  sl_percent: { label: 'Stop loss %', type: 'num', max: 0 },
  trailing_enabled: { label: 'Trailing enabled', type: 'bool' },
  trailing_percent: { label: 'Trailing %', type: 'num', min: 0 },
  partial_tp: { label: 'Partial TP', type: 'bool' },
  partial_tp_at_percent: { label: 'Partial TP at %', type: 'num', min: 0 },
  partial_tp_sell_percent: { label: 'Partial TP sell %', type: 'num', min: 0, max: 100 },
  max_hold_ms: { label: 'Max hold (ms)', type: 'int', min: 0 },
  use_llm: { label: 'Use LLM', type: 'bool' },
  llm_min_confidence: { label: 'LLM min confidence', type: 'int', min: 0, max: 100 },
  require_security_pass: { label: 'Require security PASS', type: 'bool' },
  max_security_risk: { label: 'Max security risk', type: 'num', min: 0, max: 1 },
  min_saved_wallet_holders: { label: 'Min saved-wallet holders', type: 'int', min: 0 },
  max_insider_count: { label: 'Max insider count', type: 'int', min: 0 },
  max_sniper_share_percent: { label: 'Max sniper share %', type: 'num', min: 0, max: 100 },
};

function parseValue(field, raw) {
  const meta = STRATEGY_FIELDS[field];
  if (!meta) return { ok: false, error: `Unknown field '${field}'. See /stratset` };

  const text = String(raw).trim();
  if (meta.type === 'bool') {
    const v = text === 'true' || text === '1' || text === 'yes' || text === 'on';
    return { ok: true, value: v };
  }
  if (meta.type === 'enum') {
    if (!meta.options.includes(text)) {
      return { ok: false, error: `Must be one of: ${meta.options.join(', ')}` };
    }
    return { ok: true, value: text };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: 'Value must be a number' };
  if (meta.min != null && n < meta.min) return { ok: false, error: `Min ${meta.min}` };
  if (meta.max != null && n > meta.max) return { ok: false, error: `Max ${meta.max}` };
  return { ok: true, value: n };
}

export { parseValue };

// ── pending interactive edits (tap button → type value) ─────────

/** chatId -> { strategyId, field, label, current, expiresAt } */
const pendingEdits = new Map();
const PENDING_EDIT_TTL_MS = 3 * 60_000;

export function setPendingEdit(chatId, strategyId, field) {
  const meta = STRATEGY_FIELDS[field];
  const strat = strategyById(strategyId);
  if (!meta || !strat) return null;
  const state = {
    strategyId,
    field,
    label: meta.label,
    type: meta.type,
    options: meta.options || null,
    current: strat[field],
    expiresAt: Date.now() + PENDING_EDIT_TTL_MS,
  };
  pendingEdits.set(String(chatId), state);
  return state;
}

export function getPendingEdit(chatId) {
  const key = String(chatId);
  const state = pendingEdits.get(key);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    pendingEdits.delete(key);
    return null;
  }
  return state;
}

export function clearPendingEdit(chatId) {
  pendingEdits.delete(String(chatId));
}

export function hasPendingEdit(chatId) {
  return getPendingEdit(chatId) != null;
}

/**
 * Apply a pending interactive edit. Returns { ok, error?, value?, strategyId, field, label, current }.
 */
export function applyPendingEdit(chatId, rawValue) {
  const state = getPendingEdit(chatId);
  if (!state) return { ok: false, error: 'No pending edit' };
  const parsed = parseValue(state.field, rawValue);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, ...state };
  }
  const strat = strategyById(state.strategyId);
  const next = { ...strat };
  delete next.id;
  delete next.name;
  next[state.field] = parsed.value;
  updateStrategyConfig(state.strategyId, next);
  clearPendingEdit(chatId);
  return {
    ok: true,
    value: parsed.value,
    previous: state.current,
    strategyId: state.strategyId,
    field: state.field,
    label: state.label,
  };
}

/**
 * Toggle a bool field immediately (no typing needed).
 */
export function toggleBoolField(strategyId, field) {
  const meta = STRATEGY_FIELDS[field];
  if (!meta || meta.type !== 'bool') return null;
  const strat = strategyById(strategyId);
  const next = { ...strat };
  delete next.id;
  delete next.name;
  next[field] = !strat[field];
  updateStrategyConfig(strategyId, next);
  return { value: next[field], strategyId, field };
}

export function promptForPendingEdit(state) {
  const lines = [
    `✏️ <b>Set ${escapeHtml(state.label)}</b>`,
    `Strategy: <code>${escapeHtml(state.strategyId)}</code> · key <code>${escapeHtml(state.field)}</code>`,
    `Current: <b>${escapeHtml(String(state.current))}</b>`,
    '',
  ];
  if (state.type === 'bool') {
    lines.push('Send <code>on</code>/<code>off</code>, or tap a toggle below.');
  } else if (state.type === 'enum') {
    lines.push(`Send one of: <b>${(state.options || []).join(' | ')}</b>`);
  } else {
    lines.push('Send the new number value.');
  }
  lines.push('', 'Send /cancel to abort.');
  return lines.join('\n');
}

/**
 * /stratset <strategy_id> <key> <value>
 */
export async function handleStratSet(chatId, args, bot) {
  const [id, key, ...rest] = args;
  const value = rest.join(' ');
  if (!id || !key || !value) {
    return bot.sendMessage(chatId, [
      'Usage: <code>/stratset &lt;strategy_id&gt; &lt;key&gt; &lt;value&gt;</code>',
      '',
      'Example: <code>/stratset sniper tp_percent 75</code>',
      '',
      'Keys: ' + Object.keys(STRATEGY_FIELDS).join(', '),
    ].join('\n'), { parse_mode: 'HTML' });
  }

  const strat = strategyById(id);
  if (!strat) {
    const ids = allStrategies().map((s) => s.id).join(', ');
    return bot.sendMessage(chatId, `Unknown strategy <b>${escapeHtml(id)}</b>. Available: ${escapeHtml(ids)}`, {
      parse_mode: 'HTML',
    });
  }

  const parsed = parseValue(key, value);
  if (!parsed.ok) {
    return bot.sendMessage(chatId, `❌ ${escapeHtml(parsed.error)}`, { parse_mode: 'HTML' });
  }

  const next = { ...strat };
  delete next.id;
  delete next.name;
  next[key] = parsed.value;
  updateStrategyConfig(id, next);

  return bot.sendMessage(
    chatId,
    `✅ <b>${escapeHtml(id)}</b> → <code>${escapeHtml(key)}</code> = <b>${escapeHtml(String(parsed.value))}</b>\nApplies immediately (hot-read).`,
    { parse_mode: 'HTML' }
  );
}

export function formatStrategyCard(s) {
  const mark = s.enabled ? '▶️' : '▫️';
  return [
    `${mark} <b>${escapeHtml(s.id)}</b> — ${escapeHtml(s.name)}`,
    `Entry: ${s.entry_mode} · sources ≥ ${s.min_source_count}${s.require_volume_spike ? ' + vol spike' : ''}`,
    `Mcap: ${fmtUsd(s.min_mcap_usd)}–${fmtUsd(s.max_mcap_usd)} · Liq ≥ ${fmtUsd(s.min_liquidity_usd)}`,
    `Holders ≥ ${s.min_holders} · Top10 ≤ ${s.max_top10_holder_percent}% · Rug ≤ ${s.max_rug_score}`,
    `TP ${s.tp_percent}% / SL ${s.sl_percent}% · Trail ${s.trailing_percent}%${s.trailing_enabled ? '' : ' (off)'}`,
    s.partial_tp ? `Partial: +${s.partial_tp_at_percent}% sell ${s.partial_tp_sell_percent}%` : 'Partial: off',
    `Size ${s.position_size_eth} ETH · Max pos ${s.max_open_positions}`,
    `LLM: ${s.use_llm ? `on, conf ≥ ${s.llm_min_confidence}` : 'off (rule-based)'}`,
  ].join('\n');
}

export function formatFieldEditor(id, key) {
  const strat = strategyById(id);
  if (!strat) return `Unknown strategy ${id}`;
  const meta = STRATEGY_FIELDS[key];
  if (!meta) return `Unknown field ${key}`;
  const current = strat[key];
  return [
    `<b>${escapeHtml(id)} → ${escapeHtml(meta.label)}</b>`,
    `Key: <code>${escapeHtml(key)}</code>`,
    `Current: <b>${escapeHtml(String(current))}</b>`,
    `Type: ${meta.type}${meta.options ? ' (' + meta.options.join(' | ') + ')' : ''}`,
    meta.min != null ? `Min: ${meta.min}` : '',
    meta.max != null ? `Max: ${meta.max}` : '',
    '',
    `Set: <code>/stratset ${escapeHtml(id)} ${escapeHtml(key)} &lt;value&gt;</code>`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── inline keyboards ───────────────────────────────────────────

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'menu:status' },
        { text: '🎯 Strategy', callback_data: 'menu:strategy' },
      ],
      [
        { text: '⚙️ Mode', callback_data: 'menu:mode' },
        { text: '📈 Positions', callback_data: 'menu:positions' },
      ],
      [
        { text: '🔍 Filters', callback_data: 'menu:filters' },
        { text: '💰 PnL', callback_data: 'menu:pnl' },
      ],
      [{ text: '🤖 Agent on/off', callback_data: 'menu:agent' }],
    ],
  };
}

export function strategyListKeyboard() {
  const rows = allStrategies().map((s) => [
    { text: `${s.enabled ? '▶️' : '▫️'} ${s.id}`, callback_data: `strat:pick:${s.id}` },
  ]);
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

export function strategyEditorKeyboard(id) {
  // Show the most-used fields as quick buttons; full list via /stratset
  const keys = [
    'tp_percent',
    'sl_percent',
    'trailing_percent',
    'position_size_eth',
    'max_open_positions',
    'llm_min_confidence',
    'min_source_count',
    'max_rug_score',
  ];
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map((k) => ({
        text: `${STRATEGY_FIELDS[k].label}: ${shortVal(id, k)}`,
        callback_data: `strat:edit:${id}:${k}`,
      }))
    );
  }
  rows.push([
    { text: '✅ Activate', callback_data: `strat:activate:${id}` },
    { text: '⬅️ Strategies', callback_data: 'menu:strategy' },
  ]);
  return { inline_keyboard: rows };
}

function shortVal(id, key) {
  const s = strategyById(id);
  const v = s?.[key];
  if (v == null) return '?';
  if (key === 'position_size_eth') return `${v} ETH`;
  if (key.includes('percent') || key.includes('confidence')) return `${v}`;
  return String(v);
}

export function modeKeyboard() {
  const current = tradingMode();
  const btn = (m, label) => ({ text: `${current === m ? '▶️ ' : ''}${label}`, callback_data: `mode:set:${m}` });
  return {
    inline_keyboard: [
      [btn('dry_run', 'dry_run'), btn('confirm', 'confirm'), btn('live', 'live')],
      [{ text: '⬅️ Menu', callback_data: 'menu:main' }],
    ],
  };
}

export function pendingEditKeyboard(state) {
  const rows = [];
  if (state?.type === 'bool') {
    rows.push([
      { text: '✅ on', callback_data: `strat:bool:${state.strategyId}:${state.field}:1` },
      { text: '❌ off', callback_data: `strat:bool:${state.strategyId}:${state.field}:0` },
    ]);
  } else if (state?.type === 'enum' && state.options) {
    rows.push(state.options.map((o) => ({ text: o, callback_data: `strat:enum:${state.strategyId}:${state.field}:${o}` })));
  }
  rows.push([
    { text: '⬅️ Back', callback_data: `strat:pick:${state?.strategyId || 'sniper'}` },
  ]);
  return { inline_keyboard: rows };
}
