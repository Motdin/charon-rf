/**
 * Smoke-test DB guard.
 * Import this FIRST in every smoke script so test rows never land in production.
 *
 * Override: SM_USE_PROD_DB=1 node scripts/smoke.js
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.SM_USE_PROD_DB !== '1') {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  process.env.DB_PATH = process.env.DB_PATH || join(root, 'tmp', 'smoke.sqlite');
}
