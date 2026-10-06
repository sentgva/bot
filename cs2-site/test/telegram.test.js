import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { config } from '../lib/config.js';
import { handler } from '../lib/app.js';
import { handleUpdate, signInitData, verifyInitData, webhookSecret } from '../lib/telegram.js';

const TOKEN = '123456:TEST-token';
const TG_USER = { id: 777000111, first_name: 'Артём', username: 'art3m', photo_url: 'https://t.me/i/userpic/320/x.svg' };

let server;
let base;
before(async () => {
  await freshDb();
  config.tgBotToken = TOKEN;
  server = http.createServer(handler).listen(0);
  base = `http://localhost:${server.address().port}`;
  config.siteUrl = base;
});
after(() => { server.close(); config.tgBotToken = ''; });

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
});

test('initData: подпись Telegram проверяется', () => {
  const data = signInitData(TG_USER, TOKEN);
  assert.equal(verifyInitData(data, TOKEN).id, TG_USER.id);
  assert.equal(verifyInitData(data, '999:other-bot'), null, 'подпись другого бота');
  const tampered = new URLSearchParams(data);
  tampered.set('user', JSON.stringify({ ...TG_USER, id: 1 }));
  assert.equal(verifyInitData(tampered.toString(), TOKEN), null, 'подменённый пользователь');
  const old = signInitData(TG_USER, TOKEN, Math.floor(Date.now() / 1000) - 2 * 24 * 3600);
  assert.equal(verifyInitData(old, TOKEN), null, 'устаревшие данные');
  assert.equal(verifyInitData('', TOKEN), null);
});

test('вход из Mini App: создаёт игрока, токен работает в заголовке Authorization', async () => {
  const bad = await post('/api/auth/telegram', { initData: 'user=1&hash=00' });
  assert.equal(bad.status, 401);

  const res = await post('/api/auth/telegram', { initData: signInitData(TG_USER, TOKEN) });
  assert.equal(res.status, 200);
  const { token, user } = await res.json();
  assert.ok(token);
  assert.equal(user.name, 'Артём');
  assert.deepEqual(user.telegram, { id: String(TG_USER.id), username: 'art3m' });

  const me = await (await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(me.user.id, user.id);

  // Повторный вход — тот же аккаунт
  const again = await (await post('/api/auth/telegram', { initData: signInitData({ ...TG_USER, first_name: 'Тёма' }, TOKEN) })).json();
  assert.equal(again.user.id, user.id);
  assert.equal(again.user.name, 'Тёма');

  // Трейд-ссылка проверяется по формату (Steam к аккаунту не привязан)
  const auth = { Authorization: `Bearer ${again.token}` };
  const patch = await fetch(base + '/api/me', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: base, ...auth },
    body: JSON.stringify({ tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCd_123' }),
  });
  assert.equal(patch.status, 200);
});

test('админ по Telegram ID', async () => {
  config.adminTgIds = [String(TG_USER.id)];
  try {
    const { token } = await (await post('/api/auth/telegram', { initData: signInitData(TG_USER, TOKEN) })).json();
    const res = await fetch(base + '/api/admin/overview', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
  } finally {
    config.adminTgIds = [];
  }
});

test('вебхук бота: без секрета — отказ; /start — кнопка Mini App', async () => {
  const res = await post('/api/telegram/webhook', { message: {} }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(webhookSecret().length, 48);

  let sent;
  const fakeFetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ ok: true, result: {} })); };
  await handleUpdate({ message: { chat: { id: 5, type: 'private' }, from: { first_name: 'Артём' }, text: '/start' } }, fakeFetch);
  assert.match(sent.url, /\/sendMessage$/);
  assert.equal(sent.body.chat_id, 5);
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].web_app.url, `${base}/upgrade/`);
  const group = await handleUpdate({ message: { chat: { id: -1, type: 'group' }, text: '/start' } }, fakeFetch);
  assert.equal(group.skipped, true, 'в группах бот молчит');
});
