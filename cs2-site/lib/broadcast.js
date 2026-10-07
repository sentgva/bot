// Рассылка новостей через Telegram-бота (только владелец — ADMIN_TG_IDS / ADMIN_TG_USERNAMES).
//   1. /news → бот ждёт сообщение новости (текст, фото, видео — что угодно, форматирование сохраняется).
//   2. Сообщение сохраняется черновиком, бот показывает число получателей и кнопки «Отправить всем» / «Отмена».
//   3. Рассылка — copyMessage каждому, кто писал боту или входил на сайт через Telegram, с кнопкой «Открыть LuxeDrop».
//      Не больше ~25 сообщений в секунду (лимит Telegram — 30). Функция Vercel живёт до 60 с, поэтому рассылка
//      идёт порциями: если не успели, вызываем сами себя через /api/broadcast/continue и продолжаем с того же места.
//   4. Заблокировавших бота помечаем и больше не пытаемся; владельцу приходит отчёт.

import { config } from './config.js';
import { getDb } from './db.js';
import { webAppUrl } from './telegram.js';
import { isOwner } from './users.js';

const RATE = 25;          // сообщений в секунду
const SLICE_MS = 45_000;  // сколько работаем за один вызов функции
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, body, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${config.tgBotToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return res.json().catch(() => ({ ok: false, description: 'bad json' }));
}

export async function isOwnerTelegram(from) {
  if (!from) return false;
  if (config.adminTgIds.includes(String(from.id))) return true;
  if (from.username && config.adminTgUsernames.includes(String(from.username).toLowerCase())) return true;
  const u = await (await getDb()).one('select * from users where telegram_id = $1', [String(from.id)]);
  return Boolean(u && isOwner(u));
}

// Каждый, кто писал боту, — подписчик рассылки
export async function rememberBotUser(from) {
  if (!from?.id) return;
  await (await getDb()).query(
    `insert into bot_users (telegram_id, first_name, username) values ($1, $2, $3)
     on conflict (telegram_id) do update set first_name = excluded.first_name, username = excluded.username, blocked = false, last_seen_at = now()`,
    [String(from.id), from.first_name || null, from.username || null],
  );
}

// Получатели: писавшие боту + вошедшие на сайт через Telegram, кроме заблокировавших бота
const RECIPIENTS = `
  select telegram_id from (select telegram_id from bot_users union select telegram_id from users where telegram_id is not null) r
  where telegram_id not in (select telegram_id from bot_users where blocked)`;

export async function countRecipients() {
  return (await (await getDb()).one(`select count(*)::int as n from (${RECIPIENTS}) x`)).n;
}

// Сообщение владельца в боте: команды /news, /cancel и сама новость. Возвращает { handled }.
export async function ownerBotMessage(msg, fetchImpl = fetch) {
  const db = await getDb();
  const chat = String(msg.chat.id);
  const text = typeof msg.text === 'string' ? msg.text : '';
  const send = (t, extra = {}) => tg('sendMessage', { chat_id: chat, text: t, ...extra }, fetchImpl);
  const state = await db.one('select value from bot_state where telegram_id = $1', [chat]);

  if (text.startsWith('/news')) {
    await db.query(`insert into bot_state (telegram_id, value) values ($1, 'news') on conflict (telegram_id) do update set value = 'news'`, [chat]);
    await send('📰 Пришли новость одним сообщением — текст, фото или видео с подписью. Форматирование сохранится.\n\n/cancel — отмена.');
    return { handled: true };
  }
  if (text.startsWith('/cancel') && state) {
    await db.query('delete from bot_state where telegram_id = $1', [chat]);
    await send('Рассылка отменена.');
    return { handled: true };
  }
  if (state?.value !== 'news' || text.startsWith('/')) return { handled: false };

  // Это и есть новость: сохраняем черновик и спрашиваем подтверждение
  await db.query('delete from bot_state where telegram_id = $1', [chat]);
  const b = await db.one(
    `insert into broadcasts (from_chat_id, message_id, created_by) values ($1, $2, $3) returning id`,
    [chat, msg.message_id, String(msg.from.id)],
  );
  const n = await countRecipients();
  await send(`Отправить эту новость всем? Получателей: ${n}.`, {
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: [[{ text: `✅ Отправить всем (${n})`, callback_data: `bc:send:${b.id}` }, { text: '❌ Отмена', callback_data: `bc:cancel:${b.id}` }]] },
  });
  return { handled: true, id: b.id };
}

// Нажатие кнопки под черновиком
export async function handleBroadcastCallback(cq, { schedule = (p) => p, fetchImpl = fetch } = {}) {
  const m = String(cq.data || '').match(/^bc:(send|cancel):(\d+)$/);
  if (!m) return { handled: false };
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text }, fetchImpl);
  if (!(await isOwnerTelegram(cq.from))) { await answer('Рассылку запускает только владелец'); return { handled: true }; }
  const db = await getDb();
  const id = Number(m[2]);
  const next = m[1] === 'send' ? 'sending' : 'cancelled';
  const b = await db.one(`update broadcasts set status = $2, started_at = case when $2 = 'sending' then now() else started_at end
                          where id = $1 and status = 'draft' returning *`, [id, next]);
  if (!b) { await answer('Эта рассылка уже запущена или отменена'); return { handled: true }; }
  await answer(next === 'sending' ? 'Рассылка запущена' : 'Отменено');
  if (cq.message) {
    await tg('editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: next === 'sending' ? '🚀 Рассылка запущена. Пришлю отчёт, когда закончу.' : 'Рассылка отменена.',
    }, fetchImpl);
  }
  if (next === 'sending') schedule(runBroadcast(id, { fetchImpl }));
  return { handled: true, status: next };
}

// Отправка порцией; вернёт { done } — закончили или нужно продолжить следующим вызовом
export async function runBroadcast(id, { fetchImpl = fetch, sliceMs = SLICE_MS, continueImpl = continueLater } = {}) {
  const db = await getDb();
  const b = await db.one(`select * from broadcasts where id = $1 and status = 'sending'`, [id]);
  if (!b) return { done: true };
  const until = Date.now() + sliceMs;
  const keyboard = { inline_keyboard: [[{ text: '🎯 Открыть LuxeDrop', web_app: { url: webAppUrl() } }]] };
  let { cursor } = b;
  while (Date.now() < until) {
    const batch = (await db.query(`select telegram_id from (${RECIPIENTS}) x where telegram_id > $1 order by telegram_id limit $2`, [cursor || '', RATE])).map((r) => r.telegram_id);
    if (!batch.length) {
      const fin = await db.one(`update broadcasts set status = 'done', finished_at = now() where id = $1 returning *`, [id]);
      await tg('sendMessage', { chat_id: b.from_chat_id, text: `✅ Рассылка #${id} завершена.\nДоставлено: ${fin.sent}\nНе доставлено: ${fin.failed} (заблокировали бота или ни разу ему не писали)` }, fetchImpl);
      return { done: true, sent: fin.sent, failed: fin.failed };
    }
    const started = Date.now();
    const results = await Promise.all(batch.map(async (chatId) => {
      let r = await tg('copyMessage', { chat_id: chatId, from_chat_id: b.from_chat_id, message_id: b.message_id, reply_markup: keyboard }, fetchImpl);
      if (!r.ok && r.error_code === 429) { await sleep((r.parameters?.retry_after || 1) * 1000); r = await tg('copyMessage', { chat_id: chatId, from_chat_id: b.from_chat_id, message_id: b.message_id, reply_markup: keyboard }, fetchImpl); }
      if (!r.ok && (r.error_code === 403 || r.error_code === 400)) {
        await db.query(`insert into bot_users (telegram_id, blocked) values ($1, true) on conflict (telegram_id) do update set blocked = true`, [chatId]);
      }
      return r.ok;
    }));
    cursor = batch[batch.length - 1];
    const ok = results.filter(Boolean).length;
    await db.query('update broadcasts set cursor = $2, sent = sent + $3, failed = failed + $4 where id = $1', [id, cursor, ok, results.length - ok]);
    const spent = Date.now() - started;
    if (spent < 1000) await sleep(1000 - spent);
  }
  await continueImpl(id);
  return { done: false };
}

// Продолжение в новом вызове функции (секрет — CRON_SECRET)
async function continueLater(id) {
  if (!config.cronSecret) { console.warn(`Рассылка #${id}: нет CRON_SECRET — продолжу при следующем запуске`); return; }
  await fetch(`${config.siteUrl}/api/broadcast/continue`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.cronSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }).catch((err) => console.warn(`Рассылка #${id}: не удалось продолжить: ${err.message}`));
}
