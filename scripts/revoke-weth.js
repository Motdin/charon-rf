#!/usr/bin/env node
/**
 * Revoke approval WETH (atau token lain) ke spender tertentu.
 *
 *   node scripts/revoke-weth.js                # revoke ke alamat mati canonical mainnet (default)
 *   node scripts/revoke-weth.js 0xabc... 0xdef...
 *   TOKEN_ADDRESS=0x... node scripts/revoke-weth.js 0xabc...
 *
 * Latar belakang: versi lama bot meng-approve WETH ke 0x68b3…45fc (SwapRouter02
 * MAINNET — EOA mati di Robinhood Chain). Approval ke EOA praktis tidak bisa
 * dieksploitasi (tidak ada yang pegang kuncinya), tapi sebaiknya dibersihkan.
 */
import '../src/config.js'; // load .env
import { revokeApproval, liveWalletPubkey } from '../src/liveExecutor.js';
import { WETH_ADDRESS } from '../src/config.js';

const KNOWN_DEAD_SPENDERS = [
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // SwapRouter02 MAINNET — EOA di RH Chain
  '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // UniswapV3Factory MAINNET — EOA di RH Chain
  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2 MAINNET — EOA di RH Chain
];

const args = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const spenders = args.length ? args : KNOWN_DEAD_SPENDERS;
const token = process.env.TOKEN_ADDRESS || WETH_ADDRESS;

const wallet = liveWalletPubkey();
if (!wallet) {
  console.error('PRIVATE_KEY tidak diset di .env — tidak bisa mengirim tx revoke.');
  process.exit(1);
}
console.log(`wallet : ${wallet}`);
console.log(`token  : ${token}`);
for (const spender of spenders) {
  try {
    // eslint-disable-next-line no-await-in-loop
    const res = await revokeApproval(token, spender);
    if (res.alreadyZero) {
      console.log(`· ${spender} — allowance sudah 0, skip`);
    } else {
      console.log(`✓ ${spender} — allowance ${res.allowance} → 0 | tx ${res.hash}`);
    }
  } catch (err) {
    console.log(`✗ ${spender} — gagal: ${err.message}`);
  }
}
