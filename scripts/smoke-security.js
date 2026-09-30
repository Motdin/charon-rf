import './_testdb.js';
/**
 * Smoke: security (rug/honeypot) + smart-wallet enrichment.
 * Usage: node scripts/smoke-security.js
 */
import { initDb } from '../src/db/connection.js';
import { checkTokenSecurity, clearSecurityCache, classifyProbeRevert } from '../src/enrichment/security.js';
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

console.log('— transfer-gate probe classifier (insiden #33) —');
const e = (msg) => new Error(msg);
assert(
  classifyProbeRevert(e('The contract function "transfer" reverted. Execution reverted for an unknown reason.')) ===
    'gate_empty',
  'empty revert (signature insiden #33) → gate_empty'
);
assert(classifyProbeRevert(e('ERC20: transfer amount exceeds balance')) === 'balance_check', 'balance msg → balance_check');
assert(
  classifyProbeRevert(e('The contract function reverted with the following error: 0xe450d38c')) === 'balance_check',
  'ERC20InsufficientBalance selector → balance_check'
);
assert(classifyProbeRevert(e('ERC20: insufficient allowance')) === 'allowance_check', 'allowance msg → allowance_check');
assert(
  classifyProbeRevert(e('execution reverted: 0xfb8f41b2')) === 'allowance_check',
  'ERC20InsufficientAllowance selector → allowance_check'
);
assert(classifyProbeRevert(e('panic code 0x11 (Arithmetic operation underflowed)')) === 'panic', 'panic underflow → panic');
assert(classifyProbeRevert(e('Trading is not enabled')) === 'gate_message', 'trading gate → gate_message');
assert(classifyProbeRevert(e('address is blacklisted')) === 'gate_message', 'blacklist msg → gate_message');

console.log('— wash-volume gate (insiden #33: vol $2.27M / liq $18k) —');
const washMetrics = {
  ...baseMetrics,
  securityVerdict: 'PASS',
  securityRiskScore: 0.1,
  insiderCount: 0,
  sniperSharePercent: 0,
  savedWalletHolders: 0,
  liquidityUsd: 18_000,
  volume24hUsd: 2_270_000, // 126× liquidity — persis angka insiden
  holderCount: 380,
  top10Percent: 0,
};
const washCand = { ...cands, metrics: washMetrics };
const fw = filterCandidate(washCand);
assert(fw.passed === false, 'vol/liq 126× rejected (wash trading)');
assert(fw.failures.some((x) => x.includes('volume/liquidity')), `wash reason: ${fw.failures.join('; ')}`);

const healthyRatio = filterCandidate({
  ...cands,
  metrics: { ...washMetrics, volume24hUsd: 90_000 }, // 5× — organik
});
assert(healthyRatio.passed === true, 'vol/liq 5× (organic) passes');

console.log('— security verdict FAIL = hard floor untuk SEMUA strategi —');
const floorCand = {
  ...cands,
  metrics: { ...baseMetrics, securityVerdict: 'FAIL', securityRiskScore: 0.1, insiderCount: 0, sniperSharePercent: 0 },
};
const ff = filterCandidate(floorCand);
assert(ff.passed === false, 'verdict FAIL blocked even with low numeric risk');
assert(ff.failures.some((x) => x.includes('verdict FAIL')), 'hard-floor failure reason present');

console.log('— wash-guard bisa dimatikan per-strategi via config —');
const activeId = 'sniper'; // STRATEGY_META: sniper enabled=1 di DB test
const stratRow = strategyById(activeId);
const cfg = Object.fromEntries(Object.entries(stratRow).filter(([k]) => !['id', 'name', 'enabled'].includes(k)));
cfg.max_volume_liquidity_ratio = 0;
updateStrategyConfig(activeId, cfg);
const fwOff = filterCandidate(washCand);
assert(fwOff.passed === true, 'max_volume_liquidity_ratio=0 disables the wash-guard');
// kembalikan ke config awal (key dihapus → default kode 50 berlaku lagi)
const cfgRestore = Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== 'max_volume_liquidity_ratio'));
updateStrategyConfig(activeId, cfgRestore);
assert(filterCandidate(washCand).passed === false, 'wash-guard active again after restore');

console.log('\nSECURITY + SMART MONEY SMOKE PASSED');
process.exit(0);
