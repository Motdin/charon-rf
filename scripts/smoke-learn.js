/**
 * Smoke: learning loop (rule-based path, LLM off).
 * Usage: node scripts/smoke-learn.js
 */
import './_testdb.js';
import { initDb } from '../src/db/connection.js';
import {
  parseWindow,
  collectClosedTrades,
  summarizeTrades,
  generateLessons,
  storeLessons,
  listLessons,
  archiveLesson,
  deleteLesson,
  formatLearnReport,
} from '../src/learning/lessons.js';
import { activeLessonsForPrompt } from '../src/pipeline/llm.js';
import { createDryRunPosition, closePosition } from '../src/db/positions.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

initDb();

console.log('— parseWindow —');
assert(parseWindow('24h').windowMs === 86400000, '24h ok');
assert(parseWindow('1h').windowMs === 3600000, '1h ok');
assert(parseWindow('7d').windowMs === 7 * 86400000, '7d ok');
assert(parseWindow('bogus').label === '24h', 'fallback 24h');

console.log('— seed 5 closed trades —');
const mk = (sym, pnl) => {
  const id = createDryRunPosition(1, {
    token: { mint: '0x' + Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40) + '0', symbol: sym, name: sym },
    metrics: { priceUsd: 0.001, marketCapUsd: 10000 },
  }, { verdict: 'BUY', confidence: 80 }, 't');
  closePosition({
    id,
    exitPrice: 0.001 * (1 + pnl / 100),
    exitMcap: 10000 * (1 + pnl / 100),
    exitReason: pnl > 0 ? 'TP' : 'SL',
    pnlPercent: pnl,
    pnlEth: 0.02 * pnl / 100,
  });
  return id;
};
for (const [s, p] of [['A', 20], ['B', -30], ['C', -35], ['D', 10], ['E', -28]]) mk(s, p);

const trades = collectClosedTrades(24 * 3600_000);
assert(trades.length >= 5, `collected ${trades.length} trades`);

console.log('— summarize —');
const sum = summarizeTrades(trades);
assert(sum.count >= 5, `summary count ${sum.count}`);
assert(sum.winRate > 0 && sum.winRate < 100, `win rate ${sum.winRate.toFixed(1)}%`);

console.log('— generateLessons (LLM off → rules) —');
const result = await generateLessons(trades);
assert(result.lessons.length >= 1, `got ${result.lessons.length} lessons via ${result.source}`);
assert(result.lessons[0].lesson.length > 10, 'lesson has text');

console.log('— store + list + inject into LLM prompt —');
const ids = storeLessons(result.lessons, { test: true });
assert(ids.length === result.lessons.length, `stored ${ids.length}`);
const active = listLessons('active');
assert(active.length >= ids.length, `listed ${active.length} active`);
const promptLessons = activeLessonsForPrompt(6);
assert(promptLessons.length >= 1, `LLM prompt will see ${promptLessons.length} lessons`);

console.log('— archive / delete —');
assert(archiveLesson(ids[0]) === true, 'archive ok');
assert(deleteLesson(ids[ids.length - 1]) === true, 'delete ok');

console.log('— report format —');
const report = formatLearnReport(result, '24h');
assert(report.includes('Learn report'), 'report renders');

console.log('\nLEARNING SMOKE PASSED');
process.exit(0);
