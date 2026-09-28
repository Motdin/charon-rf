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
export function createWsClient() {
  const url = WS_URL || 'wss://robinhood.drpc.org';
  return createPublicClient({
    chain: CHAIN,
    transport: webSocket(url, {
      timeout: 20_000,
      keepAlive: true,
      reconnect: true,
    }),
  });
}

export const publicClient = createFailoverHttpClient();
