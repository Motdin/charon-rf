import { fmtUsd, fmtPct, escapeHtml, short, fmtEth } from '../utils.js';
import { signalLabel } from '../pipeline/candidateBuilder.js';

export function candidateSummary(candidate, decision) {
  const t = candidate.token || {};
  const m = candidate.metrics || {};
  const lines = [
    `<b>${escapeHtml(t.symbol || t.mint?.slice(0, 10) || '?')}</b> ${escapeHtml(t.name || '')}`,
    `Mint: <code>${escapeHtml(short(t.mint, 12))}</code>`,
    `Signals: ${escapeHtml(signalLabel(candidate.signals))} (×${candidate.signals?.sourceCount ?? '?'})`,
    `Mcap: ${fmtUsd(m.marketCapUsd)} · Liq: ${fmtUsd(m.liquidityUsd)} · Vol24h: ${fmtUsd(m.volume24hUsd)}`,
    `Holders: ${m.holderCount ?? '—'} · Top10: ${m.top10Percent != null ? m.top10Percent.toFixed(1) + '%' : '—'}`,
    `Price: $${Number(m.priceUsd || 0).toFixed(8)} · Rug: ${m.rugScore != null ? m.rugScore.toFixed(2) : '—'}`,
  ];
  if (decision) {
    lines.push(
      '',
      `Decision: <b>${decision.verdict}</b> (conf ${decision.confidence})`,
      decision.reason ? escapeHtml(decision.reason) : ''
    );
    if (decision.risks?.length) lines.push(`Risks: ${escapeHtml(decision.risks.join('; '))}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function positionSummary(position) {
  const pnl = Number(position.pnl_percent ?? position.pnlPercent ?? 0);
  // Ticker bisa sama antar token — selalu tampilkan CA (dipendekkan)
  const ca = position.mint ? `${String(position.mint).slice(0, 6)}…${String(position.mint).slice(-4)}` : '?';
  const head = position.symbol
    ? `<b>${escapeHtml(position.symbol)}</b> <code>${escapeHtml(ca)}</code>`
    : `<code>${escapeHtml(position.mint || '?')}</code>`;
  return [
    `${head} #${position.id}`,
    `CA: <code>${escapeHtml(position.mint || '')}</code>`,
    `Status: ${position.status} · Mode: ${position.execution_mode}`,
    `Entry: ${fmtUsd(position.entry_mcap)} mcap · Size: ${fmtEth(position.size_eth)}`,
    `PnL: ${fmtPct(pnl)}`,
    position.exit_reason ? `Exit: ${position.exit_reason}` : '',
    position.pnl_eth != null ? `PnL ETH: ${fmtEth(position.pnl_eth)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
