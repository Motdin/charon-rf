import { fetchDexPair, trending, volumeSpikes, newPools } from '../signals/dexscreener.js';
import { onchainActivity, onchainNewPools } from '../signals/uniswapEvents.js';
import { fetchTokenInfo, fetchHolders, estimateRugScore } from './blockscout.js';
import { fetchGmgnTokenInfo, fetchGmgnHolders, fetchGmgnCandles, summarizeCandles, gmgnAvailable, gmgnWeightStatus } from './gmgn.js';
import { checkTokenSecurity, summarizeSecurity } from './security.js';
import { fetchSmartMoneyReport, fetchSavedWalletExposure, evaluateSmartMoney } from './wallets.js';
import { toNumber, normalizeAddress, firstPositiveNumber, now } from '../utils.js';

/**
 * Aggregated token enrichment with source priority:
 *
 *   1. GMGN OpenAPI          (primary — richest metrics, costs free-tier weight)
 *   2. DexScreener pair      (fallback — free, public)
 *   3. Blockscout            (holders / supply — always available)
 *
 * GMGN failures (disabled, weight exhausted, rate-limit, error) never break
 * the pipeline — we silently degrade to DexScreener + Blockscout.
 */

function mergeMetrics(primary, fallback) {
  // Prefer GMGN values when present; fall back to DexScreener/Blockscout.
  const out = { ...fallback };
  if (!primary) return out;
  for (const key of [
    'priceUsd',
    'marketCapUsd',
    'liquidityUsd',
    'holderCount',
    'volume24hUsd',
    'totalFeeSol',
  ]) {
    const v = firstPositiveNumber(primary[key], fallback[key]);
    if (v != null) out[key] = v;
  }
  return out;
}

export async function enrichToken(mint) {
  const addr = normalizeAddress(mint);

  // Fire the free sources in parallel first so we always have a base.
  const [dex, tokenInfo, holdersData] = await Promise.all([
    trending.get(addr) || fetchDexPair(addr),
    fetchTokenInfo(addr),
    fetchHolders(addr, 25),
  ]);

  // GMGN is primary — try it only if budget allows. On failure we keep going.
  let gmgn = null;
  let gmgnHolders = null;
  let gmgnCandleSummary = null;
  let gmgnTried = false;
  if (gmgnAvailable()) {
    gmgnTried = true;
    gmgn = await fetchGmgnTokenInfo(addr);
    // Holders: prioritas ke-2 — perbaiki min_holders saat Blockscout 0
    gmgnHolders = await fetchGmgnHolders(addr, 20);
    // Candles: hanya jika masih ada weight (opsional, hemat free tier)
    if (gmgnWeightStatus().remaining > 0) {
      const candles = await fetchGmgnCandles(addr, { interval: '15m', limit: 32 });
      gmgnCandleSummary = summarizeCandles(candles);
    }
  }

  // Security + smart-money run in parallel after we know the pair
  const pairAddress = dex?.pairAddress || null;
  const [security, smartMoney] = await Promise.all([
    checkTokenSecurity(addr).catch((err) => ({
      mint: addr,
      verdict: 'UNKNOWN',
      riskScore: 0.5,
      findings: [{ kind: 'error', detail: err.message }],
      checkedAt: now(),
    })),
    fetchSmartMoneyReport(addr, { pairAddress }).catch((err) => ({
      holders: holdersData?.holders || [],
      savedWalletExposure: { holderCount: 0, addresses: [], labels: [], ratio: 0, tracked: 0 },
      snipers: { sniperCount: 0, insiderCount: 0, snipers: [], insiders: [], sniperSharePercent: 0 },
      error: err.message,
      fetchedAt: now(),
    })),
  ]);

  const chainAct = onchainActivity(addr);
  const poolMeta = onchainNewPools.get(addr) || newPools.get(addr) || null;
  const spike = volumeSpikes.get(addr) || null;

  const liquidityUsd = firstPositiveNumber(gmgn?.liquidityUsd, toNumber(dex?.liquidity));
  const volume24h = firstPositiveNumber(gmgn?.volume24hUsd, toNumber(dex?.volume));
  const holderCount =
    firstPositiveNumber(gmgnHolders?.holderCount, gmgn?.holderCount, holdersData?.holderCount, toNumber(tokenInfo?.holders)) || 0;
  const top10Percent = firstPositiveNumber(gmgnHolders?.top10Percent, holdersData?.top10Percent) ?? 0;
  const ageMs = dex?.ageMs ?? (poolMeta?.seenAt ? now() - poolMeta.seenAt : null);

  const rugScore = estimateRugScore({
    liquidityUsd: toNumber(liquidityUsd),
    holderCount: toNumber(holderCount),
    top10Percent,
    ageMs,
    volume24h: toNumber(volume24h),
  });

  const priceUsd = firstPositiveNumber(gmgn?.priceUsd, dex?.priceUsd, tokenInfo?.exchangeRate);
  const marketCapUsd = firstPositiveNumber(
    gmgn?.marketCapUsd,
    dex?.market_cap,
    priceUsd && tokenInfo?.totalSupply ? priceUsd * toNumber(tokenInfo.totalSupply) : null
  );

  return {
    dex,
    gmgn,
    gmgnHolders,
    gmgnCandleSummary,
    tokenInfo,
    holdersData,
    security,
    smartMoney,
    onchain: chainAct,
    poolMeta,
    spike,
    sources: {
      primary: gmgn ? 'gmgn' : gmgnTried ? 'gmgn_failed_fallback' : 'gmgn_skipped',
      secondary: dex ? 'dexscreener' : null,
      holders: gmgnHolders ? 'gmgn_holders' : holdersData ? 'blockscout' : null,
      candles: gmgnCandleSummary && gmgnCandleSummary.sample > 0 ? 'gmgn_candles' : null,
      security: security ? 'local_sim' : null,
      smartMoney: smartMoney ? 'blockscout_transfers' : null,
      gmgnWeight: gmgnWeightStatus(),
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd,
      holderCount,
      top10Percent,
      maxHolderPercent: firstPositiveNumber(gmgnHolders?.maxHolderPercent, holdersData?.maxHolderPercent) ?? 0,
      volume24hUsd: volume24h,
      volume5mUsd: toNumber(dex?.volume5m),
      txns24h: toNumber(dex?.swaps),
      buys24h: toNumber(dex?.buys),
      sells24h: toNumber(dex?.sells),
      priceChange5m: toNumber(dex?.priceChange5m),
      priceChange1h: toNumber(dex?.priceChange1h),
      priceChange24h: toNumber(dex?.priceChange24h),
      trend15m: gmgnCandleSummary?.trend || null,
      trendChangePct: gmgnCandleSummary?.changePct ?? null,
      poolAgeMs: ageMs,
      rugScore,
      totalFeeSol: toNumber(gmgn?.totalFeeSol),
      tradeFeeSol: toNumber(gmgn?.tradeFeeSol),
      onchainSwapCount: toNumber(chainAct?.count),
      onchainVolumeEth: toNumber(chainAct?.volumeEth),
      // security + smart-money rollups
      securityRiskScore: toNumber(security?.riskScore),
      securityVerdict: security?.verdict || 'UNKNOWN',
      savedWalletHolders: toNumber(smartMoney?.savedWalletExposure?.holderCount),
      sniperCount: toNumber(smartMoney?.snipers?.sniperCount),
      insiderCount: toNumber(smartMoney?.snipers?.insiderCount),
      sniperSharePercent: toNumber(smartMoney?.snipers?.sniperSharePercent),
    },
    meta: {
      name: gmgn?.name || tokenInfo?.name || dex?.name || '',
      symbol: gmgn?.symbol || tokenInfo?.symbol || dex?.symbol || '',
      decimals: tokenInfo?.decimals || 18,
      pairAddress: dex?.pairAddress || '',
      dexId: dex?.dexId || '',
      url: dex?.url || '',
      socials: gmgn?.socials || {
        twitter: '',
        website: '',
        telegram: '',
      },
    },
    enrichedAt: now(),
  };
}

export function compactForLlm(enriched, filters, signals) {
  const m = enriched.metrics;
  return {
    mint: enriched.meta?.address || enriched.dex?.mint || enriched.gmgn?.address,
    symbol: enriched.meta.symbol,
    name: enriched.meta.name,
    signals,
    dataSources: enriched.sources,
    security: enriched.security
      ? {
          verdict: enriched.security.verdict,
          riskScore: enriched.security.riskScore,
          owner: enriched.security.owner ? 'present' : 'none',
          findings: (enriched.security.findings || []).map((f) => f.detail).slice(0, 5),
        }
      : null,
    smartMoney: {
      savedWalletHolders: m.savedWalletHolders,
      sniperCount: m.sniperCount,
      insiderCount: m.insiderCount,
      sniperSharePercent: m.sniperSharePercent,
    },
    metrics: {
      priceUsd: m.priceUsd,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: m.liquidityUsd,
      holderCount: m.holderCount,
      top10HolderPercent: m.top10Percent,
      volume24hUsd: m.volume24hUsd,
      volume5mUsd: m.volume5mUsd,
      txns24h: m.txns24h,
      buys24h: m.buys24h,
      sells24h: m.sells24h,
      priceChange5m: m.priceChange5m,
      priceChange1h: m.priceChange1h,
      priceChange24h: m.priceChange24h,
      poolAgeHours: m.poolAgeMs != null ? +(m.poolAgeMs / 3600_000).toFixed(2) : null,
      rugScore: m.rugScore,
      totalFeeSol: m.totalFeeSol,
      onchainSwapCount: m.onchainSwapCount,
    },
    filters,
  };
}
