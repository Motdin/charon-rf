import { createWsClient, publicClient } from './rpc.js';
import { WS_URL, ONCHAIN_EVENTS_ENABLED } from '../config.js';

/**
 * WebSocket newHeads watcher → trigger callback tiap block baru.
 * Lebih responsif dari poll HTTP untuk monitor posisi.
 * Jika WS gagal, caller tetap aman (polling HTTP tetap jalan).
 */

let stopFn = null;
let running = false;

export function isWsWatcherRunning() {
  return running;
}

export async function startBlockWatcher(onBlock) {
  if (!ONCHAIN_EVENTS_ENABLED) {
    console.log('[ws] disabled');
    return { ok: false, reason: 'disabled' };
  }
  if (running) return { ok: true, reason: 'already' };

  try {
    const ws = createWsClient();
    const unwatch = ws.watchBlockNumber({
      onBlockNumber: (blockNumber) => {
        try {
          onBlock(blockNumber);
        } catch (err) {
          console.log(`[ws] onBlock error: ${err.message}`);
        }
      },
      onError: (err) => {
        console.log(`[ws] error: ${err?.message || err}`);
      },
    });
    stopFn = () => {
      try {
        unwatch();
      } catch {
        /* ignore */
      }
    };
    running = true;
    console.log(`[ws] watching newHeads via ${WS_URL}`);
    return { ok: true, reason: 'started' };
  } catch (err) {
    running = false;
    console.log(`[ws] start failed (HTTP poll continues): ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

export function stopBlockWatcher() {
  if (stopFn) stopFn();
  stopFn = null;
  running = false;
}

/** Health ping — pastikan RPC client masih hidup. */
export async function pingRpc() {
  try {
    const block = await publicClient.getBlockNumber();
    return { ok: true, block: Number(block) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
