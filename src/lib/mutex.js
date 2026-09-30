/**
 * Mutex async minimal (FIFO).
 *
 * Empat loop sinyal (DexScreener, on-chain, price alert, Pons) berjalan
 * konkuren dan semuanya memanggil orkestrator yang sama. Di antara
 * pengecekan `canOpenMorePositions()` dan INSERT posisi ada banyak `await`
 * (enrich, LLM, quote, simulasi, kirim tx) — jendela TOCTOU selebar itu
 * membuat dua kandidat dari dua sumber berbeda bisa sama-sama lolos gate
 * dan membuka posisi melebihi `max_open_positions`. Artinya modal yang
 * dipertaruhkan lebih besar dari yang dikonfigurasi user.
 *
 * Serialisasi adalah jawaban yang benar di sini: throughput bukan tujuan
 * (kita sengaja hanya membuka maksimal 1 posisi per batch), sedangkan
 * kebenaran gate risiko adalah tujuan.
 */
export function createMutex() {
  let tail = Promise.resolve();
  let depth = 0;

  function runExclusive(fn) {
    depth++;
    const run = tail.then(fn, fn); // tetap antre walau pemegang sebelumnya gagal
    // Rantai antrean tidak boleh putus karena rejection.
    tail = run.then(
      () => {},
      () => {}
    );
    return run.finally(() => {
      depth--;
    });
  }

  return {
    runExclusive,
    get pending() {
      return depth;
    },
  };
}
