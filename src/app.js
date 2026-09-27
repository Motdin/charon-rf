import { validateConfig, APP_NAME, CHAIN_ID, RPC_URL, GMGN_ENABLED, GMGN_API_KEY } from './config.js';
import { initDb } from './db/connection.js';
import { tradingMode } from './db/positions.js';
import { activeStrategy, numSetting } from './db/settings.js';
import { startDexScreenerPolling, setCandidateHandler } from './signals/dexscreener.js';
import { startOnchainPolling, setOnchainCandidateHandler } from './signals/uniswapEvents.js';
import { startPriceMonitor, setPriceAlertHandler } from './signals/priceMonitor.js';
import { processCandidateFromSignals } from './pipeline/orchestrator.js';
import { startPositionMonitor } from './execution/positions.js';
import { startTelegramBot } from './telegram/send.js';
import { gmgnWeightStatus } from './enrichment/gmgn.js';

/**
 * Charon-RH bootstrap.
 *
 * Pipeline:
 *   DexScreener poll  ─┐
 *   Uniswap on-chain  ─┼─→ overlap gate → enrich → filter → LLM batch → execute
 *   Price alerts      ─┘                                              ↓
 *                                                          position monitor (TP/SL/trailing)
 */

export async function startCharon() {
  validateConfig();
  initDb();

  const strat = activeStrategy();
  console.log(`[${APP_NAME}] starting on chain ${CHAIN_ID} via ${RPC_URL}`);
  console.log(`[${APP_NAME}] trading mode: ${tradingMode()}`);
  console.log(`[${APP_NAME}] strategy: ${strat.id} (${strat.name})`);
  console.log(
    `[${APP_NAME}] position size ${strat.position_size_eth} ETH · max ${strat.max_open_positions} · TP ${strat.tp_percent}% / SL ${strat.sl_percent}%`
  );

  // Enrichment source status
  const w = gmgnWeightStatus();
  if (w.enabled) {
    console.log(
      `[${APP_NAME}] GMGN primary enrichment ON (chain=${process.env.GMGN_CHAIN || 'robinhood'}) · weight budget ${w.budget}/window ${Math.round(w.windowMs / 1000)}s · fallback DexScreener+Blockscout`
    );
  } else {
    console.log(`[${APP_NAME}] GMGN off — enrichment via DexScreener + Blockscout only`);
  }

  // Wire signal handlers into the orchestrator
  setCandidateHandler(processCandidateFromSignals);
  setOnchainCandidateHandler(processCandidateFromSignals);
  setPriceAlertHandler(processCandidateFromSignals);

  // Start collectors + monitors
  startDexScreenerPolling();
  startOnchainPolling();
  startPriceMonitor(20_000);
  startPositionMonitor(numSetting('position_check_ms', 10_000));

  // Telegram control plane
  await startTelegramBot();

  console.log(`[${APP_NAME}] ready — waiting for overlap signals…`);
}
