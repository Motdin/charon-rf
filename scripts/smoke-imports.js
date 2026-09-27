/**
 * Runtime import test — catches missing exports / broken ESM graph
 * that `node --check` cannot see. Run as part of QC.
 */
const modules = [
  '../src/utils.js',
  '../src/format.js',
  '../src/config.js',
  '../src/db/connection.js',
  '../src/db/settings.js',
  '../src/db/candidates.js',
  '../src/db/positions.js',
  '../src/db/intents.js',
  '../src/enrichment/gmgn.js',
  '../src/enrichment/blockscout.js',
  '../src/enrichment/security.js',
  '../src/enrichment/wallets.js',
  '../src/enrichment/index.js',
  '../src/signals/dexscreener.js',
  '../src/signals/uniswapEvents.js',
  '../src/signals/priceMonitor.js',
  '../src/pipeline/candidateBuilder.js',
  '../src/pipeline/llm.js',
  '../src/pipeline/orchestrator.js',
  '../src/execution/helpers.js',
  '../src/execution/positions.js',
  '../src/execution/router.js',
  '../src/telegram/format.js',
  '../src/telegram/menu.js',
  '../src/telegram/send.js',
  '../src/liveExecutor.js',
];

let failed = 0;
for (const m of modules) {
  try {
    await import(m);
    console.log(`  ok ${m}`);
  } catch (err) {
    console.log(`  FAIL ${m}\n    ${err.message}`);
    failed++;
  }
}

// Spot-check critical exports exist
const checks = [
  ['../src/db/settings.js', ['activeStrategy', 'updateStrategyConfig', 'allStrategies', 'setActiveStrategy']],
  ['../src/enrichment/security.js', ['checkTokenSecurity', 'summarizeSecurity']],
  ['../src/enrichment/wallets.js', ['addSavedWallet', 'listSavedWallets', 'fetchSmartMoneyReport', 'evaluateSmartMoney']],
  ['../src/telegram/menu.js', ['handleStratSet', 'setPendingEdit', 'applyPendingEdit', 'STRATEGY_FIELDS']],
  ['../src/pipeline/orchestrator.js', ['processCandidateFromSignals', 'handleApprovedBuy']],
  ['../src/execution/positions.js', ['monitorPositions', 'refreshPosition', 'startPositionMonitor']],
];

console.log('\n── export spot-check ──');
for (const [mod, names] of checks) {
  const ns = await import(mod);
  for (const n of names) {
    if (ns[n] === undefined) {
      console.log(`  FAIL ${mod} missing export ${n}`);
      failed++;
    }
  }
  console.log(`  ok ${mod} exports ${names.length}`);
}

if (failed) {
  console.log(`\nIMPORT QC FAILED (${failed})`);
  process.exit(1);
}
console.log('\nIMPORT QC PASSED');
