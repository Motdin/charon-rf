import {
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatEther,
  parseEther,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN,
  RPC_URL,
  PRIVATE_KEY,
  WETH_ADDRESS,
  UNISWAP_ROUTER,
  SLIPPAGE_BPS,
  LIVE_MIN_ETH_RESERVE,
  CHAIN_ID,
} from './config.js';
import { normalizeAddress, toNumber } from './utils.js';
import { publicClient, rpcEndpoints } from './lib/rpc.js';

/**
 * Live executor for Robinhood Chain via Uniswap V3 SwapRouter02.
 * Uses exactInputSingle (token <-> WETH). Native ETH is wrapped first if needed.
 */

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// SwapRouter02 exactInputSingle
const ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams calldata params) payable returns (uint256 amountOut)',
]);

// Common Uniswap V3 fee tiers
const FEE_TIERS = [500, 3000, 10000, 100];

// publicClient dari lib/rpc.js — multi-endpoint failover
let walletClient = null;
let account = null;

function ensureWallet() {
  if (walletClient) return { walletClient, account };
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not set — required for live execution.');
  const key = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  account = privateKeyToAccount(key);
  walletClient = createWalletClient({
    account,
    chain: CHAIN,
    transport: http(RPC_URL),
  });
  return { walletClient, account };
}

export function liveWalletPubkey() {
  if (!PRIVATE_KEY) return null;
  try {
    const { account } = ensureWallet();
    return account.address;
  } catch {
    return null;
  }
}

export async function liveWalletBalanceLamports() {
  const { account } = ensureWallet();
  return publicClient.getBalance({ address: account.address });
}

export async function fetchLiveTokenBalance(mint) {
  const { account } = ensureWallet();
  return publicClient.readContract({
    address: normalizeAddress(mint),
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
}

async function ensureAllowance(token, spender, amount) {
  const { walletClient, account } = ensureWallet();
  const owner = account.address;
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (BigInt(current) >= BigInt(amount)) return;
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, BigInt(amount)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Execute a swap: inputMint -> outputMint for `amount` raw units of input.
 * If input is native ETH sentinel, we use msg.value.
 * Tries common Uniswap V3 fee tiers.
 */
export async function executeJupiterSwap({ inputMint, outputMint, amount }) {
  // Name kept similar to Charon for familiarity; this is Uniswap, not Jupiter.
  const { walletClient, account } = ensureWallet();
  const amountIn = BigInt(amount);
  const isNativeIn = !inputMint || inputMint === '0x0000000000000000000000000000000000000000';
  const tokenIn = isNativeIn ? normalizeAddress(WETH_ADDRESS) : normalizeAddress(inputMint);
  const tokenOut = normalizeAddress(outputMint);
  const router = normalizeAddress(UNISWAP_ROUTER);

  // Wrap ETH -> WETH when needed
  let actualTokenIn = tokenIn;
  let value = 0n;
  if (isNativeIn) {
    value = amountIn;
    const hash = await walletClient.writeContract({
      address: tokenIn,
      abi: WETH_ABI,
      functionName: 'deposit',
      value: amountIn,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  await ensureAllowance(actualTokenIn, router, amountIn);

  // Quote: estimate min-out with a rough slippage floor (we don't have a quoter dependency hard-required)
  // Try fee tiers; prefer 3000 (0.3%) then 500, 10000.
  let lastError = null;
  for (const fee of FEE_TIERS) {
    try {
      // Simulate first
      const { request, result } = await publicClient.simulateContract({
        address: router,
        abi: ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: actualTokenIn,
            tokenOut,
            fee,
            recipient: account.address,
            amountIn,
            amountOutMinimum: 0n, // rely on slippage via min-out after simulate
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: account.address,
      });

      const quotedOut = BigInt(result);
      const minOut = (quotedOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

      const hash = await walletClient.writeContract({
        ...request,
        args: [
          {
            tokenIn: actualTokenIn,
            tokenOut,
            fee,
            recipient: account.address,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        signature: hash,
        outputAmount: quotedOut.toString(),
        minOut: minOut.toString(),
        fee,
        sizeEth: Number(formatEther(amountIn)),
        chainId: CHAIN_ID,
        status: receipt.status,
      };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  // Fallback: if input was ETH, unwrap nothing — throw with detail
  throw new Error(`Swap failed on all fee tiers: ${lastError?.message || 'unknown error'}`);
}

export async function checkLiveReserve(needEth) {
  const balance = await liveWalletBalanceLamports();
  const need = parseEther(String(needEth));
  const reserve = parseEther(String(LIVE_MIN_ETH_RESERVE));
  return {
    balance,
    sufficient: balance >= need + reserve,
    need,
    reserve,
  };
}
