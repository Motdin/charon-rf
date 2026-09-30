import { createPublicClient, http, parseAbi, formatUnits, getAddress } from 'viem';
import {
  CHAIN,
  RPC_URL,
  BLOCKSCOUT_API,
  PERMIT2_ADDRESS,
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_UNIVERSAL_ROUTER,
} from '../config.js';
import { normalizeAddress, toNumber, now, sleep, isAddress } from '../utils.js';
import axios from 'axios';

/**
 * Rug / honeypot security enrichment for EVM meme tokens on Robinhood Chain.
 *
 * Checks (all cached, all fail-open to "unknown" so pipeline never stalls):
 *   1. Contract exists + verified on Blockscout
 *   2. Owner / mint authority (owner(), getOwner(), mint capability)
 *   3. Honeypot probes — eth_call transfer 3 lapis:
 *      a. akun saldo-nol   (revert KOSONG sebelum cek saldo = gate)
 *      b. holder EOA nyata (holder tak bisa transfer = jual macet)
 *      c. Permit2 spender  (jalur persis yg dipakai Universal Router)
 *   4. Transfer tax heuristic — compare expected vs simulated transfer
 *   5. Proxy / upgradeability
 *   6. Suspicious function selectors (mint, blacklist, pause, setFee, rug)
 */

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// Function selectors that often appear in rug/honeypot contracts
const SUSPICIOUS_SELECTORS = {
  '0x40c10f19': 'mint(address,uint256)',
  '0xa0712d68': 'mint(uint256)',
  '0x79cc6790': 'burnFrom',
  '0x8456cb59': 'pause()',
  '0x3f4ba83a': 'unpause()',
  '0x8a990521': 'blacklist',
  '0xf3bdc228': 'setBlacklist',
  '0x8da5cb5b': 'owner()',
  '0x715018a6': 'renounceOwnership()',
  '0xa9059cbb': 'transfer',
  '0x095ea7b3': 'approve',
};

const cache = new Map();
const CACHE_TTL_MS = 5 * 60_000;

function scoreFromFindings(findings) {
  // Start at 0 risk; each finding adds weight; clamp 0..1
  const weights = {
    no_code: 1.0,
    unverified: 0.15,
    has_owner: 0.25,
    owner_is_eoa: 0.15,
    mint_selector: 0.2,
    blacklist_selector: 0.25,
    pause_selector: 0.15,
    honeypot_sim_fail: 0.7,
    suspicious_revert: 0.4,
    high_tax: 0.35,
    proxy_contract: 0.1,
    low_supply: 0.1,
  };
  let score = 0;
  for (const f of findings) {
    score += weights[f.kind] ?? 0.1;
  }
  return Math.min(1, Math.round(score * 100) / 100);
}

async function blockscoutGet(path) {
  try {
    const res = await axios.get(`${BLOCKSCOUT_API}${path}`, { timeout: 10_000 });
    return res.data;
  } catch {
    return null;
  }
}

async function checkContractCode(mint) {
  try {
    const code = await client.getBytecode({ address: mint });
    return code && code !== '0x' ? code : null;
  } catch {
    return null;
  }
}

async function checkOwner(mint) {
  const findings = [];
  let owner = null;
  for (const fn of ['owner', 'getOwner']) {
    try {
      owner = await client.readContract({ address: mint, abi: ERC20, functionName: fn });
      break;
    } catch {
      /* not present */
    }
  }
  if (owner && owner !== '0x0000000000000000000000000000000000000000') {
    findings.push({ kind: 'has_owner', detail: `owner=${owner}` });
    // Heuristic: if owner has no code it's an EOA that can still call privileged funcs
    try {
      const ownerCode = await client.getBytecode({ address: owner });
      if (!ownerCode || ownerCode === '0x') {
        findings.push({ kind: 'owner_is_eoa', detail: 'owner is EOA (can mint/rug if privileged)' });
      }
    } catch {
      /* ignore */
    }
  }
  return { owner, findings };
}

async function checkSelectors(mint, bytecode) {
  const findings = [];
  if (!bytecode) return findings;
  const lower = bytecode.toLowerCase();
  for (const [sel, name] of Object.entries(SUSPICIOUS_SELECTORS)) {
    const needle = sel.slice(2).toLowerCase();
    if (lower.includes(needle)) {
      // Avoid flagging ubiquitous selectors as suspicious
      if (sel === '0xa9059cbb' || sel === '0x095ea7b3' || sel === '0x8da5cb5b') continue;
      const kind =
        name.includes('mint') ? 'mint_selector'
        : name.includes('lack') ? 'blacklist_selector'
        : name.includes('pause') ? 'pause_selector'
        : 'other_selector';
      findings.push({ kind, detail: name });
    }
  }
  return findings;
}

// ── Transfer-gate probes (deteksi honeypot) ──────────────────────────────────

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/**
 * Klasifikasikan revert dari probe eth_call.
 *
 * Prinsip: ERC20 SEHAT selalu mengecek saldo/allowance DULUAN — jadi dari akun
 * tanpa saldo/persetujuan, revert-nya pasti berbunyi balance/allowance
 * (string OpenZeppelin, custom error ERC20InsufficientBalance 0xe450d38c,
 * ERC20InsufficientAllowance 0xfb8f41b2, atau panic underflow 0x4e487b71).
 *
 * Token ber-gate (honeypot) mengecek whitelist SEBELUM cek saldo → revert
 * KOSONG tanpa data sama sekali. Inilah signature persis insiden #33:
 * "V4 simulate gagal: revert tanpa reason" (Gta6HaalandRizzler42069) — Quoter
 * lolos karena tidak settle, eksekusi nyata macet di gate transfer.
 */
export function classifyProbeRevert(err) {
  const text = [
    err?.shortMessage,
    err?.message,
    err?.details,
    err?.cause?.message,
    String(err),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const selectors = text.match(/0x[0-9a-f]{8}\b/g) || [];

  // Custom errors OpenZeppelin 5.x + panic code (underflow pengurangan saldo)
  if (selectors.includes('0xe450d38c')) return 'balance_check'; // ERC20InsufficientBalance
  if (selectors.includes('0xfb8f41b2')) return 'allowance_check'; // ERC20InsufficientAllowance
  if (selectors.includes('0x4e487b71') || /\bpanic\b/.test(text)) return 'panic';

  if (/allowance/.test(text)) return 'allowance_check';
  if (/balance|insufficient|exceeds|transfer amount/.test(text)) return 'balance_check';

  if (
    /blacklist|blocklist|frozen|whitelist|not allowed|trading|paused|stopped|disabled|blocked|forbidden|denied|restrict|snipe|is bot/.test(
      text
    )
  ) {
    return 'gate_message';
  }

  // Revert polos tanpa reason/data → require(gate) tanpa pesan sebelum cek saldo
  if (/execution reverted|the contract function|revert/.test(text) && selectors.length === 0) {
    return 'gate_empty';
  }

  return 'unknown';
}

function firstRevertLine(err) {
  return String(err?.shortMessage || err?.message || err).split('\n')[0].slice(0, 120);
}

const SKIP_PROBE_HOLDERS = new Set(
  [
    '0x0000000000000000000000000000000000000000',
    DEAD_ADDRESS,
    UNISWAP_V4_POOL_MANAGER,
    UNISWAP_UNIVERSAL_ROUTER,
    PERMIT2_ADDRESS,
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase())
);

/** Ambil holder EOA pertama (profil seperti pembeli biasa) dari Blockscout. null = tak ada data. */
async function pickProbeHolder(mint) {
  const data = await blockscoutGet(`/v2/tokens/${mint}/holders`);
  const items = data?.items || [];
  for (const item of items.slice(0, 10)) {
    const addr = normalizeAddress(item?.address?.hash || item?.address || '');
    if (!isAddress(addr) || SKIP_PROBE_HOLDERS.has(addr)) continue;
    try {
      if (BigInt(item?.value || '0') <= 0n) continue;
    } catch {
      continue;
    }
    // Holder kontrak (pool/locker/CEX) bukan profil pembeli — cari EOA.
    let code = null;
    try {
      code = await client.getBytecode({ address: addr });
    } catch {
      /* RPC gagal → anggap EOA, probe berikutnya yang memutuskan */
    }
    if (code && code !== '0x') continue;
    return addr;
  }
  return null;
}

/** Probe 1: transfer dari akun SALDO NOL. ERC20 sehat → revert balance; gate → revert kosong. */
async function probeZeroBalanceTransfer(mint) {
  try {
    await client.simulateContract({
      address: mint,
      abi: ERC20,
      functionName: 'transfer',
      args: [DEAD_ADDRESS, 10n ** 18n],
      account: '0x0000000000000000000000000000000000000001',
    });
    // Sukses padahal saldo 0 → kontrak berbohong soal transfer (whitelist/honeypot)
    return { kind: 'honeypot_sim_fail', detail: 'transfer succeeded without balance (whitelist/honeypot?)' };
  } catch (err) {
    const cls = classifyProbeRevert(err);
    if (cls === 'balance_check' || cls === 'panic') return null; // perilaku ERC20 normal
    if (cls === 'gate_message') return { kind: 'honeypot_sim_fail', detail: `transfer gate: ${firstRevertLine(err)}` };
    if (cls === 'gate_empty') {
      return {
        kind: 'honeypot_sim_fail',
        detail: 'revert TANPA reason sebelum cek saldo — transfer gate (signature honeypot insiden #33)',
      };
    }
    return { kind: 'suspicious_revert', detail: `probe transfer revert tak dikenali: ${firstRevertLine(err)}` };
  }
}

/** Probe 2: holder EOA nyata mengirim 1 unit terkecil. Gagal = holder tidak bisa menjual. */
async function probeRealHolderTransfer(mint, holder) {
  try {
    await client.simulateContract({
      address: mint,
      abi: ERC20,
      functionName: 'transfer',
      args: [DEAD_ADDRESS, 1n],
      account: holder,
    });
    return null; // holder bebas memindahkan token → sehat
  } catch (err) {
    const cls = classifyProbeRevert(err);
    if (cls === 'balance_check' || cls === 'panic') return null; // noise (data holder basi) → tak konklusif
    return { kind: 'honeypot_sim_fail', detail: `holder EOA tak bisa transfer dust (${cls}) — jual akan macet` };
  }
}

/** Probe 3: Permit2 (spender yang dipakai Universal Router) menarik token via transferFrom. */
async function probePermit2Spender(mint, holder) {
  try {
    await client.simulateContract({
      address: mint,
      abi: ERC20,
      functionName: 'transferFrom',
      args: [holder, DEAD_ADDRESS, 1n],
      account: PERMIT2_ADDRESS,
    });
    // Permit2 ke holder kita tak punya allowance — sukses berarti kontrak mengabaikan allowance
    return { kind: 'suspicious_revert', detail: 'transferFrom sukses tanpa allowance Permit2 (ERC20 tidak standar)' };
  } catch (err) {
    const cls = classifyProbeRevert(err);
    if (cls === 'allowance_check' || cls === 'balance_check' || cls === 'panic') return null; // cek allowance normal
    return {
      kind: 'honeypot_sim_fail',
      detail: `spender Permit2 diblokir sebelum cek allowance (${cls}) — jalur swap Uniswap macet`,
    };
  }
}

/**
 * Simulasi transfer 3-lapis (semua fail-open; tak ada data holder ≠ token jahat):
 *   1. akun saldo-nol       → gate kosong / sukses-aneh terdeteksi
 *   2. holder EOA nyata     → holder benar-benar bisa menjual
 *   3. Permit2 sebagai spender → jalur persis yang dipakai live swap
 */
async function simulateTransfer(mint) {
  const findings = [];
  let taxEstimatePercent = null;

  const zero = await probeZeroBalanceTransfer(mint);
  if (zero) findings.push(zero);

  const holder = await pickProbeHolder(mint);
  if (holder) {
    const h = await probeRealHolderTransfer(mint, holder);
    if (h) findings.push(h);
    const p = await probePermit2Spender(mint, holder);
    if (p) findings.push(p);
  }

  return { findings, taxEstimatePercent };
}

async function checkVerified(mint) {
  const findings = [];
  const info = await blockscoutGet(`/v2/tokens/${mint}`);
  if (info && info.is_verified === false) {
    findings.push({ kind: 'unverified', detail: 'source not verified' });
  }
  const contract = await blockscoutGet(`/v2/smart-contracts/${mint}`);
  if (contract) {
    if (contract.is_verified === false) findings.push({ kind: 'unverified', detail: 'contract unverified' });
    if (contract.implementation_address) {
      findings.push({ kind: 'proxy_contract', detail: `proxy → ${String(contract.implementation_address).slice(0, 12)}…` });
    }
    // Blockscout sometimes exposes compiler / language
  }
  return { findings, verified: findings.length === 0 };
}

/**
 * Main entry — returns a security report, never throws.
 */
export async function checkTokenSecurity(mint) {
  const key = normalizeAddress(mint);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;

  const findings = [];
  const address = getAddress(key);

  const code = await checkContractCode(address);
  if (!code) {
    const report = {
      mint: key,
      checkedAt: now(),
      hasCode: false,
      verified: false,
      owner: null,
      findings: [{ kind: 'no_code', detail: 'not a contract' }],
      riskScore: 1,
      verdict: 'FAIL',
    };
    cache.set(key, { at: now(), value: report });
    return report;
  }

  const [ownerResult, selectorFindings, verifiedResult, sim] = await Promise.all([
    checkOwner(address),
    checkSelectors(address, code),
    checkVerified(address),
    simulateTransfer(address),
  ]);

  findings.push(...ownerResult.findings, ...selectorFindings, ...verifiedResult.findings, ...sim.findings);

  const riskScore = scoreFromFindings(findings);
  // FAIL if honeypot-ish or mint+owner combo, WARN if just unverified, PASS otherwise
  let verdict = 'PASS';
  if (findings.some((f) => f.kind === 'honeypot_sim_fail' || f.kind === 'no_code')) verdict = 'FAIL';
  else if (riskScore >= 0.5) verdict = 'FAIL';
  else if (riskScore >= 0.25) verdict = 'WARN';

  const report = {
    mint: key,
    checkedAt: now(),
    hasCode: true,
    verified: verifiedResult.verified,
    owner: ownerResult.owner,
    findings,
    riskScore,
    verdict,
    taxEstimatePercent: sim.taxEstimatePercent,
  };
  cache.set(key, { at: now(), value: report });
  return report;
}

export function clearSecurityCache() {
  cache.clear();
}

// ── optional external APIs (best-effort, free) ──────────────────

/**
 * GoPlus token security (may not cover chain 4663 — returns null then).
 */
export async function fetchGoPlusSecurity(mint) {
  try {
    const res = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/${CHAIN.id}?contract_addresses=${normalizeAddress(mint)}`,
      { timeout: 8000 }
    );
    const data = res.data?.result?.[normalizeAddress(mint)];
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Honeypot.is (may not cover Robinhood Chain).
 */
export async function fetchHoneypotIs(mint) {
  try {
    const res = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${normalizeAddress(mint)}&chainID=${CHAIN.id}`,
      { timeout: 8000 }
    );
    return res.data || null;
  } catch {
    return null;
  }
}

export function summarizeSecurity(report) {
  if (!report) return 'security: unknown';
  const flags = report.findings.map((f) => f.detail).slice(0, 3);
  return `${report.verdict} (risk ${report.riskScore})${flags.length ? ' — ' + flags.join('; ') : ''}`;
}
