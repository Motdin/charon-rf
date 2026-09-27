import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Charon-RH';
export const DB_PATH = process.env.DB_PATH || './charon-rh.sqlite';

// Robinhood Chain — EVM L2 (Arbitrum Orbit), chainId 4663
export const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
export const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
export const WS_URL = process.env.WS_URL || 'wss://robinhood-rpc.publicnode.com';

// Token addresses on Robinhood Chain
export const WETH_ADDRESS = process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG_ADDRESS = process.env.USDG_ADDRESS || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

// Uniswap SwapRouter02 (works for V3 exactInputSingle; Universal Router optional)
export const UNISWAP_ROUTER = process.env.UNISWAP_ROUTER || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const UNISWAP_QUOTER = process.env.UNISWAP_QUOTER || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
export const UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY || '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
export const UNISWAP_V4_POOL_MANAGER = process.env.UNISWAP_V4_POOL_MANAGER || '0x0000000000000000000000000000000000000000';

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
export const DEXSCREENER_POLL_MS = Number(process.env.DEXSCREENER_POLL_MS || 30_000);
export const ONCHAIN_EVENTS_ENABLED = process.env.ONCHAIN_EVENTS_ENABLED !== 'false';
export const ONCHAIN_POLL_MS = Number(process.env.ONCHAIN_POLL_MS || 15_000);
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
