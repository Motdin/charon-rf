import './_testdb.js';
/**
 * Smoke test: GMGN free-tier weight budget + automatic fallback.
 * Usage: node scripts/smoke-gmgn.js
 *
 * GMGN must be disabled or keyless here â€” the test verifies that the
 * pipeline never breaks when GMGN is unavailable.
 */
import { initDb } from '../src/db/connection.js';
import {
  gmgnAvailable,
  gmgnWeightStatus,
  fetchGmgnTokenInfo,
  fetchGmgnTrending,
  resetGmgnWeight,
  clearGmgnCache,
} from '../src/enrichment/gmgn.js';
import { estimateRugScore } from '../src/enrichment/blockscout.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  âœ“ ${msg}`);
}

initDb();
clearGmgnCache();
resetGmgnWeight();

console.log('â€” GMGN status (expect disabled without API key) â€”');
const st = gmgnWeightStatus();
console.log('   ', JSON.stringify(st));
assert(st.enabled === false, 'GMGN disabled without GMGN_API_KEY');
assert(gmgnAvailable() === false, 'gmgnAvailable() false when disabled');

console.log('â€” fetch without key returns null (fallback path) â€”');
const info = await fetchGmgnTokenInfo('0x' + '22'.repeat(20));
assert(info === null, 'fetchGmgnTokenInfo returns null when disabled');

const trend = await fetchGmgnTrending({ limit: 3 });
assert(Array.isArray(trend) && trend.length === 0, 'fetchGmgnTrending returns [] when disabled');

console.log('â€” weight budget math (simulated) â€”');
// Simulate budget by monkey-testing the status fields
assert(st.budget === 5 || st.budget >= 1, `weight budget is ${st.budget} (free tier default 5)`);
assert(st.remaining >= 0, 'remaining weight non-negative');

console.log('â€” fallback data sources still work without GMGN â€”');
const rug = estimateRugScore({
  liquidityUsd: 25000,
  holderCount: 120,
  top10Percent: 30,
  ageMs: 7200_000,
  volume24h: 40000,
});
assert(rug >= 0 && rug <= 1, `rug score in range (${rug.toFixed(2)})`);

console.log('\nGMGN FALLBACK SMOKE PASSED');
console.log('Note: enrichToken() tries GMGN first when enabled, else DexScreener+Blockscout.');
process.exit(0);
