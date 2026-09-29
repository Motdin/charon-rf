import { validateConfig, APP_NAME, CHAIN_ID, RPC_URL, TRADING_MODE } from './config.js';
import { initDb, syncStrategySeeds } from './db/connection.js';
import { tradingMode } from './db/positions.js';
import { activeStrategy, numSetting } from './db/settings.js';
import { preflightLiveExecutor } from './liveExecutor.js';
import { startDexScreenerPolling, setCandidateHandler } from './signals/dexscreener.js';
import { startOnchainPolling, setOnchainCandidateHandler } from './signals/uniswapEvents.js';
import { startPriceMonitor, setPriceAlertHandler } from './signals/priceMonitor.js';
import { startPonsPolling, setPonsCandidateHandler } from './signals/pons.js';
import { processCandidateFromSignals } from './pipeline/orchestrator.js';
import { startPositionMonitor } from './execution/positions.js';
import { startTelegramBot } from './telegram/send.js';
import { gmgnWeightStatus } from './enrichment/gmgn.js';
import { rpcEndpoints } from './lib/rpc.js';

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
  // Sync strategi MATI secara default agar /stratset user tidak ditimpa restart.
  // Paksa migrasi seed baru dengan: FORCE_SYNC_STRATEGIES=1 pm2 restart charon-rh
  syncStrategySeeds();

  // Preflight eksekutor live: semua kontrak router harus BENAR-BENAR ada di chain ini.
  // Insiden sebelumnya: alamat SwapRouter02 mainnet (EOA mati di RH) dipakai —
  // ETH ter-wrap jadi WETH lalu swap gagal total. Sekarang gagal keras saat boot.
  if (TRADING_MODE === 'live' || TRADING_MODE === 'confirm') {
    console.log(`[${APP_NAME}] preflight live executor (${TRADING_MODE})…`);
    const pf = await preflightLiveExecutor({ force: true });
    for (const c of pf.checks) {
      console.log(`  ${c.ok ? '✓' : '✗ MISSING'} ${c.label} ${c.address}`);
    }
    if (!pf.ok) {
      throw new Error(
        `Preflight live gagal — kontrak tidak ditemukan di chain ${CHAIN_ID}: ` +
          pf.missing.map((c) => c.label).join(', ') +
          '. Perbaiki .env Anda (lihat .env.example) sebelum mode live/confirm.'
      );
    }
    console.log(`[${APP_NAME}] preflight OK — semua kontrak eksekusi terverifikasi on-chain`);
  }

  const strat = activeStrategy();
  console.log(`[${APP_NAME}] starting on chain ${CHAIN_ID} via ${RPC_URL}`);
  console.log(`[${APP_NAME}] RPC failover chain: ${rpcEndpoints().join(' → ')}`);
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
  setPonsCandidateHandler(processCandidateFromSignals);

  // Start collectors + monitors
  startDexScreenerPolling();
  startOnchainPolling();
  startPriceMonitor(20_000);
  startPonsPolling();
  startPositionMonitor(numSetting('position_check_ms', 10_000));

  // Telegram control plane
  await startTelegramBot();

  console.log(`[${APP_NAME}] ready — waiting for overlap signals…`);
}
