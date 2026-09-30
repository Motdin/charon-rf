/**
 * Smoke: /adopt — mengangkat token yang sudah ada di wallet jadi posisi terpantau.
 * Usage: node scripts/smoke-adopt.js
 *
 * Fokus utama: PRESISI token_amount_raw.
 * Saldo memecoin 18-desimal rutin melewati 2^53 dan >= 1e21, di mana
 * String(Number(x)) berubah jadi notasi eksponensial ("2.5e+24") yang membuat
 * BigInt() melempar saat jual. Posisi hasil adopsi HARUS menyimpan uint256
 * apa adanya supaya exit bisa dieksekusi.
 */
import './_testdb.js';
import { initDb } from '../src/db/connection.js';
import {
  createAdoptedPosition,
  positionById,
  openPositions,
  hasOpenPositionForMint,
  closePosition,
} from '../src/db/positions.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

initDb();

const MINT = '0x' + 'ad'.repeat(20);
// 5.000.000 token @ 18 desimal = 5e24 — jauh di atas 2^53 DAN di atas 1e21.
const RAW = '5000000000000000000000000';

console.log('— adopsi posisi —');
const id = createAdoptedPosition({
  mint: MINT,
  symbol: 'STRAY',
  sizeEth: 0.05,
  entryPrice: 0.0000123,
  entryMcap: 48200,
  tokenAmountRaw: RAW,
  tokenAmountEst: 5_000_000,
  strategyId: 'sniper',
  note: 'smoke',
});
assert(Number.isInteger(Number(id)) && Number(id) > 0, 'posisi terbuat');

const pos = positionById(id);
assert(pos.status === 'open', 'status open');
assert(pos.execution_mode === 'live', 'execution_mode live (token nyata, exit harus jalur live)');
assert(pos.mint === MINT, 'mint tersimpan');
assert(pos.symbol === 'STRAY', 'symbol tersimpan');

console.log('— presisi uint256 (regresi notasi eksponensial) —');
assert(pos.token_amount_raw === RAW, `token_amount_raw utuh apa adanya (${pos.token_amount_raw})`);
assert(!/e\+/i.test(String(pos.token_amount_raw)), 'tidak ada notasi eksponensial');
assert(BigInt(pos.token_amount_raw) === BigInt(RAW), 'BigInt() bisa mem-parse — jalur jual aman');
// Bukti bahwa jalur lama memang rusak untuk nilai ini:
assert(
  /e\+/i.test(String(Number(RAW))),
  'kontrol: String(Number(raw)) memang menghasilkan eksponensial (itulah bug-nya)'
);

console.log('— integrasi dengan monitor —');
assert(hasOpenPositionForMint(MINT), 'terdeteksi sebagai posisi terbuka → tidak akan dibeli ganda');
assert(
  openPositions().some((p) => p.id === id),
  'muncul di openPositions() → monitor TP/SL akan memantaunya'
);

console.log('— TP/SL terisi dari strategi —');
assert(Number.isFinite(Number(pos.tp_percent)), 'tp_percent terisi');
assert(Number.isFinite(Number(pos.sl_percent)), 'sl_percent terisi');
assert(Number(pos.high_water_price) === Number(pos.entry_price), 'high-water start = entry');

// bersih-bersih agar smoke berikutnya tidak melihat posisi ini
closePosition({
  id,
  exitPrice: 0,
  exitMcap: 0,
  exitReason: 'SMOKE_CLEANUP',
  pnlPercent: 0,
  pnlEth: 0,
});
assert(!hasOpenPositionForMint(MINT), 'cleanup ok');

console.log('\nADOPT SMOKE PASSED');
