import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, APP_NAME, GMGN_ENABLED, GMGN_API_KEY } from '../config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionById, allPositions, closedPositions, openPositions, tradingMode } from '../db/positions.js';
import { db } from '../db/connection.js';
import { intentById, pendingIntents, updateIntentStatus } from '../db/intents.js';
import { activeStrategy, allStrategies, strategyById, setActiveStrategy, updateStrategyConfig, numSetting, setSetting, boolSetting } from '../db/settings.js';
import { candidateSummary, positionSummary } from './format.js';
import { escapeHtml, fmtEth, fmtPct, fmtUsd, short, now } from '../utils.js';
import { executeConfirmedIntent, rejectIntent } from '../execution/router.js';
import { gmgnWeightStatus } from '../enrichment/gmgn.js';
import { addSavedWallet, removeSavedWallet, listSavedWallets } from '../enrichment/wallets.js';
import { checkTokenSecurity, summarizeSecurity } from '../enrichment/security.js';
import {
  handleStratSet,
  formatStrategyCard,
  formatFieldEditor,
  mainMenuKeyboard,
  strategyListKeyboard,
  strategyEditorKeyboard,
  modeKeyboard,
  pendingEditKeyboard,
  setPendingEdit,
  getPendingEdit,
  clearPendingEdit,
  hasPendingEdit,
  applyPendingEdit,
  toggleBoolField,
  promptForPendingEdit,
  STRATEGY_FIELDS,
} from './menu.js';

let bot = null;
let sendImpl = null;

export function getBot() {
  return bot;
}

export async function sendTelegram(html) {
  if (sendImpl) return sendImpl(html);
  if (!bot) return null;
  try {
    return await bot.sendMessage(TELEGRAM_CHAT_ID, html, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    const code = err?.response?.body?.error_code || '';
    const desc = err?.response?.body?.description || err.message;
    if (/chat not found/i.test(desc)) {
      console.log(`[tg] send failed: chat not found — TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID} salah. Jalankan: npm run tg-diag`);
    } else if (/bot was blocked|kicked|not a member/i.test(desc)) {
      console.log(`[tg] send failed: bot diblokir/keluar dari chat — unblock/bot ke grup, lalu tg-diag`);
    } else {
      console.log(`[tg] send failed: ${code ? code + ' ' : ''}${desc}`);
    }
    return null;
  }
}

export function setSendImpl(fn) {
  sendImpl = fn;
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const lines = [
    `🧪 <b>Batch #${batchId}</b> screened ${rows.length} · verdict <b>${decision.verdict}</b> (conf ${decision.confidence})`,
    decision.reason ? escapeHtml(decision.reason) : '',
  ];
  await sendTelegram(lines.filter(Boolean).join('\n'));
}

export async function sendPositionOpen(positionId) {
  const position = positionById(positionId);
  if (!position) return;
  await sendTelegram(`🟢 <b>Position opened</b>\n\n${positionSummary(position)}`);
}

export async function sendPositionExit(position) {
  const pnl = Number(position.pnl_percent ?? position.pnlPercent ?? 0);
  const emoji = pnl >= 0 ? '✅' : '🔻';
  await sendTelegram(`${emoji} <b>Position closed</b> ${position.exit_reason || ''}\n\n${positionSummary(position)}`);
}

export async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram(
    [
      `🟡 <b>Trade intent #${intentId}</b> — awaiting confirmation`,
      '',
      candidateSummary(candidate, decision),
      '',
      `Reply with buttons below, or /confirm ${intentId} / /reject ${intentId}`,
    ].join('\n')
  );
  // Note: inline keyboard is wired in startTelegramBot via callback handlers.
  if (bot) {
    try {
      await bot.sendMessage(
        TELEGRAM_CHAT_ID,
        `Intent #${intentId}: approve live buy?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `intent_approve:${intentId}` },
                { text: '❌ Reject', callback_data: `intent_reject:${intentId}` },
              ],
            ],
          },
        }
      );
    } catch (err) {
      console.log(`[tg] intent keyboard: ${err.message}`);
    }
  }
}

function helpText() {
  return [
    `<b>${APP_NAME}</b> — trench agent on Robinhood Chain`,
    '',
    '/menu — interactive settings (Strategy, Mode, Status…)',
    '/status — mode + strategy + positions',
    '/strategy — list strategies',
    '/strategy &lt;id&gt; — activate strategy',
    '/stratset &lt;id&gt; &lt;key&gt; &lt;value&gt; — hot-edit strategy param',
    '/positions — open + recent closed',
    '/pnl — simple PnL summary',
    '/pnlcard [YYYY-MM-DD] — shareable daily PnL card (PNG for X)',
    '/pnlcard text [YYYY-MM-DD] — text card ready to copy to X',
    '/wallets — list tracked smart wallets',
    '/walletadd &lt;label&gt; &lt;0x…&gt; — track a wallet',
    '/walletremove &lt;label|0x…&gt; — stop tracking',
    '/security &lt;0x mint&gt; — run rug/honeypot check',
    '/filters — active strategy thresholds',
    '/confirm &lt;intent_id&gt; — approve pending intent',
    '/reject &lt;intent_id&gt; — reject pending intent',
    '/intents — pending trade intents',
    '/mode dry_run|confirm|live — switch trading mode',
    '/enable on|off — toggle agent auto-buy',
  ].join('\n');
}

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

function resolvePythonCandidates() {
  const list = [];
  if (process.env.PYTHON) list.push(process.env.PYTHON);
  if (process.env.MIMO_PYTHON) list.push(process.env.MIMO_PYTHON);
  list.push('python3', '/usr/bin/python3', '/usr/local/bin/python3', 'python');
  return [...new Set(list)];
}

/**
 * Cari python yang benar-benar bisa import PIL.
 * Return { cmd, version } atau { error, kind: 'NO_PYTHON' | 'NO_PIL' | 'OTHER' }
 */
async function probePython() {
  const tried = [];
  for (const cmd of resolvePythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(cmd, ['-c', 'import PIL; print(PIL.__version__)'], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      return { cmd, version: stdout.trim() };
    } catch (err) {
      const msg = String(err.message || err);
      tried.push(`${cmd}: ${msg.split('\n')[0].slice(0, 80)}`);
      if (/ENOENT|not recognized|command not found/i.test(msg)) continue;
      // Python ada tapi PIL tidak — stop, ini masalahnya
      if (/No module named/i.test(msg) && /PIL|Pillow/i.test(msg)) {
        return { error: msg, kind: 'NO_PIL', cmd, tried };
      }
    }
  }
  return { error: tried.join(' | '), kind: 'NO_PYTHON', tried };
}

function parseDateArg(args) {
  // /pnlcard [text] [YYYY-MM-DD]
  const rest = args.filter((a) => a.toLowerCase() !== 'text');
  const date = rest.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  return date || new Date().toISOString().slice(0, 10);
}

function dayRangeMs(dateStr) {
  const start = Date.parse(`${dateStr}T00:00:00.000Z`);
  return [start, start + 24 * 3600_000];
}

/**
 * Text PnL card — pure Node, no Python required.
 */
export function buildTextPnlCard(dateStr) {
  const [startMs, endMs] = dayRangeMs(dateStr);
  const rows = db
    .prepare(
      `SELECT id, symbol, mint, pnl_percent, pnl_eth, exit_reason, strategy_id, execution_mode
       FROM dry_run_positions
       WHERE status = 'closed' AND closed_at_ms IS NOT NULL AND closed_at_ms >= ? AND closed_at_ms < ?
       ORDER BY closed_at_ms ASC`
    )
    .all(startMs, endMs);
  const openCount = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status = 'open'").get().c;

  const wins = rows.filter((r) => Number(r.pnl_percent || 0) > 0);
  const losses = rows.filter((r) => Number(r.pnl_percent || 0) <= 0);
  const netPct = rows.reduce((a, r) => a + Number(r.pnl_percent || 0), 0);
  const netEth = rows.reduce((a, r) => a + Number(r.pnl_eth || 0), 0);
  const winRate = rows.length ? (wins.length / rows.length) * 100 : 0;
  const best = rows.length
    ? rows.reduce((a, b) => (Number(b.pnl_percent || 0) > Number(a.pnl_percent || 0) ? b : a))
    : null;
  const worst = rows.length
    ? rows.reduce((a, b) => (Number(b.pnl_percent || 0) < Number(a.pnl_percent || 0) ? b : a))
    : null;
  const strategies = [...new Set(rows.map((r) => r.strategy_id).filter(Boolean))];
  const modes = [...new Set(rows.map((r) => r.execution_mode).filter(Boolean))];
  const fmtPct = (v) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
  const fmtEth = (v) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(4)} ETH`;
  const emoji = netPct >= 0 ? '🟢' : '🔴';

  return [
    `${emoji} ${dateStr} · CHARON-RH`,
    `Net PnL: ${fmtPct(netPct)} (${fmtEth(netEth)})`,
    `Win rate: ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)`,
    `Trades: ${rows.length}  ·  Open: ${openCount}`,
    best?.symbol ? `Best: ${best.symbol} ${fmtPct(best.pnl_percent)}` : 'Best: —',
    worst?.symbol ? `Worst: ${worst.symbol} ${fmtPct(worst.pnl_percent)}` : 'Worst: —',
    strategies.length ? `Strategy: ${strategies.join(', ')}` : '',
    modes.length ? `Mode: ${modes.join(', ')}` : '',
    '',
    'not financial advice · dry-run first',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * PNG PnL card via scripts/render_pnl_card.py (needs Python + Pillow).
 */
async function generatePnlCardPng({ date, pyCmd }) {
  const dbPath = join(PROJECT_ROOT, process.env.DB_PATH || './charon-rh.sqlite');
  const outDir = join(PROJECT_ROOT, 'tmp');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `pnl_card_${date}.png`);
  const script = join(PROJECT_ROOT, 'scripts', 'render_pnl_card.py');

  const { stdout } = await execFileAsync(pyCmd, [script, '--db', dbPath, '--date', date, '--out', outPath], {
    cwd: PROJECT_ROOT,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });

  const lines = stdout.trim().split('\n');
  let parsed = {};
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    parsed = { ok: true, out: outPath };
  }
  return { ...parsed, outPath: parsed.out || outPath };
}

async function handlePnlCard(chatId, args, bot) {
  const textOnly = args.some((a) => a.toLowerCase() === 'text');
  const date = parseDateArg(args);
  const text = buildTextPnlCard(date);

  // Text card — selalu bisa, tanpa Python
  if (textOnly) {
    await bot.sendMessage(
      chatId,
      `📋 <b>PnL text card</b> — ${escapeHtml(date)}\n\n<pre>${escapeHtml(text)}</pre>\n\nCopy ke X / Twitter.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // PNG card — butuh Python + Pillow
  const probe = await probePython();
  if (probe.kind === 'NO_PYTHON') {
    await bot.sendMessage(
      chatId,
      [
        '⚠️ <b>Binary python3 tidak ditemukan</b> oleh process bot.',
        '',
        'Di VPS jalankan:',
        '<code>which python3</code>',
        '<code>python3 --version</code>',
        '<code>apt install -y python3</code>',
        '',
        'Jika python3 ada tapi PM2 tidak melihatnya, set path eksplisit di .env:',
        '<code>PYTHON=/usr/bin/python3</code>',
        '<code>pm2 restart charon-rh --update-env</code>',
        '',
        `<pre>${escapeHtml(text)}</pre>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (probe.kind === 'NO_PIL') {
    await bot.sendMessage(
      chatId,
      [
        `⚠️ <b>Python ada (${escapeHtml(probe.cmd)}) tapi Pillow tidak terimport.</b>`,
        '',
        'Install Pillow:',
        '<code>apt install -y python3-pil</code>',
        '<code>python3 -c "from PIL import Image; print(1)"</code>',
        '<code>pm2 restart charon-rh</code>',
        '',
        `Detail: <code>${escapeHtml(String(probe.error).slice(0, 180))}</code>`,
        '',
        `<pre>${escapeHtml(text)}</pre>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  try {
    const result = await generatePnlCardPng({ date, pyCmd: probe.cmd });
    if (!result.outPath || !existsSync(result.outPath)) {
      throw new Error('PNG tidak terbentuk di ' + result.outPath);
    }
    await bot.sendPhoto(chatId, result.outPath, {
      caption: `📊 <b>Daily PnL card</b> — ${escapeHtml(date)}\n\n<pre>${escapeHtml(text)}</pre>\n\nSiap diunggah ke X.`,
      parse_mode: 'HTML',
    });
    try {
      unlinkSync(result.outPath);
    } catch {
      /* ignore */
    }
  } catch (err) {
    const msg = String(err.message || err);
    const realError = msg.replace(/^Command failed:.*?\n?/i, '').split('\n').slice(0, 5).join(' · ');
    await bot.sendMessage(
      chatId,
      [
        `⚠️ <b>Render PNG gagal</b> (python=${escapeHtml(probe.cmd)} Pillow ${escapeHtml(probe.version || '?')})`,
        '',
        `<code>${escapeHtml(realError.slice(0, 300))}</code>`,
        '',
        `<pre>${escapeHtml(text)}</pre>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }
}

export function startTelegramBot() {
  // Lazy import to keep module load light when Telegram is not used in tests
  return import('node-telegram-bot-api').then(async ({ default: TelegramBot }) => {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    bot.on('message', async (msg) => {
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
      const text = (msg.text || '').trim();
      if (!text) return;

      // Interactive pending edit: accept free-text value before command parsing
      if (!text.startsWith('/') && hasPendingEdit(msg.chat.id)) {
        const result = applyPendingEdit(msg.chat.id, text);
        if (result.ok) {
          await bot.sendMessage(
            msg.chat.id,
            `✅ <b>${escapeHtml(result.strategyId)}</b> → <code>${escapeHtml(result.field)}</code> = <b>${escapeHtml(String(result.value))}</b> (was ${escapeHtml(String(result.previous))})\nHot-applied.`,
            { parse_mode: 'HTML', reply_markup: strategyEditorKeyboard(result.strategyId) }
          );
        } else {
          await bot.sendMessage(msg.chat.id, `❌ ${escapeHtml(result.error)}. Try again or /cancel.`, {
            parse_mode: 'HTML',
            reply_markup: pendingEditKeyboard(getPendingEdit(msg.chat.id)),
          });
        }
        return;
      }

      if (!text.startsWith('/')) return;
      const [cmd, ...args] = text.split(/\s+/);

      try {
        switch (cmd) {
          case '/start':
          case '/help':
            await sendTelegram(helpText());
            break;

          case '/menu': {
            const sub = (args[0] || '').toLowerCase();
            if (sub === 'strategy') {
              await bot.sendMessage(msg.chat.id, '<b>Strategies</b> — pick one to edit/activate', {
                parse_mode: 'HTML',
                reply_markup: strategyListKeyboard(),
              });
            } else if (sub === 'mode') {
              await bot.sendMessage(msg.chat.id, `<b>Trading mode</b> — current: <b>${tradingMode()}</b>`, {
                parse_mode: 'HTML',
                reply_markup: modeKeyboard(),
              });
            } else {
              await bot.sendMessage(msg.chat.id, `<b>${APP_NAME} menu</b>`, {
                parse_mode: 'HTML',
                reply_markup: mainMenuKeyboard(),
              });
            }
            break;
          }

          case '/stratset': {
            await handleStratSet(msg.chat.id, args, bot);
            break;
          }

          case '/cancel': {
            if (hasPendingEdit(msg.chat.id)) {
              clearPendingEdit(msg.chat.id);
              await sendTelegram('Edit dibatalkan.');
            } else {
              await sendTelegram('Tidak ada edit yang tertunda.');
            }
            break;
          }

          case '/status': {
            const strat = activeStrategy();
            const opens = openPositions().length;
            const w = gmgnWeightStatus();
            const gmgnLine = w.enabled
              ? `GMGN: weight ${w.spent}/${w.budget} (left ${w.remaining})`
              : 'GMGN: off → DexScreener + Blockscout';
            await sendTelegram(
              [
                `<b>${APP_NAME} status</b>`,
                `Mode: <b>${tradingMode()}</b>`,
                `Strategy: <b>${strat.id}</b> (${strat.name})`,
                `Open positions: ${opens}/${numSetting('max_open_positions', 3)}`,
                `Agent: ${boolSetting('agent_enabled', true) ? 'ON' : 'OFF'}`,
                gmgnLine,
              ].join('\n')
            );
            break;
          }

          case '/strategy': {
            if (!args[0]) {
              const list = allStrategies()
                .map((s) => `${s.enabled ? '▶️' : '▫️'} <b>${s.id}</b> — ${s.name} · TP ${s.tp_percent}% / SL ${s.sl_percent}%`)
                .join('\n');
              await sendTelegram(`<b>Strategies</b>\n\n${list}\n\nActivate: /strategy &lt;id&gt;`);
            } else {
              setActiveStrategy(args[0]);
              await sendTelegram(`Strategy set to <b>${args[0]}</b>`);
            }
            break;
          }

          case '/positions': {
            const open = openPositions();
            const closed = closedPositions(5);
            const lines = ['<b>Open positions</b>'];
            if (!open.length) lines.push('(none)');
            for (const p of open) lines.push(positionSummary(p), '');
            lines.push('<b>Recently closed</b>');
            if (!closed.length) lines.push('(none)');
            for (const p of closed) lines.push(positionSummary(p), '');
            await sendTelegram(lines.join('\n'));
            break;
          }

          case '/pnl': {
            const closed = closedPositions(50);
            let total = 0;
            let wins = 0;
            for (const p of closed) {
              total += Number(p.pnl_eth || 0);
              if (Number(p.pnl_percent || 0) > 0) wins++;
            }
            await sendTelegram(
              [
                '<b>PnL summary</b>',
                `Closed trades: ${closed.length}`,
                `Win rate: ${closed.length ? ((wins / closed.length) * 100).toFixed(1) : 0}%`,
                `Net: ${fmtEth(total)}`,
              ].join('\n')
            );
            break;
          }

          case '/pnlcard': {
            await handlePnlCard(msg.chat.id, args, bot);
            break;
          }

          case '/wallets': {
            const list = listSavedWallets();
            if (!list.length) {
              await sendTelegram(
                'Belum ada wallet yang dilacak.\nTambah: <code>/walletadd mywallet 0x…</code>',
                { parse_mode: 'HTML' }
              );
            } else {
              const lines = list.map((w) => `• <b>${escapeHtml(w.label)}</b> — <code>${escapeHtml(w.address)}</code>`);
              await sendTelegram(`<b>Tracked wallets</b> (${list.length})\n\n${lines.join('\n')}`);
            }
            break;
          }

          case '/walletadd': {
            const [label, addr] = args;
            if (!addr) {
              await sendTelegram('Usage: <code>/walletadd &lt;label&gt; &lt;0x…&gt;</code>', { parse_mode: 'HTML' });
              break;
            }
            try {
              const w = addSavedWallet(label, addr);
              await sendTelegram(`✅ Tracking <b>${escapeHtml(w.label)}</b>\n<code>${escapeHtml(w.address)}</code>`, {
                parse_mode: 'HTML',
              });
            } catch (err) {
              await sendTelegram(`❌ ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
            }
            break;
          }

          case '/walletremove': {
            const key = args[0];
            if (!key) {
              await sendTelegram('Usage: <code>/walletremove &lt;label|0x…&gt;</code>', { parse_mode: 'HTML' });
              break;
            }
            const ok = removeSavedWallet(key);
            await sendTelegram(ok ? `✅ Berhenti tracking <code>${escapeHtml(key)}</code>` : '❌ Tidak ditemukan', {
              parse_mode: 'HTML',
            });
            break;
          }

          case '/security': {
            const mint = args[0];
            if (!mint) {
              await sendTelegram('Usage: <code>/security &lt;0x mint&gt;</code>', { parse_mode: 'HTML' });
              break;
            }
            await sendTelegram('🔍 Memeriksa keamanan…');
            try {
              const report = await checkTokenSecurity(mint);
              const flags = report.findings.map((f) => `• ${escapeHtml(f.detail)}`).join('\n') || '• (tidak ada temuan)';
              await sendTelegram(
                [
                  `<b>Security report</b>`,
                  `Mint: <code>${escapeHtml(mint)}</code>`,
                  `Verdict: <b>${escapeHtml(report.verdict)}</b> · risk ${report.riskScore}`,
                  `Owner: ${report.owner ? `<code>${escapeHtml(report.owner)}</code>` : 'none'}`,
                  `Verified: ${report.verified ? 'yes' : 'no'}`,
                  '',
                  flags,
                ].join('\n'),
                { parse_mode: 'HTML' }
              );
            } catch (err) {
              await sendTelegram(`❌ ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
            }
            break;
          }

          case '/failures': {
            // Kandidat terbaru yang ditolak filter — untuk debug strategi
            const rows = db
              .prepare(
                `SELECT id, mint, status, created_at_ms, filter_result_json, candidate_json
                 FROM candidates
                 WHERE json_extract(filter_result_json, '$.passed') = 0
                 ORDER BY created_at_ms DESC LIMIT 8`
              )
              .all();
            if (!rows.length) {
              await sendTelegram('Belum ada kandidat yang ditolak filter.');
              break;
            }
            const lines = rows.map((r) => {
              const f = JSON.parse(r.filter_result_json || '{}');
              const c = JSON.parse(r.candidate_json || '{}');
              const sym = c.token?.symbol || r.mint.slice(0, 10);
              const age = Math.round((Date.now() - r.created_at_ms) / 60000);
              return `• <b>${escapeHtml(sym)}</b> (${age}m lalu)\n  ${escapeHtml((f.failures || []).slice(0, 3).join('; ') || '—')}`;
            });
            await sendTelegram(
              [`<b>Kandidat ditolak filter</b> (8 terbaru)`, '', ...lines, '', 'Longgarkan via /stratset atau ganti /strategy'].join('\n')
            );
            break;
          }

          case '/filters': {
            const s = activeStrategy();
            await sendTelegram(
              [
                `<b>Filters — ${s.id}</b>`,
                `Sources ≥ ${s.min_source_count}`,
                `Volume spike: ${s.require_volume_spike ? 'required' : 'optional'}`,
                `Mcap: ${fmtUsd(s.min_mcap_usd)} – ${fmtUsd(s.max_mcap_usd)}`,
                `Liq ≥ ${fmtUsd(s.min_liquidity_usd)} · Vol24h ≥ ${fmtUsd(s.min_volume_h24_usd)}`,
                `Holders ≥ ${s.min_holders} · Top10 ≤ ${s.max_top10_holder_percent}%`,
                `Rug ≤ ${s.max_rug_score}`,
                `TP ${s.tp_percent}% / SL ${s.sl_percent}% · Trail ${s.trailing_percent}%`,
                `Size ${s.position_size_eth} ETH · Max pos ${s.max_open_positions}`,
                `LLM: ${s.use_llm ? `on (conf ≥ ${s.llm_min_confidence})` : 'off'}`,
              ].join('\n')
            );
            break;
          }

          case '/intents': {
            const pending = pendingIntents();
            if (!pending.length) await sendTelegram('No pending intents.');
            else {
              const lines = pending.map(
                (i) => `#${i.id} ${escapeHtml(i.mint.slice(0, 12))}… ${i.size_eth} ETH · ${i.status}`
              );
              await sendTelegram(`<b>Pending intents</b>\n\n${lines.join('\n')}\n\n/confirm &lt;id&gt; or /reject &lt;id&gt;`);
            }
            break;
          }

          case '/confirm': {
            const id = Number(args[0]);
            if (!id) return sendTelegram('Usage: /confirm &lt;intent_id&gt;');
            await executeConfirmedIntent(msg.chat.id, id, bot);
            break;
          }

          case '/reject': {
            const id = Number(args[0]);
            if (!id) return sendTelegram('Usage: /reject &lt;intent_id&gt;');
            await rejectIntent(msg.chat.id, id, bot);
            break;
          }

          case '/mode': {
            const mode = args[0];
            if (!['dry_run', 'confirm', 'live'].includes(mode)) {
              return sendTelegram('Usage: /mode dry_run|confirm|live');
            }
            setSetting('trading_mode', mode);
            await sendTelegram(`Trading mode set to <b>${mode}</b>`);
            break;
          }

          case '/enable': {
            const on = args[0] === 'on';
            setSetting('agent_enabled', on ? 'true' : 'false');
            await sendTelegram(`Agent auto-buy <b>${on ? 'ENABLED' : 'DISABLED'}</b>`);
            break;
          }

          default:
            await sendTelegram(helpText());
        }
      } catch (err) {
        await sendTelegram(`Error: ${escapeHtml(err.message)}`);
      }
    });

    bot.on('callback_query', async (query) => {
      if (String(query.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
      const data = query.data || '';
      const chatId = query.message.chat.id;
      try {
        // Trade intents
        if (data.startsWith('intent_approve:') || data.startsWith('intent_reject:')) {
          const [action, idRaw] = data.split(':');
          const id = Number(idRaw);
          if (action === 'intent_approve') await executeConfirmedIntent(chatId, id, bot);
          else await rejectIntent(chatId, id, bot);
          await bot.answerCallbackQuery(query.id);
          return;
        }

        // Main menu
        if (data.startsWith('menu:')) {
          const section = data.slice(5);
          if (section === 'main') {
            await bot.editMessageText(`<b>${APP_NAME} menu</b>`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: mainMenuKeyboard(),
            });
          } else if (section === 'strategy') {
            const list = allStrategies().map(formatStrategyCard).join('\n\n');
            await bot.editMessageText(`<b>Strategies</b>\n\n${list}`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: strategyListKeyboard(),
            });
          } else if (section === 'mode') {
            await bot.editMessageText(`<b>Trading mode</b> — current: <b>${tradingMode()}</b>`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: modeKeyboard(),
            });
          } else if (section === 'agent') {
            const on = !boolSetting('agent_enabled', true);
            setSetting('agent_enabled', on ? 'true' : 'false');
            await bot.editMessageText(`Agent auto-buy <b>${on ? 'ENABLED' : 'DISABLED'}</b>`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: mainMenuKeyboard(),
            });
          } else if (section === 'status' || section === 'filters' || section === 'positions' || section === 'pnl') {
            // Reuse text command handlers via a synthetic message
            const fake = { chat: { id: chatId }, text: `/${section}` };
            // Simpler: reply a fresh message then bounce back
            await bot.answerCallbackQuery(query.id);
            if (section === 'status') {
              const strat = activeStrategy();
              const w = gmgnWeightStatus();
              await bot.sendMessage(
                chatId,
                [
                  `<b>${APP_NAME} status</b>`,
                  `Mode: <b>${tradingMode()}</b>`,
                  `Strategy: <b>${strat.id}</b>`,
                  `Open: ${openPositions().length}/${numSetting('max_open_positions', 3)}`,
                  w.enabled ? `GMGN weight ${w.spent}/${w.budget}` : 'GMGN off',
                ].join('\n'),
                { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
              );
            } else if (section === 'filters') {
              const s = activeStrategy();
              await bot.sendMessage(chatId, formatStrategyCard(s), {
                parse_mode: 'HTML',
                reply_markup: strategyEditorKeyboard(s.id),
              });
            } else if (section === 'positions') {
              const open = openPositions();
              const lines = open.length ? open.map(positionSummary) : ['(none)'];
              await bot.sendMessage(chatId, `<b>Open positions</b>\n\n${lines.join('\n\n')}`, {
                parse_mode: 'HTML',
                reply_markup: mainMenuKeyboard(),
              });
            } else {
              await bot.sendMessage(chatId, 'Use /pnl for full summary', {
                parse_mode: 'HTML',
                reply_markup: mainMenuKeyboard(),
              });
            }
            return;
          }
          await bot.answerCallbackQuery(query.id);
          return;
        }

        // Strategy picker / editor / activate / mode set
        if (data.startsWith('strat:') || data.startsWith('mode:')) {
          const parts = data.split(':');
          if (parts[0] === 'strat' && parts[1] === 'pick') {
            const id = parts[2];
            const s = strategyById(id);
            await bot.editMessageText(formatStrategyCard(s || { id }), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: strategyEditorKeyboard(id),
            });
          } else if (parts[0] === 'strat' && parts[1] === 'edit') {
            const id = parts[2];
            const key = parts[3];
            const meta = STRATEGY_FIELDS[key];
            // Bool fields toggle instantly — no typing needed
            if (meta?.type === 'bool') {
              const toggled = toggleBoolField(id, key);
              if (toggled) {
                await bot.editMessageText(
                  `${formatStrategyCard(strategyById(id))}\n\n✅ <code>${escapeHtml(key)}</code> = <b>${toggled.value}</b>`,
                  {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: strategyEditorKeyboard(id),
                  }
                );
              }
            } else {
              // Numeric / enum → prompt for free-text value
              const pendingState = setPendingEdit(chatId, id, key);
              await bot.editMessageText(formatFieldEditor(id, key), {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: pendingEditKeyboard(pendingState),
              });
              await bot.sendMessage(chatId, promptForPendingEdit(pendingState), {
                parse_mode: 'HTML',
                reply_markup: pendingEditKeyboard(pendingState),
              });
            }
          } else if (parts[0] === 'strat' && parts[1] === 'bool') {
            // strat:bool:<id>:<field>:<0|1>
            const id = parts[2];
            const key = parts[3];
            const val = parts[4] === '1';
            const strat = strategyById(id);
            const next = { ...strat };
            delete next.id;
            delete next.name;
            next[key] = val;
            updateStrategyConfig(id, next);
            clearPendingEdit(chatId);
            await bot.editMessageText(`${formatStrategyCard(strategyById(id))}\n\n✅ <code>${escapeHtml(key)}</code> = <b>${val}</b>`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: strategyEditorKeyboard(id),
            });
          } else if (parts[0] === 'strat' && parts[1] === 'enum') {
            // strat:enum:<id>:<field>:<value>
            const id = parts[2];
            const key = parts[3];
            const val = parts.slice(4).join(':');
            const result = applyPendingEdit(chatId, val);
            // enum callback can also apply directly without pending
            if (!result.ok) {
              const strat = strategyById(id);
              const next = { ...strat };
              delete next.id;
              delete next.name;
              next[key] = val;
              updateStrategyConfig(id, next);
            }
            clearPendingEdit(chatId);
            await bot.editMessageText(
              `${formatStrategyCard(strategyById(id))}\n\n✅ <code>${escapeHtml(key)}</code> = <b>${escapeHtml(val)}</b>`,
              {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: strategyEditorKeyboard(id),
              }
            );
          } else if (parts[0] === 'strat' && parts[1] === 'activate') {
            const id = parts[2];
            setActiveStrategy(id);
            await bot.editMessageText(`✅ Strategy <b>${escapeHtml(id)}</b> activated\n\n${formatStrategyCard(strategyById(id))}`, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: strategyEditorKeyboard(id),
            });
          } else if (parts[0] === 'mode' && parts[1] === 'set') {
            const mode = parts[2];
            if (['dry_run', 'confirm', 'live'].includes(mode)) {
              setSetting('trading_mode', mode);
              await bot.editMessageText(`Trading mode set to <b>${mode}</b>`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: modeKeyboard(),
              });
            }
          }
          await bot.answerCallbackQuery(query.id);
          return;
        }

        await bot.answerCallbackQuery(query.id);
      } catch (err) {
        console.log(`[tg] callback error: ${err.message}`);
        try {
          await bot.answerCallbackQuery(query.id, { text: err.message.slice(0, 60) });
        } catch {
          /* ignore */
        }
      }
    });

    bot.on('polling_error', (err) => console.log(`[tg] polling error: ${err.message}`));

    await sendTelegram(`🟢 <b>${APP_NAME}</b> online · mode <b>${tradingMode()}</b> · strategy <b>${activeStrategy().id}</b>`);
    console.log('[tg] bot started');
    return bot;
  });
}
