/**
 * Smoke: security (rug/honeypot) + smart-wallet enrichment.
 * Usage: node scripts/smoke-security.js
 */
import { initDb } from '../src/db/connection.js';
import { checkTokenSecurity, clearSecurityCache } from '../src/enrichment/security.js';
import {
  addSavedWallet,
  removeSavedWallet,
  listSavedWallets,
  evaluateSmartMoney,
} from '../src/enrichment/wallets.js';
import { filterCandidate } from '../src/pipeline/candidateBuilder.js';
import { strategyById, updateStrategyConfig, setActiveStrategy } from '../src/db/settings.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

initDb();
clearSecurityCache();

console.log('— saved wallets CRUD —');
const before = listSavedWallets().length;
addSavedWallet('whale1', '0x1111111111111111111111111111111111111111');
addSavedWallet('whale2', '0x2222222222222222222222222222222222222222');
assert(listSavedWallets().length === before + 2, 'added 2 wallets');
const got = listSavedWallets().find((w) => w.label === 'whale1');
assert(got && got.address.startsWith('0x1111'), 'wallet stored lowercase');
removeSavedWallet('whale1');
assert(listSavedWallets().find((w) => w.label === 'whale1') == null, 'wallet removed by label');
removeSavedWallet('0x2222222222222222222222222222222222222222');
assert(listSavedWallets().find((w) => w.address.startsWith('0x2222')) == null, 'wallet removed by address');

console.log('— evaluateSmartMoney filters —');
const report = {
  savedWalletExposure: { holderCount: 0 },
  snipers: { insiderCount: 5, sniperSharePercent: 40 },
};
const strict = evaluateSmartMoney(report, {
  min_saved_wallet_holders: 1,
  max_insider_count: 3,
  max_sniper_share_percent: 30,
});
assert(strict.passed === false, 'strict strategy rejects insider-heavy token');
assert(strict.failures.length === 3, `3 failures listed (${strict.failures.length})`);

const loose = evaluateSmartMoney(report, {
  min_saved_wallet_holders: 0,
  max_insider_count: 99,
  max_sniper_share_percent: 100,
});
assert(loose.passed === true, 'loose strategy passes');

console.log('— security scoring —');
// We can't hit live RPC reliably in smoke; test the local filter integration instead
const baseMetrics = {
  marketCapUsd: 50000,
  liquidityUsd: 20000,
  volume24hUsd: 40000,
  txns24h: 200,
  holderCount: 80,
  top10Percent: 35,
  rugScore: 0.2,
  poolAgeMs: 3600_000,
  securityRiskScore: 0.8,
  securityVerdict: 'FAIL',
  savedWalletHolders: 0,
  insiderCount: 6,
  sniperSharePercent: 45,
};

const cands = {
  token: { mint: '0x' + 'aa'.repeat(20), symbol: 'RUG', name: 'Rug' },
  metrics: baseMetrics,
  signals: {
    sourceCount: 2,
    hasVolumeSpike: true,
    hasNewPool: true,
    hasTrending: true,
    hasOnchain: false,
    route: 'dual_source',
  },
};

const f1 = filterCandidate(cands);
assert(f1.passed === false, 'security FAIL blocks candidate');
assert(f1.failures.some((x) => x.includes('security')), `security failure present: ${f1.failures.find((x) => x.includes('security'))}`);

// Fix security, still insider-blocked
const cands2 = {
  ...cands,
  metrics: { ...baseMetrics, securityVerdict: 'PASS', securityRiskScore: 0.1, insiderCount: 6, sniperSharePercent: 45 },
};
const f2 = filterCandidate(cands2);
assert(f2.passed === false, 'high insiders still blocks');
assert(f2.failures.some((x) => x.includes('insiders') || x.includes('sniper')), 'insider/sniper failure present');

// All good
const cands3 = {
  ...cands,
  metrics: {
    ...baseMetrics,
    securityVerdict: 'PASS',
    securityRiskScore: 0.1,
    insiderCount: 1,
    sniperSharePercent: 15,
    savedWalletHolders: 2,
  },
};
const f3 = filterCandidate(cands3);
assert(f3.passed === true, 'clean security + smart money passes');

console.log('\nSECURITY + SMART MONEY SMOKE PASSED');
process.exit(0);
