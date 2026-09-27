import { fmtUsd, fmtEth, fmtPct, escapeHtml, short } from './utils.js';

export { escapeHtml, short, fmtUsd, fmtEth, fmtPct };

export function signalBadge(signals = {}) {
  const parts = [];
  if (signals.hasVolumeSpike) parts.push('vol');
  if (signals.hasNewPool) parts.push('new');
  if (signals.hasTrending) parts.push('trend');
  if (signals.hasOnchain) parts.push('chain');
  return parts.join('+') || signals.route || 'unknown';
}
