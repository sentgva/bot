import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { handler } from '../lib/app.js';
import { config } from '../lib/config.js';
import { encodeSession, decodeSession } from '../lib/session.js';
import { upsertTelegramUser } from '../lib/users.js';
import { signLoginWidget, verifyLoginWidget } from '../lib/telegram.js';

const TOKEN = '987654:WIDGET-token';
let server;
let base;
before(async () => {
  await freshDb();
  server = http.createServer(handler).listen(0);
  base = `http://localhost:${server.address().port}`;
  config.siteUrl = base;
});
after(() => { server.close(); config.tgBotToken = ''; });

const call = (path, { method = 'GET', body, cookie, origin } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...(origin !== null && method !== 'GET' && { Origin: origin || base }) },
    body: body && JSON.stringify(body),
    redirect: 'manual',
  });

test('сессия: подпись и срок', () => {
  const t = encodeSession({ uid: 5, exp: Date.now() + 1000 });
  assert.equal(decodeSession(t).uid, 5);
  assert.equal(decodeSession(t.slice(0, -2) + 'xx'), null, 'подделанная подпись');
  assert.equal(decodeSession(encodeSession({ uid: 5, exp: Date.now() - 1 })), null, 'истёкшая');
});

test('гость видит конфиг, но не может покупать', async () => {
  const me = await (await call('/api/me')).json();
  assert.equal(me.user, null);
  assert.ok(me.config.upgrade.maxChance > 0);
  const res = await call('/api/cases/starter/open', { method: 'POST', body: { count: 1 } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Telegram/);
});

test('CSRF: запрос с чужого сайта отклоняется', async () => {
  const u = await upsertTelegramUser({ id: 31337, first_name: 'csrf' });
  const cookie = `ld_sess=${encodeSession({ uid: u.id, exp: Date.now() + 60_000 })}`;
  const res = await call('/api/me/seed/rotate', { method: 'POST', cookie, origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const ok = await call('/api/me/seed/rotate', { method: 'POST', cookie });
  assert.equal(ok.status, 200);
});

test('каталог фильтруется и сортируется', async () => {
  const data = await (await call('/api/items?rarity=covert&sort=price_asc&limit=5')).json();
  assert.ok(data.items.length > 0);
  assert.ok(data.items.every((i) => i.rarity === 'covert'));
  const prices = data.items.map((i) => i.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(data.items.every((i) => i.buyPrice >= i.price));
});

test('Telegram Login на сайте: подпись проверяется, вход ставит cookie сессии', async () => {
  config.tgBotToken = TOKEN;
  const user = { id: 424242, first_name: 'Артём', username: 'art3m', photo_url: 'https://t.me/i/userpic/320/a.jpg' };
  const data = signLoginWidget(user, TOKEN);
  assert.equal(verifyLoginWidget(data).id, 424242);
  assert.equal(verifyLoginWidget({ ...data, id: 1 }), null, 'подменённый id');
  assert.equal(verifyLoginWidget(signLoginWidget(user, 'other:bot')), null, 'подпись другого бота');
  assert.equal(verifyLoginWidget(signLoginWidget(user, TOKEN, Math.floor(Date.now() / 1000) - 3 * 86400)), null, 'устаревшие данные');

  const bad = await call('/api/auth/telegram-widget', { method: 'POST', body: { data: { ...data, hash: '0'.repeat(64) } } });
  assert.equal(bad.status, 401);
  const res = await call('/api/auth/telegram-widget', { method: 'POST', body: { data } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await (await call('/api/me', { cookie })).json();
  assert.equal(me.user.name, 'Артём');
  assert.deepEqual(me.user.telegram, { id: '424242', username: 'art3m' });
  assert.equal(me.config.auth.telegramBotId, '987654');
});

test('трейд-ссылка проверяется по формату', async () => {
  const u = await upsertTelegramUser({ id: 777, first_name: 't' });
  const cookie = `ld_sess=${encodeSession({ uid: u.id, exp: Date.now() + 60_000 })}`;
  const bad = await call('/api/me', { method: 'PATCH', cookie, body: { tradeUrl: 'https://example.com/trade' } });
  assert.equal(bad.status, 400);
  const good = await call('/api/me', { method: 'PATCH', cookie, body: { tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCd_123' } });
  assert.equal(good.status, 200);
});

test('входа через Steam больше нет', async () => {
  assert.equal((await call('/api/auth/steam')).status, 404);
  assert.equal((await call('/api/steam-inventory')).status, 404);
});

test('неизвестный маршрут — 404 в JSON', async () => {
  const res = await call('/api/nope');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
