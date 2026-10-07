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
