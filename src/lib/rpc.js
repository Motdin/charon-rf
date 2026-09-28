import { createPublicClient, http, webSocket, fallback } from 'viem';
import { CHAIN, RPC_URL, WS_URL, RPC_FALLBACK_URLS } from '../config.js';

/**
 * Shared RPC client dengan failover.
 *
 * Urutan: RPC_URL → RPC_FALLBACK_URLS (dipisah koma) → public RH defaults.
 * Transport `fallback` viem otomatis pindah endpoint saat error/timeout.
 */

function rpcList() {
  const primary = RPC_URL;
  const extras = RPC_FALLBACK_URLS;
  const builtIn = [
    'https://robinhood.drpc.org',
    'https://robinhood-rpc.publicnode.com',
    'https://rpc.mainnet.chain.robinhood.com',
  ];
  return [...new Set([primary, ...extras, ...builtIn].filter(Boolean))];
}

export function rpcEndpoints() {
  return rpcList();
}

export function createFailoverHttpClient() {
  const urls = rpcList();
  return createPublicClient({
    chain: CHAIN,
    transport: fallback(
      urls.map((url) => http(url, { timeout: 12_000, retryCount: 1 })),
      { rank: false }
    ),
  });
}

/** WebSocket client untuk newHeads / logs — gagal fallback ke HTTP-only. */
export function createWsClient(wsUrl) {
  const url = String(wsUrl || WS_URL || 'wss://robinhood.drpc.org').replace(/\/+$/, '');
  return createPublicClient({
    chain: CHAIN,
    transport: webSocket(url, {
      timeout: 15_000,
      keepAlive: true,
      reconnect: true,
    }),
  });
}

/** Kandidat WSS — urut prioritas (publicnode sering putus di beberapa region). */
export function wsCandidates() {
  const envUrl = (WS_URL || '').replace(/\/+$/, '').trim();
  const list = [
    envUrl,
    'wss://robinhood.drpc.org',
    'wss://robinhood-rpc.publicnode.com',
    'wss://rpc.ordofi.network',
  ];
  return [...new Set(list.filter(Boolean))];
}

export const publicClient = createFailoverHttpClient();
