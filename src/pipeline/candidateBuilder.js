import { enrichToken, compactForLlm } from '../enrichment/index.js';
import { activeStrategy } from '../db/settings.js';
import { now, toNumber, normalizeAddress } from '../utils.js';

/**
 * Build a full candidate object and run strategy filters.
 * Mirrors Charon's candidateBuilder, adapted for EVM/Robinhood metrics.
 */

/**
 * Default keras anti wash-volume (insiden #33: vol24h $2.27M vs liq $18k = 126×).
 * Turnover organik meme umumnya 1–25×; >50× hampir pasti volume palsu yang
 * sengaja memicu sinyal volume_spike+trending.
 * Ditimpa per-strategi: /stratset <id> max_volume_liquidity_ratio <n> (0 = mati).
 */
export const DEFAULT_MAX_VOLUME_LIQ_RATIO = 50;

export function signalLabel(meta = {}) {
  return [
    meta.hasVolumeSpike ? 'volume' : null,
    meta.hasNewPool ? 'new' : null,
    meta.hasTrending ? 'trending' : null,
    meta.hasOnchain ? 'onchain' : null,
    meta.hasLaunchpad ? 'pons' : null,
    meta.hasGraduated ? 'graduated' : null,
  ]
    .filter(Boolean)
    .join('+') || meta.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const m = candidate.metrics;
  const meta = candidate.signals;

  const mcap = toNumber(m.marketCapUsd);
  const liq = toNumber(m.liquidityUsd);
  const vol24 = toNumber(m.volume24hUsd);
  const txns = toNumber(m.txns24h);
  const holders = toNumber(m.holderCount);
  const top10 = toNumber(m.top10Percent);
  const ageMs = m.poolAgeMs;
  const rug = toNumber(m.rugScore);
  const sourceCount = toNumber(meta.sourceCount);

  // Source count / overlap
  if (strat.min_source_count > 0 && sourceCount < strat.min_source_count) {
    failures.push(`sources: ${sourceCount} < min ${strat.min_source_count}`);
  }

  // Volume spike requirement (Charon's fee-claim proxy)
  if (strat.require_volume_spike && !meta.hasVolumeSpike) {
    failures.push('volume spike: required by strategy');
  }

  // Pool age
  if (strat.pool_age_max_ms > 0 && ageMs != null && ageMs > strat.pool_age_max_ms) {
    failures.push(`pool age: ${Math.round(ageMs / 60000)}m > max ${Math.round(strat.pool_age_max_ms / 60000)}m`);
  }

  // Market cap
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap <= 0 || mcap < strat.min_mcap_usd)) {
    failures.push(`mcap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`mcap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // Liquidity
  if (strat.min_liquidity_usd > 0 && liq < strat.min_liquidity_usd) {
    failures.push(`liquidity: ${liq} < ${strat.min_liquidity_usd}`);
  }

  // Volume
  // Volume / txn — skip jika token terlalu muda (launchpad baru, belum ada data aggregator)
  const isFresh = ageMs != null && ageMs < 30 * 60_000;
  if (!isFresh) {
    if (strat.min_volume_h24_usd > 0 && vol24 < strat.min_volume_h24_usd) {
      failures.push(`volume24h: ${vol24} < ${strat.min_volume_h24_usd}`);
    }
    if (strat.min_txns_h24 > 0 && txns < strat.min_txns_h24) {
      failures.push(`txns24h: ${txns} < ${strat.min_txns_h24}`);
    }
    if (strat.trending_min_volume_usd > 0 && vol24 < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${vol24} < ${strat.trending_min_volume_usd}`);
    }
  }

  // Wash-volume guard — SENGAJA di luar blok isFresh: trap seperti insiden #33
  // justru pool muda dengan volume palsu raksasa. Melihat RATIO, bukan minimum.
  const maxVlr = strat.max_volume_liquidity_ratio ?? DEFAULT_MAX_VOLUME_LIQ_RATIO;
  if (maxVlr > 0 && vol24 > 0 && liq > 0) {
    const vlr = vol24 / liq;
    if (vlr > maxVlr) {
      failures.push(`volume/liquidity: ${vlr.toFixed(0)}× > max ${maxVlr}× — anomali wash trading`);
    }
  }

  // Holders
  if (strat.min_holders > 0 && holders < strat.min_holders) {
    failures.push(`holders: ${holders} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top10_holder_percent < 100 && Number.isFinite(top10) && top10 > strat.max_top10_holder_percent) {
    failures.push(`top10 holders: ${top10.toFixed(1)}% > ${strat.max_top10_holder_percent}%`);
  }

  // ATH distance (dip buy)
  if (strat.max_ath_distance_pct < 0) {
    const dist = m.priceChange24h; // proxy: large negative 24h change ≈ deep dip
    if (dist != null && dist > strat.max_ath_distance_pct) {
      failures.push(`dip distance: ${dist.toFixed(0)}% not deep enough (need ≤ ${strat.max_ath_distance_pct}%)`);
    }
  }

  // Rug score
  if (strat.max_rug_score > 0 && rug > strat.max_rug_score) {
    failures.push(`rug score: ${rug.toFixed(2)} > ${strat.max_rug_score}`);
  }

  // Security (honeypot / mint authority / unverified).
  // Verdict FAIL = probe transfer TERBUKTI ter-gate → lantai keamanan keras yang
  // berlaku untuk SEMUA strategi, termasuk yang require_security_pass=false
  // (degen sekalipun tidak boleh membeli token yang tidak bisa dijual).
  const sec = m.securityRiskScore;
  const secVerdict = m.securityVerdict;
  if (secVerdict === 'FAIL') {
    failures.push(`security: verdict FAIL (risk ${sec ?? '?'}) — transfer gate terdeteksi`);
  } else if (strat.require_security_pass && secVerdict !== 'PASS') {
    failures.push(`security: verdict ${secVerdict} (strategi mewajibkan PASS)`);
  }
  if (strat.max_security_risk > 0 && Number.isFinite(sec) && sec > strat.max_security_risk) {
    failures.push(`security risk: ${sec} > ${strat.max_security_risk}`);
  }

  // Smart money
  const savedHolders = Number(m.savedWalletHolders || 0);
  const insiderCount = Number(m.insiderCount || 0);
  const sniperShare = Number(m.sniperSharePercent || 0);
  if (strat.min_saved_wallet_holders > 0 && savedHolders < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedHolders} < ${strat.min_saved_wallet_holders}`);
  }
  if (strat.max_insider_count != null && insiderCount > strat.max_insider_count) {
    failures.push(`insiders: ${insiderCount} > ${strat.max_insider_count}`);
  }
  if (strat.max_sniper_share_percent != null && strat.max_sniper_share_percent < 100 && sniperShare > strat.max_sniper_share_percent) {
    failures.push(`sniper share: ${sniperShare}% > ${strat.max_sniper_share_percent}%`);
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, route, signalMeta, trendingToken, volumeSpike, newPool, priceAlert }) {
  const strat = activeStrategy();
  const enriched = await enrichToken(mint);
  const m = enriched.metrics;

  // sourceCount: JANGAN pakai `||` — 0 adalah nilai valid tapi harus dihitung ulang dari flags
  const flagCount = [
    signalMeta?.hasVolumeSpike,
    signalMeta?.hasNewPool,
    signalMeta?.hasTrending,
    signalMeta?.hasOnchain,
    signalMeta?.hasLaunchpad,
    signalMeta?.hasGraduated,
  ].filter(Boolean).length;

  const declared = Number(signalMeta?.sourceCount);
  const sourceCount = Math.max(
    Number.isFinite(declared) ? declared : 0,
    flagCount,
    // kandidat yang sampai ke sini sudah pasti berasal dari minimal satu sumber sinyal
    1
  );

  const signals = {
    route: route || signalMeta?.route || 'unknown',
    label: signalLabel({
      hasVolumeSpike: signalMeta?.hasVolumeSpike,
      hasNewPool: signalMeta?.hasNewPool,
      hasTrending: signalMeta?.hasTrending,
      hasOnchain: signalMeta?.hasOnchain,
      route,
    }),
    hasVolumeSpike: Boolean(signalMeta?.hasVolumeSpike || volumeSpike),
    hasNewPool: Boolean(signalMeta?.hasNewPool || newPool),
    hasTrending: Boolean(signalMeta?.hasTrending || trendingToken),
    hasOnchain: Boolean(signalMeta?.hasOnchain),
    sourceCount,
    sources: signalMeta?.sources || [],
    strategy: strat.id,
  };

  const candidate = {
    token: {
      mint: normalizeAddress(mint),
      name: enriched.meta.name,
      symbol: enriched.meta.symbol,
      url: enriched.meta.url,
      pairAddress: enriched.meta.pairAddress,
      dexId: enriched.meta.dexId,
    },
    metrics: m,
    signals,
    trending: trendingToken || enriched.dex,
    volumeSpike: volumeSpike || enriched.spike,
    newPool: newPool || enriched.poolMeta,
    holders: enriched.holdersData,
    onchain: enriched.onchain,
    priceAlert: priceAlert || null,
    enriched,
    createdAtMs: now(),
  };

  candidate.filters = filterCandidate(candidate);
  return candidate;
}

export { compactForLlm };
