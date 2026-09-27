import { pendingPriceAlerts, triggerPriceAlert } from '../db/candidates.js';
import { fetchDexPair } from './dexscreener.js';
import { now, toNumber } from '../utils.js';
import { activeStrategy } from '../db/settings.js';

/**
 * Price alert monitor — powers the dip_buy strategy.
 * Stores target ATH-distance alerts and triggers candidates when hit.
 */

let candidateHandler = null;

export function setPriceAlertHandler(fn) {
  candidateHandler = fn;
}

export async function checkPriceAlertsOnce() {
  const alerts = pendingPriceAlerts();
  for (const alert of alerts) {
    const mint = alert.mint;
    const signal = await fetchDexPair(mint);
    if (!signal) continue;

    const price = toNumber(signal.priceUsd);
    const mcap = toNumber(signal.market_cap);
    let hit = false;

    if (alert.alert_type === 'dip_target' && alert.target_price_usd && price > 0) {
      // Price has dropped to or below target
      if (price <= alert.target_price_usd) hit = true;
    }

    if (alert.target_ath_distance_percent != null) {
      // Approximate ATH distance from price change context if available
      const dist = toNumber(signal.priceChange24h);
      if (dist <= alert.target_ath_distance_percent) hit = true;
    }

    if (hit) {
      triggerPriceAlert(alert.id);
      console.log(`[price] alert ${alert.id} hit for ${mint.slice(0, 10)}…`);
      if (candidateHandler) {
        await candidateHandler({
          mint,
          route: 'dip_alert',
          signalMeta: {
            hasVolumeSpike: false,
            hasNewPool: false,
            hasTrending: true,
            hasOnchain: false,
            sourceCount: 1,
            sources: ['dip_alert'],
            route: 'dip_alert',
          },
          trendingToken: signal,
          priceAlert: alert,
        });
      }
    }
  }
}

export function startPriceMonitor(intervalMs = 20_000) {
  const loop = async () => {
    try {
      await checkPriceAlertsOnce();
    } catch (err) {
      console.log(`[price] ${err.message}`);
    }
    setTimeout(loop, intervalMs);
  };
  loop();
}

export function armDipAlert(mint, signal, targetAthDistancePercent) {
  // Re-exported convenience; actual store is in db/candidates.js
  return { mint, targetAthDistancePercent, armedAt: now() };
}
