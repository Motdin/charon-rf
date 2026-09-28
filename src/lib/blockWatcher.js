import { createWsClient, publicClient, wsCandidates } from './rpc.js';
import { ONCHAIN_EVENTS_ENABLED, WS_WATCHER_ENABLED } from '../config.js';

/**
 * WebSocket newHeads watcher → trigger callback tiap block baru.
 *
 * - Mencoba beberapa endpoint WSS (env → drpc → publicnode → …)
 * - Setelah 3 error berturut-turut → WS dimatikan; poll HTTP tetap jalan
 * - Log error dibatasi agar tidak spam
 */

let stopFn = null;
let running = false;
let disabled = false;
let consecutiveErrors = 0;
let lastErrLogAt = 0;
const MAX_WS_ERRORS = 3;

export function isWsWatcherRunning() {
  return running;
}

export function wsWatcherStatus() {
  return {
    running,
    disabled,
    consecutiveErrors,
    candidates: wsCandidates(),
  };
}

function logWsError(msg) {
  const now = Date.now();
  if (now - lastErrLogAt < 30_000) return; // maksimal 1 log / 30 detik
  lastErrLogAt = now;
  console.log(`[ws] ${msg}`);
}

function giveUp(reason) {
  if (stopFn) {
    try {
      stopFn();
    } catch {
      /* ignore */
    }
  }
  stopFn = null;
  running = false;
  disabled = true;
  console.log(`[ws] watcher dimatikan (${reason}) — lanjut HTTP poll saja`);
}

export async function startBlockWatcher(onBlock) {
  if (!ONCHAIN_EVENTS_ENABLED) {
    console.log('[ws] disabled (ONCHAIN_EVENTS_ENABLED=false)');
    return { ok: false, reason: 'disabled' };
  }
  if (!WS_WATCHER_ENABLED) {
    console.log('[ws] watcher off (WS_WATCHER_ENABLED=false) — HTTP poll only');
    return { ok: false, reason: 'ws_disabled' };
  }
  if (running || disabled) return { ok: running, reason: running ? 'already' : 'disabled' };

  const candidates = wsCandidates();
  for (const url of candidates) {
    try {
      const ws = createWsClient(url);
      const unwatch = ws.watchBlockNumber({
        onBlockNumber: (blockNumber) => {
          consecutiveErrors = 0;
          try {
            onBlock(blockNumber);
          } catch (err) {
            logWsError(`onBlock error: ${err.message}`);
          }
        },
        onError: (err) => {
          consecutiveErrors++;
          logWsError(`error: ${err?.message || err}`);
          if (consecutiveErrors >= MAX_WS_ERRORS) {
            giveUp(`${consecutiveErrors} errors beruntun`);
          }
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
      consecutiveErrors = 0;
      console.log(`[ws] watching newHeads via ${url}`);
      return { ok: true, reason: 'started', url };
    } catch (err) {
      logWsError(`start gagal di ${url}: ${err.message}`);
    }
  }

  disabled = true;
  console.log('[ws] semua endpoint WSS gagal — HTTP poll only');
  return { ok: false, reason: 'all_ws_failed' };
}

export function stopBlockWatcher() {
  if (stopFn) stopFn();
  stopFn = null;
  running = false;
}

export async function pingRpc() {
  try {
    const block = await publicClient.getBlockNumber();
    return { ok: true, block: Number(block) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
