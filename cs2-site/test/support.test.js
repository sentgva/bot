import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { config } from '../lib/config.js';
import { adminBotMessage, adminReply, getTicket, listTickets, userMessage } from '../lib/support.js';

beforeEach(freshDb);

// Подменённый Telegram: запоминает отправленные сообщения и выдаёт им номера
function fakeTelegram() {
  const sent = [];
  let id = 100;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push({ method: url.split('/').pop(), ...body });
    return { json: async () => ({ ok: true, result: { message_id: ++id } }) };
  };
  return { sent, fetchImpl };
}

test('поддержка: сообщение игрока → тикет и рассылка админам, ответ reply\'ем → игроку', async () => {
  config.tgBotToken = '1:test';
  const admin = await makeUser(0);
  const helper = await makeUser(0);
  const db = (await import('../lib/db.js'));
  await (await db.getDb()).query('update users set is_admin = true where id = $1', [helper.id]);
  config.adminTgIds = [String(admin.telegram_id)];
  try {
    const tg = fakeTelegram();
    const t = await userMessage({ id: 555, first_name: 'Вася', username: 'vasya' }, 'Не пришёл вывод', tg.fetchImpl);
    assert.ok(t.id);
    const toAdmins = tg.sent.filter((m) => /Тикет #/.test(m.text));
    assert.deepEqual(toAdmins.map((m) => m.chat_id).sort(), [String(admin.telegram_id), String(helper.telegram_id)].sort());
    assert.ok(tg.sent.some((m) => m.chat_id === '555' && /создано/.test(m.text)), 'игрок получил подтверждение');

    // Второе сообщение — в тот же тикет
    const t2 = await userMessage({ id: 555, first_name: 'Вася' }, 'Номер заявки 12', tg.fetchImpl);
    assert.equal(t2.id, t.id);

    // Админ отвечает reply на пересланное сообщение
    const forwarded = toAdmins.find((m) => m.chat_id === String(helper.telegram_id));
    const idx = tg.sent.indexOf(forwarded);
    const replyTo = 101 + idx; // номер, который «Telegram» выдал этому сообщению
    const r = await adminBotMessage({ chat: { id: helper.telegram_id }, from: { id: helper.telegram_id }, text: 'Проверяем, 10 минут', reply_to_message: { message_id: replyTo } }, tg.fetchImpl);
    assert.equal(r.handled, true);
    assert.ok(tg.sent.some((m) => m.chat_id === '555' && /Проверяем, 10 минут/.test(m.text)), 'ответ доставлен игроку');

    // Ответ из админ-панели и закрытие командой
    await adminReply(t.id, 'Деньги отправлены', { name: 'Админ' }, tg.fetchImpl);
    const { messages } = await getTicket(t.id);
    assert.deepEqual(messages.map((m) => m.sender), ['user', 'user', 'admin', 'admin']);
    await adminBotMessage({ chat: { id: admin.telegram_id }, from: { id: admin.telegram_id }, text: `/close ${t.id}` }, tg.fetchImpl);
    assert.equal((await listTickets('open')).length, 0);
    assert.equal((await listTickets('closed')).length, 1);
    // После закрытия новое сообщение открывает новый тикет
    const t3 = await userMessage({ id: 555, first_name: 'Вася' }, 'Ещё вопрос', tg.fetchImpl);
    assert.notEqual(t3.id, t.id);
  } finally {
    config.adminTgIds = [];
    config.tgBotToken = '';
  }
});

test('поддержка: игрок шлёт кружок и альбом, админ отвечает фото — всё копируется без «переслано от»', async () => {
  config.tgBotToken = '1:test';
  const admin = await makeUser(0);
  config.adminTgIds = [String(admin.telegram_id)];
  try {
    const { mediaOf } = await import('../lib/support.js');
    const tg = fakeTelegram();
    const circle = { chat: { id: 777 }, message_id: 10, video_note: { file_id: 'x' } };
    const t = await userMessage({ id: 777, first_name: 'Петя' }, '', tg.fetchImpl, mediaOf(circle));
    assert.ok(t.isNew);
    const copy = tg.sent.find((m) => m.method === 'copyMessage');
    assert.deepEqual([copy.chat_id, copy.from_chat_id, copy.message_id], [String(admin.telegram_id), 777, 10]);
    assert.ok(tg.sent.some((m) => m.method === 'sendMessage' && m.chat_id === String(admin.telegram_id) && /Кружок/.test(m.text)));
    // Альбом из двух фото: шапка у админа и «Добавили в обращение» — один раз
    tg.sent.length = 0;
    for (const id of [11, 12]) {
      await userMessage({ id: 777, first_name: 'Петя' }, id === 11 ? 'скрин ошибки' : '', tg.fetchImpl, mediaOf({ chat: { id: 777 }, message_id: id, photo: [{}], media_group_id: 'g1' }));
    }
    assert.equal(tg.sent.filter((m) => m.method === 'copyMessage').length, 2);
    assert.equal(tg.sent.filter((m) => m.method === 'sendMessage' && m.chat_id === '777').length, 1);
    assert.equal(tg.sent.filter((m) => m.method === 'sendMessage' && m.chat_id === String(admin.telegram_id)).length, 1);
    const { messages } = await getTicket(t.id);
    assert.match(messages[0].text, /Кружок/);
    assert.match(messages[1].text, /Фото[\s\S]*скрин ошибки/);
    // Админ отвечает фото reply'ем на копию медиа
    const replyTo = tg.sent.filter((m) => m.method === 'copyMessage').length && (await (await (await import('../lib/db.js')).getDb()).one('select max(message_id)::int as id from ticket_admin_messages')).id;
    tg.sent.length = 0;
    const r = await adminBotMessage({ chat: { id: admin.telegram_id }, from: { id: admin.telegram_id }, message_id: 50, photo: [{}], caption: 'Вот так', reply_to_message: { message_id: replyTo } }, tg.fetchImpl);
    assert.equal(r.handled, true);
    const toUser = tg.sent.filter((m) => m.chat_id === t.telegram_id);
    assert.match(toUser[0].text, /Поддержка LuxeDrop:\n\nВот так/);
    assert.equal(toUser[1].method, 'copyMessage');
    assert.equal(toUser[1].caption, '');
  } finally { config.adminTgIds = []; }
});

test('полный бан: обращения в поддержку не принимаются, обычный бан — принимаются', async () => {
  const { updateUser } = await import('../lib/admin.js');
  const { supportBan } = await import('../lib/support.js');
  config.tgBotToken = '1:test';
  const admin = await makeUser(0);
  config.adminTgIds = [String(admin.telegram_id)];
  try {
    const soft = await makeUser(0);
    const hard = await makeUser(0);
    await updateUser(soft.id, { action: 'ban', days: 7, note: 'Спам' });
    await updateUser(hard.id, { action: 'ban', days: null, note: 'Мошенничество', full: true });
    assert.equal(await supportBan(soft.telegram_id), null);
    assert.equal((await supportBan(hard.telegram_id)).full, true);

    const tg = fakeTelegram();
    const t = await userMessage({ id: Number(soft.telegram_id), first_name: 'Мягкий' }, 'Разбаньте', tg.fetchImpl);
    assert.ok(t.id, 'обычный бан — тикет создаётся');
    tg.sent.length = 0;
    const r = await userMessage({ id: Number(hard.telegram_id), first_name: 'Жёсткий' }, 'Разбаньте', tg.fetchImpl);
    assert.equal(r.blocked, true);
    assert.equal(tg.sent.length, 1, 'только ответ игроку');
    assert.match(tg.sent[0].text, /полностью заблокирован/);
    assert.equal((await listTickets('open')).filter((x) => x.telegram_id === String(hard.telegram_id)).length, 0);
    // Разбан снимает и полный бан
    await updateUser(hard.id, { action: 'unban' });
    assert.equal(await supportBan(hard.telegram_id), null);
  } finally { config.adminTgIds = []; }
});
