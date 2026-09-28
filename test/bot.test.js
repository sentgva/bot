import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMIN = 1;
const CLIENT = 100;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovside-bot-'));
Object.assign(process.env, { BOT_TOKEN: '123456:TEST_TOKEN', ADMIN_ID: String(ADMIN), DATA_DIR: dir, WEBAPP_URL: 'https://example.com' });

const { openDb } = await import('../src/db.js');
const { createBot } = await import('../src/bot.js');
const { buildOrder } = await import('../src/orders.js');

const db = openDb(dir);
const { bot, chat } = createBot(db);
bot.botInfo = { id: 42, is_bot: true, first_name: 'sovside', username: 'sovside_bot' };

// Перехватываем все вызовы Bot API, в сеть ничего не уходит
const calls = [];
let messageId = 1000;
bot.api.config.use(async (prev, method, payload) => {
  calls.push({ method, payload });
  const result = method.startsWith('send')
    ? { message_id: ++messageId, date: 0, chat: { id: payload.chat_id, type: 'private' }, photo: [{ file_id: 'cover' }] }
    : true;
  return { ok: true, result };
});

after(() => {
  db.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

let updateId = 0;
const from = (id) => ({ id, is_bot: false, first_name: id === ADMIN ? 'Owner' : 'Client' });
const message = (userId, extra) =>
  bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++messageId, date: 0, chat: { id: userId, type: 'private' }, from: from(userId), ...extra },
  });
const tick = () => new Promise((r) => setTimeout(r, 20));
const sentTo = (id) => calls.filter((c) => c.method.startsWith('send') && c.payload.chat_id === id);

test('/start отвечает обложкой и кнопкой приложения', async () => {
  calls.length = 0;
  await message(CLIENT, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const photo = sentTo(CLIENT)[0];
  assert.equal(photo.method, 'sendPhoto');
  assert.equal(photo.payload.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.com/');
});

test('клиент пишет боту → админ получает, ответ реплаем уходит клиенту', async () => {
  calls.length = 0;
  await message(CLIENT, { text: 'нужен ганпак' });
  await tick();
  const note = sentTo(ADMIN)[0];
  assert.ok(note && note.payload.text.includes('нужен ганпак'));
  const relayId = messageId; // id уведомления у админа

  calls.length = 0;
  await message(ADMIN, { text: 'сделаю', reply_to_message: { message_id: relayId, date: 0, chat: { id: ADMIN, type: 'private' } } });
  await tick();
  assert.ok(sentTo(CLIENT).some((c) => c.payload.text.includes('сделаю')));
  const texts = db.messages(CLIENT).map((m) => `${m.from}:${m.text}`);
  assert.deepEqual(texts.slice(-2), ['client:нужен ганпак', 'admin:сделаю']);
});

test('сообщение админа без реплая никуда не уходит', async () => {
  calls.length = 0;
  const before = db.messages(CLIENT).length;
  await message(ADMIN, { text: 'кому это?' });
  assert.equal(sentTo(CLIENT).length, 0);
  assert.equal(db.messages(CLIENT).length, before);
  assert.match(sentTo(ADMIN)[0].payload.text, /реплаем/);
});

test('кнопки статуса заказа работают только у админа', async () => {
  const order = chat.placeOrder(db.getUser(CLIENT), buildOrder([{ id: 'ot-logo' }], ''));
  const press = (userId) =>
    bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        from: from(userId),
        chat_instance: 'x',
        data: `st:${order.id}:done`,
        message: { message_id: 1, date: 0, chat: { id: userId, type: 'private' } },
      },
    });

  calls.length = 0;
  await press(CLIENT);
  assert.equal(db.getOrder(order.id).status, 'new');
  assert.equal(calls.find((c) => c.method === 'answerCallbackQuery').payload.text, 'Нет доступа');

  calls.length = 0;
  await press(ADMIN);
  assert.equal(db.getOrder(order.id).status, 'done');
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
  assert.ok(sentTo(CLIENT).some((c) => c.payload.text.includes('готов')));
});
