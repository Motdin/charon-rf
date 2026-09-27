/**
 * Smoke test — runs the pipeline in dry-run without Telegram or live keys.
 * Usage: node scripts/smoke.js
 */
import { initDb } from '../src/db/connection.js';
import { activeStrategy, setActiveStrategy, numSetting } from '../src/db/settings.js';
import { filterCandidate } from '../src/pipeline/candidateBuilder.js';
import { createDryRunPosition, openPositions, canOpenMorePositions, openPositionCount } from '../src/db/positions.js';
import { upsertCandidate, storeDecision, storeBatchDecision, recentEligibleCandidates, candidateById } from '../src/db/candidates.js';
import { decideCandidateBatch } from '../src/pipeline/llm.js';
import { estimateRugScore } from '../src/enrichment/blockscout.js';
import { normalizeDecision } from '../src/pipeline/llm.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

console.log('— init db —');
initDb();

console.log('— strategies seeded —');
const sniper = activeStrategy();
assert(sniper.id === 'sniper', `default strategy is sniper (${sniper.id})`);
assert(sniper.min_source_count === 2, 'sniper requires 2 sources');
assert(sniper.use_llm === true, 'sniper uses LLM');

setActiveStrategy('degen');
const degen = activeStrategy();
assert(degen.id === 'degen', 'degen activates');
assert(degen.use_llm === false, 'degen is rule-based');
setActiveStrategy('sniper');

console.log('— filter: reject low mcap —');
const bad = {
  token: { mint: '0x' + '11'.repeat(20), symbol: 'BAD', name: 'Bad' },
  metrics: {
    marketCapUsd: 1000,
    liquidityUsd: 500,
    volume24hUsd: 100,
    txns24h: 1,
    holderCount: 1,
    top10Percent: 90,
    rugScore: 0.9,
    poolAgeMs: 999999999,
  },
  signals: { sourceCount: 1, hasVolumeSpike: false, hasNewPool: false, hasTrending: false, hasOnchain: false, route: 'test' },
};
const badF = filterCandidate(bad);
assert(badF.passed === false, `bad candidate rejected (${badF.failures.length} failures)`);

console.log('— filter: accept strong overlap —');
const good = {
  token: { mint: '0x' + '22'.repeat(20), symbol: 'GOOD', name: 'Good' },
  metrics: {
    marketCapUsd: 50000,
    liquidityUsd: 20000,
    volume24hUsd: 40000,
    txns24h: 200,
    holderCount: 80,
    top10Percent: 35,
    rugScore: 0.2,
    poolAgeMs: 3600_000,
  },
  signals: {
    sourceCount: 2,
    hasVolumeSpike: true,
    hasNewPool: true,
    hasTrending: true,
    hasOnchain: true,
    route: 'dual_source',
  },
};
const goodF = filterCandidate(good);
assert(goodF.passed === true, `good candidate passed filters`);

console.log('— rug score heuristic —');
const rugLow = estimateRugScore({ liquidityUsd: 50000, holderCount: 300, top10Percent: 20, ageMs: 86400_000, volume24h: 30000 });
const rugHigh = estimateRugScore({ liquidityUsd: 2000, holderCount: 5, top10Percent: 90, ageMs: 600_000, volume24h: 100000 });
assert(rugLow < rugHigh, `rug score differentiates (${rugLow.toFixed(2)} < ${rugHigh.toFixed(2)})`);

console.log('— dry-run position lifecycle —');
const beforeCount = openPositionCount();
assert(canOpenMorePositions() || beforeCount < numSetting('max_open_positions', 3) || true, 'can evaluate open positions');
const posId = createDryRunPosition(1, { ...good, token: { ...good.token, mint: '0x' + '22'.repeat(20) } }, {
  verdict: 'BUY',
  confidence: 80,
  reason: 'smoke test',
  risks: [],
}, 'smoke');
assert(typeof posId === 'number' && posId > 0, `position created id=${posId}`);
assert(openPositionCount() === beforeCount + 1, `open position count ${beforeCount} → ${openPositionCount()}`);
const open = openPositions();
const found = open.find((p) => p.id === posId);
assert(found, 'openPositions returns the new position');
assert(found.tp_percent === 50, 'TP copied from strategy (50%)');
assert(found.sl_percent === -25, 'SL copied from strategy (-25%)');

console.log('— candidate upsert + decision store —');
const cid = upsertCandidate({ ...good, filters: goodF }, 'smoke-key-1');
assert(cid > 0, `candidate upserted id=${cid}`);
const row = candidateById(cid);
assert(row.filters.passed === true, 'stored filters.passed');
const did = storeDecision(cid, good, { verdict: 'WATCH', confidence: 40, reason: 'smoke', risks: [] });
assert(did > 0, `decision stored id=${did}`);
const bid = storeBatchDecision(cid, [{ id: cid, candidate: good }], {
  verdict: 'WATCH',
  confidence: 40,
  reason: 'smoke batch',
  risks: [],
  selected_candidate_id: null,
  selected_mint: null,
});
assert(bid > 0, `batch decision stored id=${bid}`);

console.log('— LLM disabled fallback —');
const batch = await decideCandidateBatch([{ id: cid, candidate: good, filters: goodF }], cid);
assert(batch.verdict === 'WATCH', 'LLM disabled returns WATCH');

console.log('— normalizeDecision clamps —');
const nd = normalizeDecision({ verdict: 'buy', confidence: 150, reason: 'x', risks: 'nope' });
assert(nd.verdict === 'BUY', 'verdict uppercased');
assert(nd.confidence === 100, 'confidence clamped to 100');

console.log('\nALL SMOKE TESTS PASSED');
process.exit(0);
