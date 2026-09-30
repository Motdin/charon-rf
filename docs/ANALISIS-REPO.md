# Analisis Repo `charon-rh`

Tanggal: 2026-09-30 · Branch: `arena/01a0f2ff-charon-rh` · Base commit: `79d9606`

---

## 1. Ringkasan

`charon-rh` adalah **trading bot meme-coin otonom** untuk Robinhood Chain (EVM L2, chainId 4663),
port dari Charon (Solana/Pump.fun) ke EVM. Arsitekturnya: kumpulkan sinyal → perkaya data →
filter strategi → keputusan LLM → eksekusi Uniswap V4/V3, dengan Telegram sebagai control plane.

| Metrik | Nilai |
|---|---|
| Bahasa | JavaScript (ESM murni, `"type": "module"`) |
| Runtime | Node.js 22 (pakai `node:sqlite` bawaan) |
| Total LOC | ~10.300 baris (35 file `src/`, 14 file `scripts/`, 1 file Python) |
| Dependensi langsung | 4 (`axios`, `dotenv`, `node-telegram-bot-api`, `viem`) |
| Dependensi transitif | 201 paket |
| File terbesar | `src/liveExecutor.js` (914), `src/telegram/send.js` (993) |
| Riwayat git | **1 commit** (squashed/import awal) |
| QC | `npm run verify` → **PASSED** (35 syntax + 9 smoke suite, ±5 detik, offline) |

**Penilaian umum: kualitas di atas rata-rata untuk proyek bot trading solo.**
Rail keamanan dana (preflight bytecode router, quote-sebelum-kirim, unwrap rollback,
golden test byte-identik untuk kalkodata V4) jauh lebih matang dari kebanyakan repo sejenis.
Kelemahan utamanya ada di **presisi angka BigInt**, **ketiadaan process-level error handling**,
**tidak ada CI**, dan **beberapa race condition asinkron**.

---

## 2. Arsitektur

```
index.js
└── src/app.js  (bootstrap: validateConfig → initDb → preflight → wire handlers → start loops)
    │
    ├── signals/        4 sumber sinyal, masing-masing loop setTimeout independen
    │   ├── dexscreener.js   (poll 30s: search + token-profiles + token-boosts)
    │   ├── uniswapEvents.js (scan log V4 Initialize / V3 PoolCreated / Swap)
    │   ├── priceMonitor.js  (alert dip untuk strategi wait_for_dip)
    │   └── pons.js          (feed launchpad ponsfamily.com)
    │
    ├── pipeline/orchestrator.js   ← titik masuk tunggal semua sinyal
    │   ├── candidateBuilder.js    (enrich + filterCandidate, 32 field strategi)
    │   └── llm.js                 (batch picker, max 1 BUY, quota guard + backoff + backup provider)
    │
    ├── enrichment/     gmgn → dexscreener → blockscout → security → wallets (berjenjang + fallback)
    ├── execution/      router.js → liveExecutor.js (V4 UniversalRouter / V3 SwapRouter02)
    ├── db/             node:sqlite, 13 tabel, WAL
    └── telegram/       send.js (30+ command) + menu.js (inline keyboard, edit interaktif)
```

**Yang bagus dari desain ini:**

- Separation of concerns rapi: `signals` → `pipeline` → `execution` → `db` → `telegram`.
- Handler di-inject (`setCandidateHandler`) sehingga modul sinyal tidak tahu apa-apa soal orkestrator → mudah di-smoke-test terisolasi.
- Semua parameter strategi hidup di SQLite (`strategies.config_json`) dan **hot-read** dengan cache 5 detik — ubah TP/SL dari Telegram tanpa restart.
- `syncStrategySeeds()` sengaja dimatikan by default supaya `/stratset` user tidak ketimpa saat restart (jelas hasil belajar dari insiden nyata).
- Loop pakai `setTimeout` rekursif + flag `busy`, bukan `setInterval` — tidak menumpuk saat tick lambat. Benar.

---

## 3. Temuan kritis (bug nyata)

### 🔴 K-0 · `await` hilang saat mengirim transaksi → dana keluar tanpa posisi **[SUDAH DIPERBAIKI]**

> Ini akar penyebab gejala "dompet ada transaksi beli tapi Telegram bilang tidak ada yang pass".

**Lokasi:** `src/liveExecutor.js:683` (V4) dan `:780` (V3) — dua baris yang justru
**mengirim transaksi buy/sell**. Enam `writeContract` lain (wrap, unwrap, approve, Permit2,
revoke) semuanya sudah benar memakai `await`; hanya dua ini yang terlewat.

```js
const hash = walletClient.writeContract({ ...request, account });   // ← tanpa await
const receipt = await publicClient.waitForTransactionReceipt({ hash });
```

`writeContract()` mengembalikan Promise dan **langsung menyiarkan transaksi**. Karena tidak
di-`await`, `hash` adalah objek Promise, bukan string hex. Diverifikasi empiris dengan viem:

```
eth_getTransactionReceipt dipanggil dengan params: [{}]
→ WaitForTransactionReceiptTimeoutError
→ 'Timed out while waiting for transaction with hash "[object Promise]" to be confirmed.'
```

**Rantai akibatnya:**

1. Transaksi **tersiar dan sukses on-chain** → dompet menunjukkan pembelian ✅
2. `waitForTransactionReceipt` polling hash `{}` → selalu null → **menggantung 180 detik**
   (default timeout viem) → melempar. Selama 3 menit itu orkestrator terblokir, sementara
   loop sinyal lain terus mengirim batch reveal `verdict WATCH / no buy selected` —
   **inilah "tidak ada yang pass" yang terlihat di Telegram.**
3. Masuk ke `catch` → `rollbackWrap(wrapped)` dipanggil **keliru**: di jalur V3 ia mencoba
   meng-unwrap WETH yang sudah terpakai oleh swap.
4. `createLivePosition()` **tidak pernah tercapai** → tidak ada baris posisi → **tidak ada
   TP / SL / trailing** untuk token yang sudah dibeli.
5. Karena posisi tidak ada, `hasOpenPositionForMint()` mengembalikan `false` → bot bisa
   **membeli token yang sama lagi** pada sinyal berikutnya.
6. Jika Promise `writeContract` yang telantar itu **reject** (nonce/gas/RPC), tidak ada yang
   menangkapnya → `unhandledRejection` → digabung dengan temuan K-2 (tidak ada handler
   proses) → **proses mati diam-diam tanpa pesan Telegram apa pun**, lalu PM2 restart dan
   bot kehilangan konteks sepenuhnya.

**Perbaikan yang diterapkan:**

- `await` ditambahkan di kedua titik pengiriman transaksi.
- Helper baru `finalizeSwapFailure()`: begitu transaksi tersiar (`broadcastHash` terisi),
  wrap **tidak** di-rollback lagi dan error ditandai `err.broadcast = true` + `err.txHash`.
- `orchestrator.js` dan `router.js` kini mengirim alarm eksplisit
  `🚨 DANA SUDAH KELUAR — posisi TIDAK tercatat` berikut hash tx, bukan pesan "failed" biasa.
- `index.js` mendapat handler `unhandledRejection` / `uncaughtException` / `SIGTERM`.
- Dua regression test baru di `scripts/smoke-executor.js` — diverifikasi gagal saat bug
  lama disisipkan kembali, dan lulus setelah perbaikan.


### 🔴 K-1 · `Number()` pada uint256 → notasi eksponensial → `BigInt()` throw

**Lokasi:** `src/execution/positions.js:85-88`, `src/db/positions.js:108,117,128`

```js
const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
```

`token_amount_raw` adalah uint256 raw (18 desimal). Untuk memecoin dengan jumlah token besar,
nilainya melewati `2^53` dan — lebih parah — begitu `≥ 1e21`, `String(number)` menghasilkan
notasi eksponensial:

```
raw    = 5000000000000000000000000   (5 juta token @18 desimal)
String(Math.floor(Number(raw)*0.5)) = "2.5e+24"
BigInt("2.5e+24")                    → TypeError: Cannot convert 2.5e+24 to a BigInt
```

`executeLiveSell` (`src/execution/router.js:87`) memanggil `BigInt(String(amount))` → **throw**.

**Dampak berlapis:** `markPartialTpDone(position.id)` dipanggil **sebelum** percobaan jual
(`positions.js:80`), jadi ketika jual gagal, flag sudah tersimpan permanen —
**partial TP tidak pernah dicoba ulang**, dan kegagalannya hanya jadi satu baris `console.log`
tanpa notifikasi Telegram.

**Perbaikan:** pakai `BigInt` sepanjang jalur amount.

```js
const rawBI = BigInt(position.token_amount_raw);
const pctBI = BigInt(Math.round(strat.partial_tp_sell_percent));
const sellAmount = (rawBI * pctBI) / 100n;
const remaining  = rawBI - sellAmount;
// ... dan pindahkan markPartialTpDone() ke SETELAH jual sukses
```

Hal yang sama berlaku untuk `String(Math.floor(tokenAmountEst * 1e18))` di `db/positions.js:108,128`.

---

### 🔴 K-2 · Tidak ada handler `unhandledRejection` / `uncaughtException` **[SUDAH DIPERBAIKI]**

**Lokasi:** `index.js`, `src/app.js`

`index.js` hanya menangkap error dari `startCharon()`. Setelah bootstrap selesai, tidak ada
jaring pengaman apa pun. Node 22 default `--unhandled-rejections=throw` → **satu promise
rejection yang lolos dari loop mana pun akan mematikan proses**.

Untuk bot yang memegang posisi terbuka, mati mendadak = TP/SL/trailing berhenti dijalankan
sampai PM2 me-restart. Di `startPositionMonitor` ada `.catch()`, tapi `startBlockWatcher(...).then(...)`
di `positions.js:315` **tidak punya `.catch()`** — rejection di sana tidak tertangani.

**Perbaikan:**

```js
process.on('unhandledRejection', (r) => { console.error('[fatal] unhandledRejection', r); sendTelegram(...); });
process.on('uncaughtException',  (e) => { console.error('[fatal] uncaughtException', e); });
process.on('SIGTERM', gracefulShutdown);  // tutup DB, batalkan loop
```

---

### 🟠 K-3 · Race condition TOCTOU pada `canOpenMorePositions()`

**Lokasi:** `src/pipeline/orchestrator.js:36` dan `:160`

Empat loop sinyal berjalan **konkuren**. Masing-masing `await candidateHandler(...)`, tapi tidak
ada mutex lintas-loop. Alur `processCandidateFromSignals` punya banyak `await` (enrich, LLM,
simulasi swap) antara pengecekan `canOpenMorePositions()` dan `INSERT` posisi.

Dua kandidat dari dua sumber berbeda bisa lolos gate `max_open_positions` bersamaan →
**posisi terbuka melebihi batas**, artinya modal yang dipertaruhkan lebih besar dari yang
dikonfigurasi user. Pengecekan duplikat-mint (`hasOpenPositionForMint`) punya masalah yang sama,
walaupun sudah ada re-check kedua di `handleApprovedBuy`.

**Perbaikan:** serialisasi pipeline dengan antrean/mutex sederhana, atau klaim slot secara
atomik di SQLite (`INSERT ... WHERE (SELECT COUNT(*) ...) < max` dalam satu transaksi).

---

### 🟠 K-4 · 9 kerentanan npm (2 kritis) dari `node-telegram-bot-api`

```
form-data  <=2.5.5   CRITICAL  (boundary acak tak aman + CRLF injection)
qs         <=6.15.3  MODERATE  (DoS)
tough-cookie <4.1.3  MODERATE  (prototype pollution)
uuid       <11.1.1   MODERATE
```

Semua berasal dari rantai `node-telegram-bot-api@0.66 → @cypress/request → request`
(paket `request` sudah deprecated sejak 2020). `npm audit fix` menyelesaikan sebagian;
sisanya butuh `--force` yang akan menurunkan `node-telegram-bot-api` ke `2.1.0` (breaking).

**Rekomendasi:** pertimbangkan migrasi ke `grammy` atau `telegraf` yang pakai `undici`/fetch
native, atau minimal pin dan pantau. Bot ini memegang private key — permukaan serang dependensi
bukan hal sepele.

---

## 4. Temuan menengah

### 🟡 M-1 · Otorisasi Telegram hanya di level chat, bukan user

`src/telegram/send.js:384` & `:772`:

```js
if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
```

Cukup untuk chat privat. Tapi kalau `TELEGRAM_CHAT_ID` menunjuk ke **grup**, maka
**setiap anggota grup** bisa menjalankan `/mode live`, `/confirm <id>`, `/stratset`,
atau `/close`. Tambahkan allowlist `TELEGRAM_ALLOWED_USER_IDS` dan cek `msg.from.id`.

### 🟡 M-2 · Harga ETH di-hardcode `$2500`

`src/db/positions.js:97,117`:

```js
const tokenAmountEst = entryPrice > 0 ? (sizeEth * 2500) / entryPrice : 0;
```

Estimasi jumlah token memakai kurs ETH/USD tetap 2500. Di jalur dry-run ini hanya
memengaruhi bookkeeping, tapi di `createLivePosition` nilai ini jadi **fallback
`token_amount_raw`** ketika `swap.outputAmount` kosong — dan angka itulah yang nanti dipakai
untuk menjual. Ambil harga ETH dari pool WETH/USDG on-chain atau dari DexScreener.

### 🟡 M-3 · PnL live tidak menghitung gas

`src/execution/positions.js:150`:

```js
finalPnlEth = receivedEth - Number(position.size_eth);
```

Biaya gas buy + sell tidak dikurangkan, padahal `liveExecutor.js:693` sudah menghitung
`gasCost = receipt.gasUsed * effectiveGasPrice`. Untuk posisi 0.02–0.05 ETH di L2 gas memang
kecil, tapi `/pnl` dan PnL card jadi **optimistis secara sistematis**. Simpan gas per-trade
dan kurangkan.

### 🟡 M-4 · Tidak ada CI

`.github/` hanya berisi `FUNDING.yml`. Padahal `npm run verify` sudah lengkap, cepat (±5 detik),
dan berjalan offline — kandidat sempurna untuk GitHub Actions. Tanpa CI, regresi baru ketahuan
saat deploy manual ke VPS.

### 🟡 M-5 · Tidak ada `engines` di `package.json`

Repo memakai `node:sqlite`, yang **eksperimental** dan baru stabil sejak Node 22.5.
Menjalankan di Node ≤22.4 atau Node 20 akan crash dengan `ERR_UNKNOWN_BUILTIN_MODULE`.
Tambahkan:

```json
"engines": { "node": ">=22.5.0" }
```

dan `.nvmrc`. Pertimbangkan juga flag `--no-warnings=ExperimentalWarning` di skrip start
agar log VPS bersih.

### 🟡 M-6 · Encoding rusak di 6 file script

| File | Masalah |
|---|---|
| `scripts/smoke.js` | BOM + 10 mojibake (`â€"`, `âœ“`) |
| `scripts/smoke-stratset.js` | BOM + 6 mojibake |
| `scripts/smoke-gmgn.js` | BOM + 5 mojibake |
| `scripts/smoke-interactive.js` | BOM + 5 mojibake |
| `scripts/smoke-pons.js` | BOM + 3 mojibake |
| `scripts/smoke-security.js` | 3 mojibake |
| `src/db/connection.js` | 236 baris CRLF (satu-satunya file di `src/`) |

Output QC jadi tidak terbaca (`âœ“ max_volume_liquidity_ratio=0 disables...`). Gejala klasik
file UTF-8 yang pernah disimpan ulang sebagai CP1252 di Windows. Perbaiki dengan normalisasi
UTF-8 tanpa BOM + tambahkan `.gitattributes`:

```
* text=auto eol=lf
```

### 🟡 M-7 · 21 variabel env tidak terdokumentasi

Dipakai di kode tapi tidak ada di `.env.example`:

```
DEX_DISCOVERY_ENABLED   FORCE_SYNC_STRATEGIES   LIVE_MINT_FAIL_COOLDOWN_MS
LIVE_ROUTELESS_COOLDOWN_MS   LLM_MIN_CONFIDENCE   LOG_SCAN_CHUNK_BLOCKS
LOG_SCAN_PACE_MS   MIMO_PYTHON   ONCHAIN_SURGE_MIN_SWAPS   ONCHAIN_SURGE_WINDOW_MS
PYTHON   UNISWAP_QUOTER   V4_DEPLOY_BLOCK   WS_WATCHER_ENABLED   ...
```

Sebaliknya `GMGN_REQUEST_DELAY_MS` didokumentasikan di README/`.env.example` tapi kode
membacanya dari **setting SQLite** (`numSetting('gmgn_request_delay_ms', 2500)`), bukan env —
jadi menyetelnya di `.env` tidak berefek. Itu bug dokumentasi yang menyesatkan.

Nama `MIMO_PYTHON` juga tampak sisa dari proyek lain.

---

## 5. Temuan minor / kebersihan

| # | Temuan |
|---|---|
| m-1 | **Tidak ada LICENSE**, `CONTRIBUTING`, atau `CODE_OF_CONDUCT` — padahal ada `FUNDING.yml` (mengundang kontributor tanpa lisensi). Repo `private: true` di package.json tapi publik di GitHub. |
| m-2 | Tidak ada linter/formatter (`eslint`, `prettier`, `.editorconfig`). Gaya sudah konsisten, tapi tidak terjaga otomatis. |
| m-3 | **Bahasa komentar campur**: 20 dari 35 file `src/` berkomentar Bahasa Indonesia, README + string Telegram sebagian Inggris, pesan Telegram runtime campur dua bahasa (`🛑 BUY ditolak — slot penuh` vs `🛑 Execution rejected on fresh check`). Pilih satu untuk kode, satu untuk UI. |
| m-4 | Nama peninggalan Solana: `executeJupiterSwap()` (ini Uniswap), `liveWalletBalanceLamports()` (ini wei), `totalFeeSol`/`tradeFeeSol` di metrik, prompt `/learn` masih bilang "Solana-style trench agent". Membingungkan pembaca baru; komentar di `liveExecutor.js:851` mengakuinya tapi tidak memperbaikinya. |
| m-5 | Script `check` di `package.json` adalah daftar 36 `node --check` yang ditulis manual. Saat ini sinkron, tapi `scripts/verify.js` sudah melakukan hal yang sama secara otomatis via `walk()` — duplikasi yang pasti akan drift. Ganti `check` jadi pemanggil skrip node kecil. |
| m-6 | 85 pemanggilan `console.log` langsung, tanpa abstraksi logger, tanpa level, tanpa timestamp. Di VPS/PM2 sulit memfilter. `pino` atau wrapper 20 baris sudah cukup. |
| m-7 | `ensureColumn()` menyusun SQL lewat template literal (`PRAGMA table_info(${table})`). Nilainya selalu konstanta internal jadi tidak eksploitabel, tapi ini satu-satunya SQL non-parameterized di repo — sisanya bersih 100%. |
| m-8 | Counter kuota LLM (`callsHour`/`callsDay`) hanya in-memory. Restart PM2 → reset → bot bisa melewati batas harian free tier. Persist ke tabel `settings`. |
| m-9 | Tidak ada `Dockerfile`/`ecosystem.config.js` walau README menginstruksikan PM2. Deployment sepenuhnya manual/tak terdokumentasi. |
| m-10 | Nama tabel `dry_run_positions` sekarang menyimpan **posisi live juga** (`execution_mode='live'`). Sudah di luar makna namanya — berisiko salah paham saat query manual/backup. |
| m-11 | README 23 KB dalam satu file. Sangat lengkap (mermaid, tabel, transkrip sesi Telegram), tapi layak dipecah ke `docs/`. |

---

## 6. Hal yang patut dipuji

Ini bukan basa-basi — beberapa keputusan di repo ini lebih baik dari standar industri untuk bot trading:

1. **Preflight bytecode router** (`app.js:33-50`). Bot menolak boot di mode `live`/`confirm`
   kalau salah satu kontrak router tidak punya bytecode di chain. Ini lahir dari insiden nyata
   (alamat SwapRouter02 mainnet dipakai di RH Chain → EOA mati → ETH ter-wrap dan dana hangus),
   dan perbaikannya **didokumentasikan di komentar kode, README, dan `.env.example` sekaligus**.

2. **Golden test byte-identik** (`scripts/smoke-executor.js`). Kalkodata `V4_SWAP` yang dibangun
   bot diverifikasi byte-per-byte terhadap transaksi mainnet yang benar-benar sukses. Untuk
   encoding Universal Router yang notorious rumit, ini cara pengujian yang tepat.

3. **Rail keamanan dana berlapis** di `liveExecutor.js`: quote → `simulateContract` → baru kirim;
   wrap **hanya selisih kekurangan** WETH; auto-unwrap rollback saat gagal; reserve gas dihitung
   native + WETH; cooldown per-mint terpisah untuk buy-fail vs routeless (jalur **jual tidak
   pernah diblokir** — persis keputusan yang benar).

4. **Fail-safe LLM**: saat 429/backoff/kuota habis, semua kandidat jadi `WATCH`, bukan lolos
   tanpa pemeriksaan. Default yang aman, dan ada backup provider otomatis.

5. **Pemeriksaan ulang anti-stale sebelum eksekusi** (`refreshCandidateForExecution`) — filter
   dijalankan lagi dengan data segar tepat sebelum dana bergerak, karena keputusan LLM bisa sudah
   basi beberapa detik.

6. **Wash-volume guard berbasis rasio** (`vol24h/liq > 50×`) sengaja ditempatkan di luar
   pengecualian "token masih muda", dengan komentar yang menjelaskan insiden yang memicunya.

7. Honeypot check 3 lapis (zero-balance account / real holder / Permit2 sebagai spender) —
   jauh melampaui pengecekan `owner()` biasa, dan verdict `FAIL` adalah **hard floor** yang tidak
   bisa dilonggarkan strategi mana pun.

8. Query SQL terparameterisasi konsisten, `escapeHtml()` dipakai di seluruh output Telegram,
   `execFile` dengan array argumen (bukan `exec` + string) untuk renderer Python — tidak ada
   celah injeksi yang saya temukan.

9. `.gitignore` benar untuk proyek ini: `.env*` diblokir dengan pengecualian `.env.example`,
   file `*.sqlite`/WAL/SHM diblokir, PNG generated diblokir.

---

## 7. Rekomendasi berurutan prioritas

**Segera (sebelum menjalankan mode `live` dengan nominal berarti):**

1. Perbaiki K-1 — seluruh jalur amount pakai `BigInt`; pindahkan `markPartialTpDone` ke setelah jual sukses.
2. Tambah K-2 — `unhandledRejection`/`uncaughtException`/`SIGTERM` handler + notifikasi Telegram saat fatal.
3. Perbaiki M-1 — allowlist `msg.from.id`, bukan hanya `chat.id`.
4. Jalankan `npm audit fix`; rencanakan migrasi dari `node-telegram-bot-api`.

**Jangka pendek:**

5. Serialisasi pipeline (K-3) dengan antrean async tunggal.
6. Tambah GitHub Actions: `npm ci && npm run verify` pada push/PR.
7. Tambah `engines` + `.nvmrc`; normalisasi encoding + `.gitattributes` (M-5, M-6).
8. Lengkapi `.env.example`; perbaiki dokumentasi `GMGN_REQUEST_DELAY_MS` (M-7).

**Jangka menengah:**

9. Harga ETH dinamis (M-2); hitung gas dalam PnL (M-3).
10. Tambah LICENSE; sinkronkan `private: true` dengan status repo publik.
11. Wrapper logger + persist kuota LLM ke SQLite.
12. Ganti nama peninggalan Solana; satukan bahasa kode vs bahasa UI.
13. Tambah `ecosystem.config.js`/Dockerfile agar deployment reproducible.

---

## 8. Catatan verifikasi

Semua temuan di atas diverifikasi langsung pada checkout ini:

- `npm install` → 201 paket, `npm audit` → 9 kerentanan (2 kritis)
- `npm run verify` → **QC PASSED** (35 file syntax OK, 9 smoke suite lulus, Python syntax OK)
- Bug K-1 direproduksi dengan `node -e` (`BigInt("2.5e+24")` → TypeError)
- Encoding/CRLF dipindai per-file dengan `grep`/`od`
- Selisih env var dihitung dengan `comm` antara `.env.example` dan hasil grep `process.env.*`

---

## 9. Investigasi lanjutan: "token tidak bisa dijual, tidak ada pair aktif"

Tiga bug terpisah di jalur EXIT, semuanya membuat bot menolak menjual padahal
pool-nya kemungkinan masih bisa di-swap. Ketiganya sudah diperbaiki.

### 🔴 E-1 · Likuiditas tick-aktif dipakai memveto rute **[SUDAH DIPERBAIKI]**

`pickMostLiquidPool()` menolak pool dengan `getLiquidity == 0`, dan
`resolveV3Route()` hanya menerima pool dengan `liquidity > 0n`. Kalau semua
kandidat nol, `resolveSwapRoute()` mengembalikan `null` → pesan
`No swap route for 0x… — tidak ada pool V3 (WETH) maupun V4 (ETH) dengan likuiditas`.
Itulah "tidak ada pair yang aktif".

Masalahnya: **`StateView.getLiquidity(poolId)` hanya melaporkan likuiditas pada
tick AKTIF**, bukan total isi pool. Di pool concentrated (V3/V4), harga yang
jatuh keluar dari seluruh range LP membuat nilainya 0 — padahal pool masih
berisi token dan swap tetap bisa jalan dengan melintasi tick ke range yang
masih punya likuiditas.

Akibatnya asimetris dan berbahaya: bot **membeli** saat harga masih di dalam
range LP, lalu harga anjlok (hal paling normal untuk memecoin), tick aktif
keluar dari range → `getLiquidity` jadi 0 → bot **menolak bahkan mencoba
menjual**. Posisi terkunci tepat ketika exit paling dibutuhkan.

Perbaikan: opsi `allowZeroLiquidity`, aktif **hanya untuk jual**. Untuk exit,
**quoter yang jadi otoritas**, bukan heuristik likuiditas. Perilaku beli tidak
berubah (regresi pool zero-liq 0x9e7a…c86 tetap dijaga), dan pool yang
`getLiquidity`-nya *revert* (pool hantu dari venue lain) tetap ditolak.

### 🔴 E-2 · Cooldown kegagalan ikut memblok jalur jual **[SUDAH DIPERBAIKI]**

`executeJupiterSwap()` mengecek `mintCooldownLeft(memeToken)` **sebelum**
cabang `if (isNativeIn)`, jadi gate itu mengenai beli *dan* jual. Padahal
`poisonPool()` memanggil `blockMint()` saat quote gagal — termasuk quote jual.

Efeknya berantai: satu quote jual yang gagal → mint masuk cooldown 30 menit →
setiap percobaan exit berikutnya ditolak mentah-mentah **tanpa menyentuh chain
sama sekali**. Ini bertentangan langsung dengan prinsip yang sudah ditulis
sendiri di repo untuk `routelessCooldown`: *"Untuk JUAL sengaja tidak
di-cooldown: exit posisi harus terus dicoba."*

Perbaikan: `mintCooldownLeft` dipindahkan ke dalam cabang `isNativeIn`.

### 🟡 E-3 · Diagnostik tidak bisa membedakan rug dari bug **[DIPERBAIKI]**

`scripts/probe-route.js` lama hanya menguji arah BELI dan langsung `exit(1)`
begitu rute tidak ketemu — persis kasus yang paling perlu didiagnosis.

Sekarang skrip itu: menampilkan rute beli **dan** jual (gate longgar), melaporkan
likuiditas tanpa memveto, dan menjalankan **quote bulak-balik**
(beli X ETH → Y token → jual Y token → Z ETH). Pola hasilnya langsung
memisahkan penyebab:

| Hasil | Arti |
|---|---|
| beli OK, jual revert | **honeypot** — transfer/jual di-gate |
| dua arah OK, Z ≈ X | pool sehat, dulu hanya gagal resolve (bug E-1/E-2) |
| dua arah OK, Z ≪ X | pajak tinggi / likuiditas nyaris habis |
| dua arah revert | LP ditarik habis, atau pool hidup di venue lain |

---

## 10. `/adopt` — jaring pengaman untuk token nyasar

Ditambahkan sebagai konsekuensi langsung dari K-0: kalau sebuah pembelian sukses
on-chain tapi posisinya gagal tercatat, token itu duduk di wallet **tanpa
TP/SL** dan monitor tidak tahu token itu ada. Sebelumnya tidak ada cara
memulihkannya selain menulis baris SQL manual.

```
/adopt <mint> [size_eth] [entry_price_usd]
```

- Membaca **saldo nyata on-chain** (`balanceOf`) — kalau 0, ditolak.
- Menyimpan saldo sebagai **string uint256 apa adanya**, tidak lewat `Number()`
  (pelajaran dari K-1: nilai ≥ 1e21 berubah jadi `"2.5e+24"` dan `BigInt()`
  melempar saat jual).
- `execution_mode = 'live'` — token ini nyata, jadi exit harus lewat jalur live.
- Menolak kalau sudah ada posisi terbuka untuk mint tersebut.
- `size_eth` default ke ukuran posisi strategi aktif; `entry_price_usd` default
  ke harga pasar saat ini, dengan **peringatan eksplisit** bahwa PnL dihitung
  dari titik adopsi, bukan dari harga beli sebenarnya.
- **Tidak mengirim transaksi apa pun.**

Sebelum mencatat, `/adopt` memanggil `resolveSwapRoute(..., { allowZeroLiquidity: true })`
dan melaporkan apakah rute exit benar-benar ada. Kalau tidak ada — misalnya LP
sudah ditarik — posisi tetap dicatat agar terlihat di `/positions`, tapi balasannya
menyatakan terang-terangan bahwa exit otomatis tidak akan berhasil. Mengadopsi
token rug tanpa peringatan hanya memberi rasa aman palsu.

Suite baru `scripts/smoke-adopt.js` (16 assert) terdaftar di `npm run verify`,
dengan fokus pada round-trip presisi uint256 dan integrasi ke `openPositions()`.
