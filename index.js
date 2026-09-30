import { startCharon } from './src/app.js';

/**
 * Jaring pengaman proses.
 *
 * Tanpa ini, satu promise rejection yang lolos (mis. promise transaksi yang
 * tidak di-await) langsung mematikan proses di Node >=15 — bot mati diam-diam
 * sementara posisi live tetap terbuka tanpa TP/SL sampai PM2 me-restart.
 * Sekarang kegagalan selalu tercatat dulu, baru diputuskan.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection —', reason?.stack || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException —', err?.stack || err);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[charon] ${signal} diterima — shutdown.`);
    process.exit(0);
  });
}

startCharon().catch((error) => {
  console.error(error);
  process.exit(1);
});
