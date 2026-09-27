/**
 * Telegram diagnostics — find the correct TELEGRAM_CHAT_ID.
 *
 *   node scripts/tg-diag.js
 *
 * Reads TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_CHAT_ID) from .env,
 * then:
 *   1. getMe          → verify token
 *   2. getUpdates     → list every chat that has messaged the bot
 *   3. sendMessage    → test the configured TELEGRAM_CHAT_ID
 */
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function tg(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

if (!TOKEN) fail('TELEGRAM_BOT_TOKEN kosong di .env');

console.log('── 1. getMe (cek token) ──');
const me = await tg('getMe');
if (!me.ok) fail(`Token tidak valid: ${JSON.stringify(me)}`);
console.log(`  ✓ bot: @${me.result.username} (${me.result.first_name}) id=${me.result.id}`);

console.log('\n── 2. getUpdates (siapa yang sudah chat bot) ──');
// getUpdates can fail if a webhook is set — clear it first
const hook = await tg('deleteWebhook');
console.log(`  webhook cleared: ${hook.ok}`);

const updates = await tg('getUpdates', { limit: 20, timeout: 0 });
if (!updates.ok) fail(`getUpdates gagal: ${JSON.stringify(updates)}`);

const chats = new Map();
for (const u of updates.result || []) {
  const m = u.message || u.edited_message || u.channel_post;
  if (!m?.chat) continue;
  const c = m.chat;
  const key = String(c.id);
  if (!chats.has(key)) {
    chats.set(key, {
      id: c.id,
      type: c.type,
      title: c.title || c.username || c.first_name || '',
      username: c.username || '',
      lastText: String(m.text || '').slice(0, 40),
    });
  }
}

if (!chats.size) {
  console.log('  (belum ada update)');
  console.log('\n  👉 SEKARANG:');
  console.log(`     1. Buka Telegram, cari bot @${me.result.username}`);
  console.log('     2. Tekan /start atau kirim pesan apa saja');
  console.log('     3. Jalankan ulang: node scripts/tg-diag.js');
  process.exit(0);
}

console.log(`  ditemukan ${chats.size} chat:\n`);
for (const c of chats.values()) {
  console.log(`  chat.id  : ${c.id}`);
  console.log(`  type     : ${c.type}${c.title ? ' · ' + c.title : ''}${c.username ? ' @' + c.username : ''}`);
  console.log(`  last msg : ${c.lastText || '-'}`);
  console.log('');
}

console.log('── 3. test TELEGRAM_CHAT_ID yang sekarang di .env ──');
if (!CHAT_ID) {
  console.log('  TELEGRAM_CHAT_ID masih kosong.');
} else {
  console.log(`  configured: ${CHAT_ID}`);
  const test = await tg('sendMessage', {
    chat_id: CHAT_ID,
    text: '✅ Charon-RH: tes koneksi Telegram berhasil.',
  });
  if (test.ok) {
    console.log('  ✓ sendMessage OK — chat ID benar!');
  } else {
    console.log(`  ✗ sendMessage GAGAL: ${test.description || JSON.stringify(test)}`);
    console.log('');
    console.log('  Perbaiki .env, contoh:');
    const first = [...chats.values()][0];
    console.log(`    TELEGRAM_CHAT_ID=${first.id}`);
  }
}

console.log('\n── checklist .env ──');
console.log(`  TELEGRAM_BOT_TOKEN=${TOKEN.slice(0, 10)}… (${TOKEN.length} chars)`);
console.log(`  TELEGRAM_CHAT_ID=${CHAT_ID || '(kosong)'}`);
console.log('\nSetelah ganti .env:');
console.log('  pm2 restart charon-rh   # dotenv dibaca saat start saja');
