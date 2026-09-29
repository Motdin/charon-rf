import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Charon-RH';
export const DB_PATH = process.env.DB_PATH || './charon-rh.sqlite';

// Robinhood Chain — EVM L2 (Arbitrum Orbit), chainId 4663
export const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
export const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
export const WS_URL = process.env.WS_URL || 'wss://robinhood.drpc.org';
// Failover HTTP: pisah dengan koma. Contoh:
// RPC_FALLBACK_URLS=https://robinhood.drpc.org,https://robinhood-rpc.publicnode.com
export const RPC_FALLBACK_URLS = (process.env.RPC_FALLBACK_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// WebSocket newHeads watcher (bisa dimatikan jika WS tidak stabil di region Anda)
export const WS_WATCHER_ENABLED = process.env.WS_WATCHER_ENABLED !== 'false';

// Token addresses on Robinhood Chain
export const WETH_ADDRESS = process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG_ADDRESS = process.env.USDG_ADDRESS || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

// Uniswap on Robinhood Chain (chainId 4663).
// ⚠️ JANGAN pakai alamat canonical Ethereum mainnet di sini — alamat-alamat itu
// BUKAN kontrak di RH Chain (contoh: SwapRouter02 mainnet 0x68b3...45fc = EOA mati,
// dana yang di-approve ke sana hangus). Alamat di bawah sudah diverifikasi on-chain:
//   - SwapRouter02        0xCaf6...5cb2  (verified "SwapRouter02" di Blockscout)
//   - UniswapV3Factory    0x1f7d...2EfA  (verified "UniswapV3Factory")
//   - V4 PoolManager      0x8366...0951  (verified "PoolManager")
//   - V4 UniversalRouter  0x8876...0904  (verified; encoding V4_SWAP standar —
//                                          dibuktikan byte-identik dengan tx sukses di mainnet)
//   - V4 Quoter           0x8Dc1...8F94  (official v4-periphery V4Quoter)
export const UNISWAP_ROUTER = process.env.UNISWAP_ROUTER || '0xCaf681a66D020601342297493863E78C959E5cb2';
export const UNISWAP_QUOTER = process.env.UNISWAP_QUOTER || ''; // V3 QuoterV2 — belum dikenal di RH; kosong = quote via simulasi
export const UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY || '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';

// Uniswap V4
export const UNISWAP_UNIVERSAL_ROUTER = process.env.UNISWAP_UNIVERSAL_ROUTER || '0x8876789976dEcBfCbBbe364623C63652db8C0904';
export const UNISWAP_V4_POOL_MANAGER = process.env.UNISWAP_V4_POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const UNISWAP_V4_QUOTER = process.env.UNISWAP_V4_QUOTER || '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
export const UNISWAP_V4_STATE_VIEW = process.env.UNISWAP_V4_STATE_VIEW || '0xF3334192D15450CdD385c8B70e03f9a6bD9E673b';
export const PERMIT2_ADDRESS = process.env.PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const LIVE_V4_ENABLED = process.env.LIVE_V4_ENABLED !== 'false';
// Lower bound log-scan: blok deploy protokol Uniswap di RH Chain (hemat RPC getLogs)
export const V4_DEPLOY_BLOCK = BigInt(process.env.V4_DEPLOY_BLOCK || 7_887_312);

// Live execution safety
export const SWAP_DEADLINE_SECONDS = Number(process.env.SWAP_DEADLINE_SECONDS || 300);
export const LIVE_UNWRAP_ON_FAIL = process.env.LIVE_UNWRAP_ON_FAIL !== 'false';

export const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 300);
export const LIVE_MIN_ETH_RESERVE = Number(process.env.LIVE_MIN_ETH_RESERVE || 0.005);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
export const TRADING_MODE = process.env.TRADING_MODE || 'dry_run';

export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';

export const DEXSCREENER_ENABLED = process.env.DEXSCREENER_ENABLED !== 'false';
// Discovery = search/profiles/trending.
// Default ON (aman untuk .env lama). Matikan dengan DEX_DISCOVERY_ENABLED=false
export const DEX_DISCOVERY_ENABLED = process.env.DEX_DISCOVERY_ENABLED !== 'false';
export const DEXSCREENER_POLL_MS = Number(process.env.DEXSCREENER_POLL_MS || 30_000);
export const ONCHAIN_EVENTS_ENABLED = process.env.ONCHAIN_EVENTS_ENABLED !== 'false';
export const ONCHAIN_POLL_MS = Number(process.env.ONCHAIN_POLL_MS || 30_000);
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
export const SIGNAL_MIN_SOURCE_COUNT = Number(process.env.MIN_SOURCE_COUNT || 2);

export const BLOCKSCOUT_API = process.env.BLOCKSCOUT_API || 'https://robinhoodchain.blockscout.com/api';

// Pons launchpad — Robinhood Chain launch feed (public, no key)
// https://docs.ponsfamily.com/llms.txt
export const PONS_ENABLED = process.env.PONS_ENABLED !== 'false';
export const PONS_POLL_MS = Number(process.env.PONS_POLL_MS || 30_000);
export const PONS_API_BASE = process.env.PONS_API_BASE || 'https://www.ponsfamily.com/api';
export const PONS_LOOKBACK_MS = Number(process.env.PONS_LOOKBACK_MS || 30 * 60_000);

// GMGN OpenAPI — optional primary enrichment (free tier: 5 weight/window).
// When unavailable the pipeline falls back to DexScreener + Blockscout.
export const GMGN_ENABLED = process.env.GMGN_ENABLED === 'true';
export const GMGN_API_KEY = process.env.GMGN_API_KEY || '';
export const GMGN_CHAIN = process.env.GMGN_CHAIN || 'robinhood';
export const GMGN_BASE_URL = process.env.GMGN_BASE_URL || 'https://openapi.gmgn.ai';
export const GMGN_CACHE_TTL_MS = Number(process.env.GMGN_CACHE_TTL_MS || 3 * 60_000);

export const CHAIN = {
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (TRADING_MODE === 'live' && !PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is required for live trading.');
  }
}
