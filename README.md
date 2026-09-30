# Charon-RH

A Charon-style trench agent for **meme tokens on Robinhood Chain** (EVM L2, chainId **4663**).

Adapted from [yunus-0x/charon](https://github.com/yunus-0x/charon) (Solana / Pump.fun) to EVM:

| Charon (Solana) | Charon-RH (Robinhood L2) |
|---|---|
| Pump.fun fee-claim WS | Volume spikes + on-chain Uniswap Swap activity |
| Graduated tokens | New Uniswap pools / fresh pairs |
| Trending feed | DexScreener trending/search |
| GMGN enrichment | Blockscout holders + concentration |
| Jupiter Ultra | Uniswap V4 (native-ETH pools) / V3 routing |
| SOL reserve | ETH reserve |
| SQLite + Telegram | SQLite + Telegram (same UX) |

> ⚠️ **Testing period.** No performance guarantees. Meme tokens are extremely high risk. Start in `dry_run`.

---

## How it works

```mermaid
flowchart TD
    A[DexScreener poll] --> E[Overlap gate]
    B[Uniswap on-chain events] --> E
    C[Price alerts dip_buy] --> E
    D[Pons launchpad feed] --> E
    E --> F[Enrich: security + smart money + GMGN/Dex]
    F --> G[Strategy filters]
    G -->|passed| H[LLM batch pick max 1 BUY]
    H --> I{Mode}
    I -->|dry_run| J[Simulate position]
    I -->|confirm| K[Telegram approve]
    I -->|live| L[Uniswap swap V4/V3]
    J & K & L --> M[TP / SL / Trailing / Partial / MaxHold]
```

## Strategies

| id | Entry | Focus | TP / SL | LLM |
|---|---|---|---|---|
| `sniper` | immediate | overlap ≥2 + volume spike + early pool | +50% / −25% trailing 20% | on |
| `dip_buy` | wait_for_dip | buy −35% dip alerts | +30% / −20% trailing 15% | on |
| `smart_money` | immediate | holders ≥200, top10 ≤45%, partial TP | +100% / −25% partial 50%@100% | on |
| `degen` | immediate | loose, rule-based | +30% / −15% trailing 10% | **off** |

Activate one from Telegram with `/strategy <id>` or `/menu`.

## Getting started

```bash
cd charon-rh
npm install
cp .env.example .env
# edit .env
npm start
```

### Required

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### Recommended

```
TRADING_MODE=dry_run
ENABLE_LLM=true
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
RPC_URL=https://rpc.mainnet.chain.robinhood.com
```

### Live trading (use at your own risk)

```
TRADING_MODE=live   # or confirm for human-in-the-loop
PRIVATE_KEY=0x...
LIVE_MIN_ETH_RESERVE=0.005
SLIPPAGE_BPS=300
```

> ⚠️ **Uniswap contracts — never use canonical mainnet addresses here.** The old
> SwapRouter02 `0x68b3…45fc` and factory `0x3312…fdfd` defaults were *Ethereum
> mainnet* addresses — on Robinhood Chain those addresses are **not contracts**
> (dead EOAs). The repo defaults now point at the verified Robinhood Chain
> deployments, and the bot refuses to boot in `live`/`confirm` mode if any router
> contract has no bytecode (boot-time preflight). Details:
> [Live execution routing](#live-execution-routing-v4v3).

---

## Telegram commands

```
/menu              interactive settings (Strategy / Mode / Status / PnL)
/status            mode + strategy + open positions
/strategy          list / activate strategies
/stratset <id> <key> <value>
                   hot-edit any strategy parameter (no restart)
                   e.g. /stratset sniper tp_percent 75
/positions         open + closed (entry/exit USD price + CA)
/adopt <mint> [size_eth] [entry_usd]
                   catat token yang SUDAH ada di wallet sebagai posisi
                   terpantau (TP/SL aktif). Tidak mengirim transaksi.
/pnl               win rate + net ETH
/pnlcard [YYYY-MM-DD]
                   daily PnL card PNG (1200×675) ready for X / Twitter
/pnlcard text [YYYY-MM-DD]
                   copy-paste text card for X
/failures          last 8 rejected candidates + why
/filters           active thresholds
/learn [1h|24h|7d] LLM analyze closed trades → store lessons
/lessons           list active lessons
/lessondel <id>    delete a lesson
/wallets           list tracked smart wallets
/walletadd <label> <0x…>
/walletremove <label>
/security <0x mint>  rug/honeypot check
/intents           pending confirm trades
/confirm <id>      approve live buy
/reject  <id>      reject
/mode dry_run|confirm|live
/enable on|off     toggle auto-buy
/cancel            abort pending interactive edit
```

### `/menu → Strategy` (Charon parity)

Inline keyboard flow:

1. `/menu` → **Strategy**
2. Pick `sniper` / `dip_buy` / `smart_money` / `degen`
3. See the current card + quick-edit buttons (TP, SL, trailing, size, max pos, LLM conf…)
4. **Activate**, or tap a field to edit it

**Interactive editing** (no `/stratset` typing needed):

- Tap a numeric/enum field → the bot prompts → type the new value → saved immediately
- Tap a bool field → toggles instantly (on/off)
- `/cancel` aborts a pending prompt (3-minute TTL)

`/stratset <id> <key> <value>` still works for the full key list (32 fields).

Every edit is written to the SQLite `strategies.config_json` row and is **hot-read** by
`activeStrategy()` — the next candidate uses the new values immediately.

---

## Example Telegram sessions

### 1. First boot & status

```
You:  /status
Bot:  Charon-RH status
      Mode: dry_run
      Strategy: sniper (Sniper)
      Open positions: 0/3
      Agent: ON
      GMGN: off → DexScreener + Blockscout
```

### 2. Browse the menu → edit a strategy interactively

```
You:  /menu
Bot:  Charon-RH menu
      [📊 Status]  [🎯 Strategy]
      [⚙️ Mode]    [📈 Positions]
      [🔍 Filters] [💰 PnL]
      [🤖 Agent on/off]

You:  (tap 🎯 Strategy)
Bot:  ▶️ sniper — Sniper
        Entry: immediate · sources ≥ 2 + vol spike
        Mcap: $5.0k–$500.0k · Liq ≥ $5.0k
        Holders ≥ 20 · Top10 ≤ 60% · Rug ≤ 0.5
        TP 50% / SL -25% · Trail 20%
        Partial: off
        Size 0.05 ETH · Max pos 3
        LLM: on, conf ≥ 50
      [▶️ sniper] [▫️ dip_buy] [▫️ smart_money] [▫️ degen]

You:  (tap ▶️ sniper)
Bot:  (same card + editor buttons)
      [Take profit %: 50] [Stop loss %: -25]
      [Trailing %: 20]    [Position size ETH: 0.05]
      [Max open positions: 3] [LLM min confidence: 50]
      [Min source count: 2]  [Max rug score: 0.5]
      [✅ Activate] [⬅️ Strategies]

You:  (tap "Take profit %: 50")
Bot:  ✏️ Set Take profit %
      Strategy: sniper · key tp_percent
      Current: 50
      Type: num

      Send the new number value.
      Send /cancel to abort.

You:  75
Bot:  ✅ sniper → tp_percent = 75 (was 50)
      Hot-applied.
```

### 3. Bool toggle (instant, no typing)

```
You:  (tap a bool field)
Bot:  ▶️ sniper — Sniper
        ...
        TP 75% / SL -25% · Trail 20% (off)   ← toggled
      ...
```

Or the command form:

```
You:  /stratset sniper trailing_enabled false
Bot:  ✅ sniper → trailing_enabled = false
      Applies immediately (hot-read).
```

### 4. Switch strategy + inspect filters

```
You:  /strategy degen
Bot:  Strategy set to degen

You:  /filters
Bot:  Filters — degen
      Sources ≥ 1
      Volume spike: optional
      Mcap: $3.0k – $150.0k
      Liq ≥ $2.0k · Vol24h ≥ $3.0k
      Holders ≥ 5 · Top10 ≤ 80%
      Rug ≤ 0.7
      TP 30% / SL -15% · Trail 10%
      Size 0.02 ETH · Max pos 5
      LLM: off (rule-based)
```

### 5. Dry-run: signal → entry → TP exit

```
Bot:  🧪 Batch #12 screened 4 · verdict BUY (conf 82)
      Best asymmetric: FUSU fresh pool + volume spike + on-chain swaps.

Bot:  🟢 Position opened
      FUSU #3
      Status: open · Mode: dry_run
      Entry: $48.2k mcap · Size: 0.0500 ETH
      PnL: +0.0%

      … (monitored every 10s) …

Bot:  ✅ Position closed TRAILING_TP
      FUSU #3
      Status: closed · Mode: dry_run
      Entry: $48.2k mcap · Size: 0.0500 ETH
      PnL: +61.4%
      Exit: TRAILING_TP
      PnL ETH: +0.0307 ETH
```

### 6. Confirm mode: human-in-the-loop

```
You:  /mode confirm
Bot:  Trading mode set to confirm

Bot:  🟡 Trade intent #7 — awaiting confirmation

      SCROOGE SCROOGE
      Mint: 0x4d4…1bfd
      Signals: volume+new+trending (×3)
      Mcap: $35.8k · Liq: $49.3k · Vol24h: $38.7k
      Holders: 118 · Top10: 27%
      Price: $0.00006650 · Rug: 0.15

      Decision: BUY (conf 78)
      Fresh pool + volume spike, holder distribution healthy.

Bot:  Intent #7: approve live buy?
      [✅ Approve]  [❌ Reject]

You:  (tap ✅ Approve)
Bot:  🟢 Position opened
      SCROOGE #8
      Status: open · Mode: live
      ...
```

Or reject:

```
You:  /reject 7
Bot:  Rejected trade intent #7.
```

### 7. PnL & positions review

```
You:  /pnl
Bot:  PnL summary
      Closed trades: 12
      Win rate: 58.3%
      Net: +0.1840 ETH

You:  /positions
Bot:  Open positions
      SCROOGE #8
      Status: open · Mode: live
      PnL: +12.1%

      Recently closed
      FUSU #3
      PnL: +61.4% · Exit: TRAILING_TP
```

### 8. Abort a pending edit

```
You:  (tapped a field, prompt is open)
You:  /cancel
Bot:  Edit cancelled.
```

### 9. Daily PnL card for X / Twitter

```
You:  /pnlcard
Bot:  (sends a 1200×675 PNG)
      📊 Daily PnL card — 2026-09-26
      🟢 **2026-09-26 · CHARON-RH**
      Net PnL: `+54.1%` (+0.0271 ETH)
      Win rate: `60.0%` (3W / 2L)
      Trades: 5 · Open: 0
      Best: FUSU `+61.4%`
      Worst: AGQLX `-25.0%`

      Ready to post on X.

You:  /pnlcard text
Bot:  📋 PnL text card — 2026-09-26
      (pre-formatted block — copy to X)

You:  /pnlcard 2026-09-25
Bot:  (PNG for that specific date)
```

The card is generated by `scripts/render_pnl_card.py` (Pillow) from
`dry_run_positions` closed trades for that UTC day. It covers:

- Net PnL % + ETH
- Win rate (W/L)
- Trades · open positions
- Best / worst ticker
- Cumulative PnL sparkline
- Strategy + execution mode
- `not financial advice` footer for X compliance

---

## Enrichment sources (priority order)

| # | Source | What it gives | Cost |
|---|---|---|---|
| 1 | **GMGN OpenAPI** (`chain=robinhood`) | price, mcap, liq, holders, fees, socials | free tier **5 weight** / window |
| 2 | **DexScreener** | pairs, volume, txns, age, price change | free / public |
| 3 | **Blockscout** | holder list, top-10 concentration | free / public |
| 4 | **Security check** (local) | honeypot/mint/owner/proxy/tax | RPC `eth_call` |
| 5 | **Smart money** | saved wallets + sniper/insider | Blockscout holders + transfers |
| 6 | **Pons launchpad** | launch/graduation feed, fixed-supply tokens | free / public |

When GMGN is disabled, out of weight, rate-limited, or erroring, the pipeline
**automatically falls back** to DexScreener + Blockscout — same candidate shape,
no crash, no stall.

```env
GMGN_ENABLED=true
GMGN_API_KEY=gmgn_xxx
GMGN_CHAIN=robinhood
GMGN_WEIGHT_BUDGET=5          # free tier
GMGN_WEIGHT_WINDOW_MS=60000   # reset window
GMGN_REQUEST_DELAY_MS=2500    # 1 req / 5s max (official rule)
```

Check the current budget from Telegram `/status` or the boot logs.

### Pons launchpad signal

[Pons](https://www.ponsfamily.com/launchpad) is the Robinhood Chain launchpad:
fixed **1B supply**, WETH pool with **LP locked at creation**, graduation threshold.

| API | Purpose |
|---|---|
| `GET /api/pons-launches?limit=100` | launch feed (new + graduated) |
| `GET /api/pons-token/{token}` | token details |
| `GET /api/pons-market/{token}` | market snapshot |

- Factory v1: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
- Factory v2: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- Docs: https://docs.ponsfamily.com/llms.txt

Each fresh launch / graduation becomes a candidate with the signal label `pons`
(plus `graduated` when complete) — the Charon equivalent of the Pump.fun
`fee-claim` + `graduated` overlap.

```env
PONS_ENABLED=true
PONS_POLL_MS=30000
PONS_LOOKBACK_MS=1800000
```

### Security check (`/security 0x…`)

Rug/honeypot enrichment for EVM meme tokens:

- Contract code exists + Blockscout verification
- `owner()` / `getOwner()` mint authority (flags EOA owners)
- Suspicious selectors: `mint`, `blacklist`, `pause`
- Honeypot probes — 3-layer `eth_call` transfer simulation:
  1. **zero-balance account** — a healthy ERC20 reverts with a balance error;
     a gate checks its whitelist *first* and reverts **with no reason** (this is
     exactly what makes live V4 simulation fail — funds never move)
  2. **real EOA holder** — if a top holder can't transfer 1 dust unit, selling is blocked
  3. **Permit2 as spender** — tests the exact spender path live swaps use
- Proxy / upgradeability
- Risk score 0..1 → `PASS` / `WARN` / `FAIL`

Strategy gates: `require_security_pass`, `max_security_risk`. **Verdict `FAIL` is a
hard floor for every strategy** — a token whose transfers are provably gated is
rejected no matter how loose the strategy (even `degen` can't buy what can't be sold).

### Smart money tracking

- `/walletadd <label> 0x…` — track a wallet (yours or a whale)
- `/wallets` / `/walletremove <label>`
- Sniper detection: early buyers from first transfers still holding
- Insider heuristic: early buyers with >2% share or clustered buys
- Strategy gates: `min_saved_wallet_holders`, `max_insider_count`, `max_sniper_share_percent`

Optional external APIs (best-effort, may not cover chain 4663):
`fetchGoPlusSecurity`, `fetchHoneypotIs` in `src/enrichment/security.js`.

---

## Overlap signals (the Charon idea)

A candidate is stronger when **multiple sources agree**:

1. **volume_spike** — DexScreener 5m/24h volume anomaly or txn burst
2. **new_pool / fresh_pair** — newly created Uniswap pool or young pair. The
   on-chain watcher sees **every new V4 pool the second its `Initialize` event
   lands** (plus V3 `PoolCreated`), immediately pulls its DexScreener pair data
   per-token, and caches the poolKey for the executor
3. **trending** — elevated volume + swaps
4. **onchain** — V4/V3 Swap events tracked per-token; a burst of on-chain swaps
   in a short window counts as a volume-spike-class signal on its own

> ℹ️ **Discovery**: DexScreener's free API has no per-chain trending feed — its
> keyword search only catches the same large caps by name. Real market discovery
> therefore comes from the **on-chain watcher (V4 first)** plus
> `/token-profiles` & `/token-boosts` polls; keyword search is just a
> background large-cap sampler.
5. **pons launchpad** — fresh launch / near-graduation from `ponsfamily.com`
   (LP locked at creation, fixed 1B supply, graduation threshold)

Strategies set `min_source_count` (sniper/smart_money require ≥2). This replaces
the Pump.fun fee-claim overlap with EVM-native evidence of real economic activity.

---

## Live execution routing (V4/V3)

The live executor picks the right venue per token automatically
(`src/liveExecutor.js` → `resolveSwapRoute`):

| Venue | When it's used | Robinhood Chain contracts (verified) |
|---|---|---|
| **Uniswap V4** (primary) | Meme pools quoted in **native ETH** — the standard for RH memes (`v4` label on DexScreener; `pairAddress` = 32-byte poolId) | UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904` · PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` · Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` · StateView `0xF3334192D15450CdD385c8B70e03f9a6bD9E673b` |
| **Uniswap V3** | A WETH–token pool exists on the V3 factory | SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` · Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |

How routing works:

1. **Route resolution**: DexScreener pair (`labels`) → SQLite `v4_pools` cache → V3 factory scan → V4 `Initialize` log scan on the PoolManager. Fee, tickSpacing and hooks are always read from on-chain logs — never guessed.
2. **V4**: buying into a native-ETH pool needs no wrapping at all (settlement via `msg.value`); quotes come from the off-chain V4Quoter → full `simulateContract` → only then is a transaction sent. ERC20 sells go through **Permit2** (`0x0000…BA3`). The V4_SWAP calldata is verified **byte-identical** to a successful on-chain transaction (golden test in `scripts/smoke-executor.js`).
3. **V3**: quote via simulation, wrap **only the WETH deficit**, `amountOutMinimum` derived from the quote with `SLIPPAGE_BPS`.
4. **Fund-safety rails**:
   - Boot-time preflight (`live`/`confirm`): every router contract must have bytecode — otherwise the bot **stops** with a clear error.
   - **Quotes and simulation happen before** any value-bearing transaction.
   - The reserve check counts native ETH **+ WETH**; the gas reserve must stay native.
   - If a swap fails after wrapping → **automatic unwrap rollback** (`LIVE_UNWRAP_ON_FAIL=true`).
   - Unsupported pools/currencies (quote asset other than ETH/WETH) → rejected before funds move.

Utilities:

```bash
node scripts/probe-route.js <mint> [amountEth]   # read-only: venue + poolKey + V4 quote
node scripts/revoke-weth.js [spender...]         # clean WETH approvals to dead addresses
```

---

## LLM providers & quota safety

Any **OpenAI-compatible** provider works (`LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`).
Free tiers that fit a trench bot's call volume:

| Provider | `LLM_BASE_URL` | Example `LLM_MODEL` | Free tier (approx.) |
|---|---|---|---|
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | ~14k req/day |
| **Google AI Studio** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | ~1.5k req/day |
| **Cerebras** | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | ~1M tokens/day |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` | ~50 req/day (`:free` models) |

> Limits change — check the provider's current page. The response is parsed as
> strict JSON, and the parser also salvages JSON from non-`json_object` models.

Built-in quota protection (works with any provider):

- **429/error backoff** — consecutive failures pause ALL LLM calls
  exponentially (5 min → 30 min max). While paused, candidates become WATCH
  (no buys happen without LLM insight — fail-safe by design)
- **Call budget** — `LLM_MAX_CALLS_PER_HOUR` (default 40) and
  `LLM_MAX_CALLS_PER_DAY` (default 400); `0` = unlimited
- **Backup provider** — set `LLM_BACKUP_BASE_URL` / `LLM_BACKUP_API_KEY` /
  `LLM_BACKUP_MODEL` and the bot fails over automatically when the primary
  429s out. Pair two free providers (e.g. Groq primary + Gemini backup) and
  you effectively never stop screening
- Counters are in-memory (restart resets them); check usage anytime with
  `/status` → `LLM: x/40 per jam · x/400 per hari · backup siaga`

## Risk controls

- Fixed position size per strategy (`position_size_eth`)
- `max_open_positions` cap (per strategy: degen=5, others=3)
- **1 open position per token** — no duplicate buys while holding
- Fresh filter re-check before every execution (anti-stale)
- ETH reserve floor (`LIVE_MIN_ETH_RESERVE`)
- TP / SL / trailing TP / optional partial TP / max hold
- **PnL from USD price** (`price / entry_price`), not market cap
- Trailing tracks **price high-water**, not mcap
- SL is a *trigger threshold* (polled every `POSITION_CHECK_MS`) — not a
  guaranteed fill; violent memecoin dumps can exit worse than the SL target
- Rug score (liquidity, holder concentration, age, volume/liq ratio)
- **Wash-volume guard**: vol24h > 50× liquidity is a wash-trading signature
  (organic memes turn over 1–25×/day) → auto-reject. Tune per strategy with
  `/stratset <id> max_volume_liquidity_ratio <n>` (`0` disables, code default 50)
- 100+ holders with 0% visible top-10 concentration = hidden/sybil distribution
  → rug-score bump + flagged to the LLM as an anomaly
- Security gate: honeypot / mint / owner / proxy (`require_security_pass`)
- Default mode is `dry_run` — no wallet needed

### Debug: `/failures`

Shows the last 8 rejected candidates and the exact filter reasons — use this
to tune `/stratset` instead of guessing.

## Learning loop (LLM)

Charon-RH can learn from its own closed trades and feed lessons back into
future buy decisions.

```mermaid
flowchart LR
    A[Closed trades] --> B["/learn 24h"]
    B --> C[LLM extracts lessons]
    C --> D[learning_lessons table]
    D --> E[injected into next LLM prompt]
    E --> F[better BUY / WATCH / PASS]
    F --> A
```

| Command | What it does |
|---|---|
| `/learn 24h` | Analyze last 24h of closed trades with the LLM → store 1–5 lessons |
| `/learn 1h` / `6h` / `7d` | Other windows |
| `/lessons` | Show active lessons with evidence |
| `/lessondel <id>` | Remove a lesson |

Example lesson:

```
🔴 SL exits hit avg -28% vs target -15% — widen SL or check price source
   [5/8 SL, avg loss -28%]
```

- The **LLM** (OpenAI-compatible: `LLM_BASE_URL` / `LLM_MODEL`) returns strict JSON
  `{lessons:[{lesson, evidence, severity}]}`
- **Fallback** when the LLM is off or fails: rule-based lessons from stats
  (win rate, SL ratio, avg loss, net PnL)
- Stored lessons are injected as `recent_lessons` into every LLM batch decision
  (`src/pipeline/llm.js` → `activeLessonsForPrompt`)
- Table: `learning_lessons` in SQLite

Typical cadence: run `/learn 24h` once a day after a dry-run session.

## Storage

`charon-rh.sqlite` holds candidates, LLM decisions/batches, positions, trades, intents, decision logs, signal events, price alerts, strategies, and the V4 pool cache.

Open positions resume monitoring after a restart.

## Project layout

```
charon-rh/
  index.js
  src/
    config.js
    app.js
    db/            sqlite schema + strategy seeds + v4_pools cache
    signals/       dexscreener, uniswapEvents, priceMonitor, pons
    enrichment/    gmgn, blockscout, security, wallets, aggregate
    pipeline/      candidateBuilder, llm, orchestrator
    learning/      lessons.js — LLM trade review → /learn
    execution/     router (buy/sell), positions (TP/SL, price-based PnL),
                   v4 (Universal Router/Quoter/poolKey), swapMath (pure helpers)
    telegram/      bot + menu + format
    liveExecutor.js  viem + V4 (native ETH) / V3 (WETH) routing + fund-safety rails
  scripts/         smoke suites, verify, probe-route, revoke-weth, render_pnl_card.py
```

## Verify

```bash
npm run check    # syntax-check all modules
npm run build    # full QC (syntax + all smoke suites)
npm run verify   # same as build
npm test         # alias verify
```

## Notes

- Robinhood Chain public RPCs: `rpc.mainnet.chain.robinhood.com`, `robinhood-rpc.publicnode.com`, `robinhood.drpc.org`
- Explorers: [robinscan.io](https://robinscan.io), [Blockscout](https://robinhoodchain.blockscout.com)
- The DexScreener public API is rate-limited — polling intervals are intentionally conservative
- Live swaps route automatically to Uniswap **V4** (native-ETH meme pools — the primary venue on this chain) or **V3** (WETH pools) — see [Live execution routing](#live-execution-routing-v4v3)
- Tokenized stocks on Robinhood Chain settle via USDG and are **out of scope** of this meme-trench agent

---

## Donations

If this project helps you, consider supporting continued development.

| Coin | Address |
|---|---|
| **BTC** | `bc1pe5eee5eq34czkp2c08uqrdd8d296h8mf04fttwl53aw9pz9n6d0qkmukzm` |
| **ETH** | `0xE022E11cA86eFd2Aaa75A482B431738b2f45b3d5` |
| **SOL** | `GmkNNLK6dVPAoT3YdbKUXNbANEfHTaEL7NGAsvABZCQJ` |

```
BTC : bc1pe5eee5eq34czkp2c08uqrdd8d296h8mf04fttwl53aw9pz9n6d0qkmukzm

ETH : 0xE022E11cA86eFd2Aaa75A482B431738b2f45b3d5

SOL : GmkNNLK6dVPAoT3YdbKUXNbANEfHTaEL7NGAsvABZCQJ
```
