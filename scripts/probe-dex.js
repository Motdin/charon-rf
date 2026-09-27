/**
 * Live signal probe — one DexScreener call for Robinhood Chain pairs.
 * Usage: node scripts/probe-dex.js
 */
import { fetchDexPair, pollDexScreenerOnce, trending, volumeSpikes, newPools } from '../src/signals/dexscreener.js';
import { initDb } from '../src/db/connection.js';

initDb();

console.log('— probe DexScreener (robinhood chain) —');
await pollDexScreenerOnce();

console.log(`trending snapshot size: ${trending.size}`);
console.log(`volume spikes: ${volumeSpikes.size}`);
console.log(`new pools: ${newPools.size}`);

const sample = [...trending.values()].slice(0, 5);
for (const s of sample) {
  console.log(
    `  ${s.symbol || s.mint.slice(0, 10)}… mcap=$${Number(s.market_cap || 0).toFixed(0)} liq=$${Number(s.liquidity || 0).toFixed(0)} vol24h=$${Number(s.volume || 0).toFixed(0)} age=${s.ageMs ? Math.round(s.ageMs / 60000) + 'm' : '?'}`
  );
}

if (sample[0]) {
  const refreshed = await fetchDexPair(sample[0].mint);
  console.log('refresh ok:', refreshed ? refreshed.symbol : 'null');
}

console.log('PROBE DONE');
process.exit(0);
