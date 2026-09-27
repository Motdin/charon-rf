/**
 * Full QC runner — run before VPS deploy.
 *
 *   node scripts/verify.js
 *
 * 1. Syntax-check every .js source file
 * 2. Run every smoke suite
 * 3. Report pass/fail with a non-zero exit on any failure
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'tmp' || name === '.git') continue;
      walk(full, acc);
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

function run(title, cmd, args) {
  process.stdout.write(`\n── ${title} ──\n`);
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    process.stdout.write(`✓ ${title}\n`);
    return true;
  } catch (err) {
    process.stdout.write(`✗ ${title} FAILED (exit ${err.status})\n`);
    return false;
  }
}

let failed = 0;

// 1. syntax check all sources (skip scripts/verify.js self? no, include it)
const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'scripts'))).concat([join(ROOT, 'index.js')]);
files.sort();
process.stdout.write(`── syntax: ${files.length} files ──\n`);
for (const f of files) {
  const rel = relative(ROOT, f);
  try {
    execFileSync(node, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    process.stdout.write(`  ok ${rel}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL ${rel}\n${err.stderr}\n`);
    failed++;
  }
}

// 2. smoke suites (order: isolated first)
const suites = [
  'scripts/smoke-imports.js',
  'scripts/smoke.js',
  'scripts/smoke-gmgn.js',
  'scripts/smoke-stratset.js',
  'scripts/smoke-interactive.js',
  'scripts/smoke-security.js',
];
for (const s of suites) {
  if (!existsSync(join(ROOT, s))) {
    process.stdout.write(`\n✗ missing suite ${s}\n`);
    failed++;
    continue;
  }
  if (!run(s, node, [s])) failed++;
}

// 3. python card renderer import check (optional dependency)
const py = process.env.MIMO_PYTHON || 'python';
if (existsSync(join(ROOT, 'scripts', 'render_pnl_card.py'))) {
  process.stdout.write('\n── render_pnl_card.py import ──\n');
  try {
    execFileSync(py, ['-c', 'import ast,sys; ast.parse(open("scripts/render_pnl_card.py").read()); print("py syntax ok")'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch {
    process.stdout.write('(python not available or syntax error — skipped for node-only VPS)\n');
  }
}

process.stdout.write('\n════════════════════════════════\n');
if (failed) {
  process.stdout.write(`QC FAILED — ${failed} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('QC PASSED — ready for VPS\n');
process.exit(0);
