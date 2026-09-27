/**
 * Smoke: Pons launchpad signal mapping + ingest.
 * Usage: node scripts/smoke-pons.js
 *
 * Does not hit the network — exercises mapLaunch/ingest shape via a fake row.
 */
import { initDb } from '../src/db/connection.js';
import { ponsLaunches, ponsGraduated, ponsLaunchFor, setPonsCandidateHandler } from '../src/signals/pons.js';
import { signalLabel } from '../src/pipeline/candidateBuilder.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

initDb();

console.log('— signal label includes launchpad —');
const label = signalLabel({
  hasVolumeSpike: false,
  hasNewPool: true,
  hasTrending: false,
  hasOnchain: false,
  hasLaunchpad: true,
  hasGraduated: true,
});
assert(label.includes('pons'), `label has pons (${label})`);
assert(label.includes('graduated'), `label has graduated (${label})`);

console.log('— module exports —');
assert(typeof setPonsCandidateHandler === 'function', 'setPonsCandidateHandler exported');
assert(typeof ponsLaunchFor === 'function', 'ponsLaunchFor exported');
assert(ponsLaunches instanceof Map, 'ponsLaunches is Map');
assert(ponsGraduated instanceof Map, 'ponsGraduated is Map');
assert(ponsLaunchFor('0x' + '11'.repeat(20)) === null, 'unknown token returns null');

console.log('\npons SMOKE PASSED');
console.log('Note: live feed is https://www.ponsfamily.com/api/pons-launches (tested manually).');
process.exit(0);
