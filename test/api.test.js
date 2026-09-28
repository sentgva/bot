import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = '123456:TEST_TOKEN';
const ADMIN = 1;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovside-'));
Object.assign(process.env, { BOT_TOKEN: TOKEN, ADMIN_ID: String(ADMIN), DATA_DIR: dir, WEBAPP_URL: 'https://example.com' });

const { openDb } = await import('../src/db.js');
const { createChat } = await import('../src/chat.js');
const { createServer } = await import('../src/server.js');
const { signInitData, verifyInitData } = await import('../src/auth.js');
const { buildOrder } = await import('../src/orders.js');

const sent = [];
let messageId = 0;
const fakeApi = {
  sendMessage: async (chatId, text, extra) => (sent.push({ chatId, text, extra }), { message_id: ++messageId }),
  sendPhoto: async (chatId, photo, extra) => (sent.push({ chatId, photo, extra }), { message_id: ++messageId }),
  getFile: async () => ({ file_path: 'photos/x.jpg' }),
};

const db = openDb(dir);
const chat = createChat(db, fakeApi);
let server;
let base;

const initFor = (user, authDate = Math.floor(Date.now() / 1000)) =>
  signInitData({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify(user) }, TOKEN);

const alice = { id: 100, first_name: 'Alice', username: 'alice' };
const bob = { id: 200, first_name: 'Bob' };
const admin = { id: ADMIN, first_name: 'Owner' };

async function call(user, route, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api/${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user && { 'X-Init-Data': initFor(user) }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

before(async () => {
  server = createServer(db, chat).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('initData: подпись, подделка и срок', () => {
  const good = initFor(alice);
  assert.equal(verifyInitData(good, TOKEN).user.id, alice.id);
  assert.equal(verifyInitData(good, '999:OTHER'), null);
  assert.equal(verifyInitData(good.replace('Alice', 'Mallory'), TOKEN), null);
  assert.equal(verifyInitData(initFor(alice, 1000), TOKEN), null);
  assert.equal(verifyInitData('', TOKEN), null);
});

test('заказ: цены только из каталога', () => {
  const order = buildOrder([{ id: 'gp-recolor', qty: 3, price: 1 }, { id: 'gp-scratch' }], '  ак-47  ');
  assert.equal(order.total.sum, 300);
  assert.equal(order.total.negotiable, true);
  assert.equal(order.comment, 'ак-47');
  assert.throws(() => buildOrder([{ id: 'nope' }]));
  assert.throws(() => buildOrder([]));
  assert.throws(() => buildOrder([{ id: 'gp-recolor', qty: 0 }]));
  assert.throws(() => buildOrder([{ id: 'ot-logo' }, { id: 'ot-logo' }]));
});

test('публичная информация доступна без Telegram', async () => {
  const { status, data } = await call(null, 'info');
  assert.equal(status, 200);
  assert.ok(data.catalog.length > 0);
  assert.ok(data.links.discord.startsWith('https://discord.gg/'));
});

test('без подписи Telegram приватное API закрыто', async () => {
  assert.equal((await call(null, 'me')).status, 401);
  assert.equal((await call(null, 'chat')).status, 401);
});

test('сообщение клиента уходит админу, ответ реплаем находит клиента', async () => {
  sent.length = 0;
  const { status, data } = await call(alice, 'chat', { method: 'POST', body: { text: 'Привет <b>' } });
  assert.equal(status, 200);
  assert.equal(data.message.from, 'client');
  await tick();
  const note = sent.find((s) => s.chatId === ADMIN);
  assert.ok(note, 'админ получил уведомление');
  assert.match(note.text, /Привет &lt;b&gt;/);
  assert.equal(db.getRelay(ADMIN, messageId), alice.id);
});

test('клиент видит только свой чат', async () => {
  await call(bob, 'chat', { method: 'POST', body: { text: 'я Боб' } });
  const asBob = await call(bob, `chat?user=${alice.id}`);
  assert.ok(asBob.data.messages.every((m) => m.text !== 'Привет <b>'));
  assert.ok(asBob.data.messages.some((m) => m.text === 'я Боб'));
  // и не может написать в чужой
  await call(bob, 'chat', { method: 'POST', body: { text: 'взлом', user: alice.id } });
  const asAlice = await call(alice, 'chat');
  assert.ok(asAlice.data.messages.every((m) => m.text !== 'взлом'));
});

test('админские методы закрыты для клиента', async () => {
  assert.equal((await call(alice, 'admin/threads')).status, 403);
  assert.equal((await call(alice, 'admin/orders/1', { method: 'POST', body: { status: 'done' } })).status, 403);
});

test('админ видит все чаты и отвечает клиенту', async () => {
  const { data } = await call(admin, 'admin/threads');
  const ids = data.threads.map((t) => t.user.id);
  assert.ok(ids.includes(alice.id) && ids.includes(bob.id));
  assert.ok(data.threads.find((t) => t.user.id === alice.id).unread >= 1);

  // Алиса только что открывала чат в приложении: ответ увидит там, в бот не дублируем
  sent.length = 0;
  const reply = await call(admin, 'chat', { method: 'POST', body: { text: 'Здарова', user: alice.id } });
  assert.equal(reply.data.message.from, 'admin');
  await tick();
  assert.ok(!sent.some((s) => s.chatId === alice.id));
  assert.equal((await call(alice, 'me')).data.unread, 1);

  // Кэрол приложение не открывала: ответ придёт ей в бота
  const carol = { id: 300, first_name: 'Carol' };
  await call(carol, 'chat', { method: 'POST', body: { text: 'есть кто?' } });
  sent.length = 0;
  await call(admin, 'chat', { method: 'POST', body: { text: 'да', user: carol.id } });
  await tick();
  assert.ok(sent.some((s) => s.chatId === carol.id), 'клиент получил ответ в боте');
  assert.equal((await call(admin, 'chat?user=999999')).status, 404);
});

test('заказ, смена статуса и уведомления', async () => {
  sent.length = 0;
  const { status, data } = await call(alice, 'orders', {
    method: 'POST',
    body: { items: [{ id: 'gp-visual', qty: 2 }, { id: 'cl-replace' }], comment: 'срочно' },
  });
  assert.equal(status, 200);
  assert.equal(data.order.total, 'от 500 ₽');
  await tick();
  assert.ok(sent.some((s) => s.chatId === ADMIN && s.text.includes(`Заказ #${data.order.id}`)));

  const changed = await call(admin, `admin/orders/${data.order.id}`, { method: 'POST', body: { status: 'work' } });
  assert.equal(changed.data.order.status, 'work');
  const msgs = (await call(alice, 'chat')).data.messages;
  assert.ok(msgs.some((m) => m.kind === 'order' && m.orderId === data.order.id));
  assert.ok(msgs.some((m) => m.kind === 'status' && m.orderId === data.order.id));

  assert.equal((await call(admin, `admin/orders/${data.order.id}`, { method: 'POST', body: { status: 'lol' } })).status, 400);
  assert.equal((await call(alice, 'orders', { method: 'POST', body: { items: [{ id: 'x' }] } })).status, 400);
});

test('картинки: принимаем только настоящие изображения', async () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex',
  );
  const ok = await call(alice, 'chat', { method: 'POST', body: { image: `data:image/png;base64,${png.toString('base64')}` } });
  assert.equal(ok.status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'uploads', ok.data.message.image)));

  const fake = await call(alice, 'chat', { method: 'POST', body: { image: `data:image/png;base64,${Buffer.from('<script>').toString('base64')}` } });
  assert.equal(fake.status, 400);
  const svgImg = await call(alice, 'chat', { method: 'POST', body: { image: 'data:image/svg+xml;base64,PHN2Zz4=' } });
  assert.equal(svgImg.status, 400);
});
