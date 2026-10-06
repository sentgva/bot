import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { handler } from '../lib/app.js';
import { config } from '../lib/config.js';
import { encodeSession, decodeSession } from '../lib/session.js';
import { upsertSteamUser } from '../lib/users.js';
import { verifyLogin } from '../lib/steam.js';

let server;
let base;
before(async () => {
  await freshDb();
  server = http.createServer(handler).listen(0);
  base = `http://localhost:${server.address().port}`;
  config.siteUrl = base;
});
after(() => server.close());

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
  const res = await call('/api/market/buy', { method: 'POST', body: { hashName: 'x', price: 1 } });
  assert.equal(res.status, 401);
});

test('CSRF: запрос с чужого сайта отклоняется', async () => {
  const u = await upsertSteamUser({ steamId: '76561198000009999', name: 'csrf', avatar: null });
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

test('трейд-ссылка другого аккаунта не принимается', async () => {
  const u = await upsertSteamUser({ steamId: '76561197960265728', name: 't', avatar: null }); // accountid 0
  const cookie = `ld_sess=${encodeSession({ uid: u.id, exp: Date.now() + 60_000 })}`;
  const bad = await call('/api/me', { method: 'PATCH', cookie, body: { tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCd_123' } });
  assert.equal(bad.status, 400);
  const good = await call('/api/me', { method: 'PATCH', cookie, body: { tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=0&token=AbCd_123' } });
  assert.equal(good.status, 200);
});

test('форма продажи: honeypot тихо отбрасывает ботов', async () => {
  const res = await call('/api/sell-requests', { method: 'POST', body: { website: 'spam', tradeUrl: 'x', method: 'card' } });
  assert.equal((await res.json()).id, 0);
});

test('после входа редирект только внутрь сайта', async () => {
  const res = await call('/api/auth/steam?next=//evil.example');
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('https://steamcommunity.com/openid/login'));
  assert.match(res.headers.get('set-cookie'), /ld_next=%2Fprofile%2F/);
});

test('OpenID: проверка ответа Steam', async () => {
  const ret = 'https://luxedrop.gg/api/auth/steam/callback';
  const q = new URLSearchParams({
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.return_to': ret,
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000042',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000042',
    'openid.sig': 'x',
  });
  let sent;
  const steamOk = async (url, init) => { sent = init.body; return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'); };
  assert.equal(await verifyLogin(q, ret, steamOk), '76561198000000042');
  assert.equal(sent.get('openid.mode'), 'check_authentication');
  const steamNo = async () => new Response('is_valid:false');
  assert.equal(await verifyLogin(q, ret, steamNo), null);
  assert.equal(await verifyLogin(q, 'https://other.site/cb', steamOk), null, 'чужой return_to');
});

test('неизвестный маршрут — 404 в JSON', async () => {
  const res = await call('/api/nope');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
