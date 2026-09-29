import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMIN = 1;
const CLIENT = 100;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovside-bot-'));
Object.assign(process.env, { BOT_TOKEN: '123456:TEST_TOKEN', ADMIN_ID: String(ADMIN), DATA_DIR: dir, WEBAPP_URL: 'https://example.com' });

const { Bot } = await import('grammy');
const { config } = await import('../src/config.js');
const { openStore } = await import('../src/store.js');
const { openDb } = await import('../src/db.js');
const { openMedia } = await import('../src/media.js');
const { createChat } = await import('../src/chat.js');
const { registerBot } = await import('../src/bot.js');
const { buildOrder } = await import('../src/orders.js');

const db = openDb(openStore());
const bot = new Bot(process.env.BOT_TOKEN, { botInfo: { id: 42, is_bot: true, first_name: 'sovside', username: 'sovside_bot' } });
const chat = createChat(db, bot.api, openMedia({ dataDir: dir }));
registerBot(bot, db, chat);

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
  const texts = (await db.messages(CLIENT)).map((m) => `${m.from}:${m.text}`);
  assert.deepEqual(texts.slice(-2), ['client:нужен ганпак', 'admin:сделаю']);
});

test('сообщение админа без реплая никуда не уходит', async () => {
  calls.length = 0;
  const before = (await db.messages(CLIENT)).length;
  await message(ADMIN, { text: 'кому это?' });
  assert.equal(sentTo(CLIENT).length, 0);
  assert.equal((await db.messages(CLIENT)).length, before);
  assert.match(sentTo(ADMIN)[0].payload.text, /реплаем/);
});

test('кнопки статуса заказа работают только у админа', async () => {
  const order = await chat.placeOrder(await db.getUser(CLIENT), buildOrder([{ id: 'ot-logo' }], ''));
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
  assert.equal((await db.getOrder(order.id)).status, 'new');
  assert.equal(calls.find((c) => c.method === 'answerCallbackQuery').payload.text, 'Нет доступа');

  calls.length = 0;
  await press(ADMIN);
  assert.equal((await db.getOrder(order.id)).status, 'done');
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
  assert.ok(sentTo(CLIENT).some((c) => c.payload.text.includes('готов')));
});

test('секретная ссылка назначает админа только один раз', async () => {
  const saved = config.adminIds;
  config.adminIds = []; // бот без ADMIN_ID
  try {
    const db2 = openDb(openStore());
    const bot2 = new Bot(process.env.BOT_TOKEN, { botInfo: bot.botInfo });
    bot2.api.config.use(async () => ({ ok: true, result: true }));
    registerBot(bot2, db2, createChat(db2, bot2.api, openMedia({ dataDir: dir })));
    const start = (userId, payload) =>
      bot2.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: ++messageId, date: 0, chat: { id: userId, type: 'private' }, from: from(userId),
          text: `/start ${payload}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });
    await start(777, 'admin-wrong');
    assert.equal(await db2.isAdmin(777), false);
    await start(777, config.adminClaim);
    assert.equal(await db2.isAdmin(777), true);
    await start(888, config.adminClaim);
    assert.equal(await db2.isAdmin(888), false);
  } finally {
    config.adminIds = saved;
  }
});

test('/news: рассылка всем клиентам, один раз', async () => {
  const press = (userId, data) =>
    bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId), from: from(userId), chat_instance: 'x', data,
        message: { message_id: 9000, date: 0, chat: { id: userId, type: 'private' } },
      },
    });
  const cmd = (userId, text) =>
    message(userId, { text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] });
  const waitFor = async (check) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(check(), 'не дождались');
  };

  // клиенту команда недоступна
  calls.length = 0;
  await cmd(CLIENT, '/news привет всем');
  assert.match(sentTo(CLIENT)[0].payload.text, /Такой команды нет/);
  assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 0);

  // админ: /news → сообщение → подтверждение; второй админ тоже получает рассылку
  await message(101, { text: 'я второй клиент' });
  await message(202, { text: 'я второй админ' });
  await db.addAdmin(202);
  calls.length = 0;
  await cmd(ADMIN, '/news');
  assert.match(sentTo(ADMIN)[0].payload.text, /Пришли одним сообщением/);
  calls.length = 0;
  await message(ADMIN, { text: 'Скидка 20% до пятницы' });
  const confirm = sentTo(ADMIN)[0];
  assert.match(confirm.payload.text, /Отправить это сообщение 3 людям/);
  const go = confirm.payload.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(go, /^news:\d+:go$/);

  // обычные сообщения админа снова идут как раньше, а не в рассылку
  calls.length = 0;
  await message(ADMIN, { text: 'просто текст' });
  assert.match(sentTo(ADMIN)[0].payload.text, /реплаем/);

  calls.length = 0;
  await press(ADMIN, go);
  const copies = () => calls.filter((c) => c.method === 'copyMessage');
  await waitFor(() => calls.some((c) => c.method === 'editMessageText' && /Рассылка отправлена: 3 из 3/.test(c.payload.text)));
  assert.deepEqual(copies().map((c) => c.payload.chat_id).sort((a, b) => a - b), [CLIENT, 101, 202]);
  assert.ok(copies().every((c) => c.payload.from_chat_id === ADMIN));

  // повторное нажатие (или повтор апдейта от Telegram) ничего не шлёт
  calls.length = 0;
  await press(ADMIN, go);
  await tick();
  assert.equal(copies().length, 0);
  assert.match(calls.find((c) => c.method === 'answerCallbackQuery').payload.text, /уже отправлена/);
});

test('/news текст: сразу черновик с форматированием, /cancel и отмена', async () => {
  calls.length = 0;
  await message(ADMIN, {
    text: '/news Новый прайс',
    entities: [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'bold', offset: 6, length: 5 }],
  });
  const [preview, confirm] = sentTo(ADMIN);
  assert.equal(preview.payload.text, 'Новый прайс');
  assert.deepEqual(preview.payload.entities, [{ type: 'bold', offset: 0, length: 5 }]);
  assert.match(confirm.payload.text, /Отправить/);

  const no = confirm.payload.reply_markup.inline_keyboard[0][1].callback_data;
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: 'c', from: from(ADMIN), chat_instance: 'x', data: no, message: { message_id: 1, date: 0, chat: { id: ADMIN, type: 'private' } } },
  });
  assert.ok(calls.some((c) => c.method === 'editMessageText' && c.payload.text === 'Рассылка отменена.'));
  assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 0);

  await message(ADMIN, { text: '/news', entities: [{ type: 'bot_command', offset: 0, length: 5 }] });
  await message(ADMIN, { text: '/cancel', entities: [{ type: 'bot_command', offset: 0, length: 7 }] });
  calls.length = 0;
  await message(ADMIN, { text: 'после отмены' });
  assert.match(sentTo(ADMIN)[0].payload.text, /реплаем/);
});

test('/mode: админ пишет боту как клиент, потом возвращается', async () => {
  const cmd = (userId, text) => message(userId, { text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] });

  calls.length = 0;
  await cmd(CLIENT, '/mode');
  assert.match(sentTo(CLIENT)[0].payload.text, /Такой команды нет/);

  calls.length = 0;
  await cmd(ADMIN, '/mode');
  assert.match(sentTo(ADMIN)[0].payload.text, /Режим клиента/);
  assert.equal(await db.actsAsAdmin(ADMIN), false);
  assert.equal(await db.isAdmin(ADMIN), true);

  // сообщение уходит в его собственный чат как от клиента, а не «ответь реплаем»
  calls.length = 0;
  await message(ADMIN, { text: 'хочу заказ' });
  assert.equal(sentTo(ADMIN).length, 0);
  assert.equal((await db.messages(ADMIN)).at(-1).text, 'хочу заказ');
  assert.equal((await db.messages(ADMIN)).at(-1).from, 'client');

  // /start показывает клиентский экран, /news недоступна
  calls.length = 0;
  await cmd(ADMIN, '/start');
  assert.doesNotMatch(sentTo(ADMIN)[0].payload.caption, /режим админа/);
  calls.length = 0;
  await cmd(ADMIN, '/news');
  assert.match(sentTo(ADMIN)[0].payload.text, /Такой команды нет/);

  await cmd(ADMIN, '/mode');
  assert.equal(await db.actsAsAdmin(ADMIN), true);
  calls.length = 0;
  await cmd(ADMIN, '/start');
  assert.match(sentTo(ADMIN)[0].payload.caption, /режим админа/);
});

test('/clear очищает переписку у того, кто вызвал', async () => {
  const cmd = (userId) => message(userId, { text: '/clear', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  calls.length = 0;
  await cmd(CLIENT);
  assert.match(sentTo(CLIENT)[0].payload.text, /очищена/);
  assert.ok((await db.clearedAt(CLIENT)) > 0);
  calls.length = 0;
  await cmd(555);
  assert.match(sentTo(555)[0].payload.text, /и так пустая/);
});
