import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { config } from '../lib/config.js';
import { countRecipients, handleBroadcastCallback, isOwnerTelegram, ownerBotMessage, rememberBotUser, runBroadcast } from '../lib/broadcast.js';
import { getDb } from '../lib/db.js';

beforeEach(freshDb);

function fakeTelegram({ blocked = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const method = url.split('/').pop();
    calls.push({ method, ...body });
    if (method === 'copyMessage' && blocked.includes(String(body.chat_id))) return { json: async () => ({ ok: false, error_code: 403, description: 'blocked' }) };
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return { calls, fetchImpl };
}

test('новость: /news → сообщение → «Отправить всем» → рассылка всем, кроме заблокировавших, и отчёт', async () => {
  config.tgBotToken = '1:test';
  config.adminTgIds = ['900'];
  try {
    const owner = { id: 900, first_name: 'Владелец' };
    assert.equal(await isOwnerTelegram(owner), true);
    assert.equal(await isOwnerTelegram({ id: 901 }), false);
    // Получатели: писавшие боту и вошедшие на сайт
    await rememberBotUser(owner);
    await rememberBotUser({ id: 111, first_name: 'A' });
    await rememberBotUser({ id: 222, first_name: 'B' });
    const siteUser = await makeUser(0); // вошёл на сайт через Telegram, боту не писал
    assert.equal(await countRecipients(), 4);

    const tg = fakeTelegram({ blocked: ['222'] });
    assert.deepEqual(await ownerBotMessage({ chat: { id: 900 }, from: owner, text: '/news', message_id: 1 }, tg.fetchImpl), { handled: true });
    const draft = await ownerBotMessage({ chat: { id: 900 }, from: owner, text: 'Новые кейсы уже на сайте!', message_id: 2 }, tg.fetchImpl);
    assert.ok(draft.id);
    const confirm = tg.calls.find((c) => c.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `bc:send:${draft.id}`);
    assert.ok(confirm, 'показали кнопку подтверждения');

    // Не-владелец не может запустить
    const r0 = await handleBroadcastCallback({ id: 'q0', from: { id: 901 }, data: `bc:send:${draft.id}` }, { fetchImpl: tg.fetchImpl });
    assert.equal(r0.status, undefined);

    let job;
    const r = await handleBroadcastCallback({ id: 'q1', from: owner, data: `bc:send:${draft.id}`, message: { chat: { id: 900 }, message_id: 3 } }, { fetchImpl: tg.fetchImpl, schedule: (p) => { job = p; } });
    assert.equal(r.status, 'sending');
    const res = await job;
    assert.equal(res.done, true);
    const copies = tg.calls.filter((c) => c.method === 'copyMessage');
    assert.deepEqual(copies.map((c) => c.chat_id).sort(), ['111', '222', '900', String(siteUser.telegram_id)].sort());
    assert.ok(copies.every((c) => c.from_chat_id === '900' && c.message_id === 2));
    assert.equal(res.sent, 3);
    assert.equal(res.failed, 1);
    assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /завершена/.test(c.text)), 'отчёт владельцу');
    // Заблокировавший больше не в списке
    assert.equal(await countRecipients(), 3);
    // Повторно ту же рассылку не запустить
    const again = await handleBroadcastCallback({ id: 'q2', from: owner, data: `bc:send:${draft.id}` }, { fetchImpl: tg.fetchImpl });
    assert.equal(again.status, undefined);
  } finally {
    config.adminTgIds = [];
    config.tgBotToken = '';
  }
});

test('новость: длинная рассылка продолжается со следующего получателя', async () => {
  config.tgBotToken = '1:test';
  try {
    for (let i = 0; i < 60; i++) await rememberBotUser({ id: 5000 + i });
    const db = await getDb();
    const b = await db.one(`insert into broadcasts (from_chat_id, message_id, created_by, status) values ('900', 7, '900', 'sending') returning id`);
    const tg = fakeTelegram();
    let continued = 0;
    const first = await runBroadcast(b.id, { fetchImpl: tg.fetchImpl, sliceMs: 1, continueImpl: async () => { continued++; } });
    assert.equal(first.done, false);
    assert.equal(continued, 1);
    let r = { done: false };
    while (!r.done) r = await runBroadcast(b.id, { fetchImpl: tg.fetchImpl, sliceMs: 1, continueImpl: async () => {} });
    const ids = tg.calls.filter((c) => c.method === 'copyMessage').map((c) => c.chat_id);
    assert.equal(ids.length, 60);
    assert.equal(new Set(ids).size, 60, 'никому не отправили дважды');
  } finally {
    config.tgBotToken = '';
  }
});
