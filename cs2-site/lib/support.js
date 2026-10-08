// Поддержка через Telegram-бота.
//   • Игрок пишет боту текст или шлёт медиа (фото, видео, кружок, голосовое, файл…) → сообщение попадает в его открытый тикет (или создаётся новый),
//     бот пересылает его всем админам (владельцы из настроек + назначенные в панели), которые нажимали /start.
//   • Админ отвечает на это сообщение (reply) — бот доставляет ответ игроку. Ещё можно: /reply N текст,
//     /tickets — открытые тикеты, /close N — закрыть.
//   • Медиа копируется (copyMessage) — без пересылки «от кого», поэтому ответы админов анонимны.
//   • То же самое — во вкладке «Поддержка» в админ-панели (медиа там отмечено, смотреть его — в боте).

import { config } from './config.js';
import { getDb } from './db.js';
import { fail } from './http.js';
import { tgApi } from './telegram.js';
import { isAdmin } from './users.js';

const MAX_TEXT = 3500;
const clip = (s) => String(s || '').trim().slice(0, MAX_TEXT);
// Медиа в сообщении Telegram → подпись для журнала тикета (null — обычный текст)
const MEDIA = [
  ['video_note', 'Кружок'], ['voice', 'Голосовое'], ['photo', 'Фото'], ['video', 'Видео'], ['animation', 'GIF'],
  ['audio', 'Аудио'], ['sticker', 'Стикер'], ['document', 'Файл'],
];
export function mediaOf(msg) {
  const hit = MEDIA.find(([k]) => msg?.[k]);
  return hit ? { chatId: msg.chat.id, messageId: msg.message_id, label: hit[1], group: msg.media_group_id || null } : null;
}
const logText = (body, media) => (media ? `📎 ${media.label} (смотреть в боте)${body ? `\n${body}` : ''}` : body);

const who = (t) => [t.tg_name || 'Игрок', t.tg_username ? `@${t.tg_username}` : null, `TG ${t.telegram_id}`].filter(Boolean).join(' · ');

// Все админы с Telegram: владельцы (по ID/нику из окружения) и назначенные в панели
async function adminChats(q) {
  const rows = await q.query(
    `select id, telegram_id, tg_username, is_admin, name from users
     where telegram_id is not null and (is_admin or telegram_id = any($1) or lower(tg_username) = any($2))`,
    [config.adminTgIds, config.adminTgUsernames],
  );
  const ids = new Set(rows.filter(isAdmin).map((r) => String(r.telegram_id)));
  for (const id of config.adminTgIds) ids.add(String(id)); // владелец мог ещё не заходить на сайт
  return [...ids];
}

export async function isAdminTelegram(telegramId) {
  if (config.adminTgIds.includes(String(telegramId))) return true;
  const u = await (await getDb()).one('select * from users where telegram_id = $1', [String(telegramId)]);
  return Boolean(u && isAdmin(u));
}

// Сообщение игрока → тикет; рассылка админам. media — из mediaOf(msg): копируем его админам как есть.
export async function userMessage(from, text, fetchImpl = fetch, media = null) {
  const db = await getDb();
  const body = clip(text);
  if (!body && !media) return null;
  const tgId = String(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 64) || null;
  const ticket = await db.tx(async (q) => {
    const user = await q.one('select id from users where telegram_id = $1', [tgId]);
    let t = await q.one(`select * from tickets where telegram_id = $1 and status = 'open' order by id desc limit 1 for update`, [tgId]);
    if (!t) {
      t = await q.one(
        `insert into tickets (telegram_id, user_id, tg_name, tg_username) values ($1, $2, $3, $4) returning *`,
        [tgId, user?.id ?? null, name, from.username || null],
      );
      t.isNew = true;
    }
    // Следующие фото того же альбома — без повторного «Добавили в обращение» и шапки у админов
    t.sameAlbum = Boolean(media?.group && t.last_media_group === media.group);
    await q.query('update tickets set tg_name = $2, tg_username = $3, last_media_group = $4, updated_at = now() where id = $1', [t.id, name, from.username || null, media?.group || null]);
    await q.query(`insert into ticket_messages (ticket_id, sender, text) values ($1, 'user', $2)`, [t.id, logText(body, media)]);
    return { ...t, tg_name: name, tg_username: from.username || null };
  });
  if (!ticket.sameAlbum) {
    await tgApi('sendMessage', {
      chat_id: tgId,
      text: ticket.isNew ? `✉️ Обращение #${ticket.id} создано — передали в поддержку. Ответим прямо здесь, обычно в течение часа.` : '✉️ Добавили в обращение — поддержка увидит.',
    }, fetchImpl).catch(() => {});
  }
  const chats = await adminChats(db);
  const head = `🆘 Тикет #${ticket.id}${ticket.isNew ? ' (новый)' : ''}\n${who(ticket)}`;
  const hint = `↩️ Ответь на это сообщение (текстом, фото, кружком…), чтобы ответить игроку. /close ${ticket.id} — закрыть.`;
  const remember = (chat, m) => db.query('insert into ticket_admin_messages (chat_id, message_id, ticket_id) values ($1, $2, $3) on conflict do nothing', [String(chat), m.message_id, ticket.id]);
  for (const chat of chats) {
    try {
      if (!media) {
        await remember(chat, await tgApi('sendMessage', { chat_id: chat, text: `${head}\n\n${body}\n\n${hint}` }, fetchImpl));
        continue;
      }
      if (!ticket.sameAlbum) await remember(chat, await tgApi('sendMessage', { chat_id: chat, text: `${head}\n\n📎 ${media.label}${body ? ' с подписью' : ''} — ниже.\n\n${hint}` }, fetchImpl));
      await remember(chat, await tgApi('copyMessage', { chat_id: chat, from_chat_id: media.chatId, message_id: media.messageId }, fetchImpl));
    } catch (err) { console.warn(`Тикет #${ticket.id}: не доставлен админу ${chat}: ${err.message}`); }
  }
  return ticket;
}

// Ответ админа (из бота или панели) → игроку
// media — из mediaOf(msg): админ ответил фото, кружком и т.п. (копия, без «переслано от»)
export async function adminReply(ticketId, text, _admin, fetchImpl = fetch, media = null) {
  const body = clip(text);
  if (!body && !media) fail(400, 'Напиши текст ответа');
  const db = await getDb();
  const t = await db.one('select * from tickets where id = $1', [ticketId]);
  if (!t) fail(404, 'Тикет не найден');
  const deliver = async () => {
    if (!media) return tgApi('sendMessage', { chat_id: t.telegram_id, text: `💬 Поддержка LuxeDrop:\n\n${body}` }, fetchImpl);
    await tgApi('sendMessage', { chat_id: t.telegram_id, text: body ? `💬 Поддержка LuxeDrop:\n\n${body}` : '💬 Поддержка LuxeDrop:' }, fetchImpl);
    // Подпись уже отправлена текстом выше — у копии её убираем (caption: '')
    return tgApi('copyMessage', { chat_id: t.telegram_id, from_chat_id: media.chatId, message_id: media.messageId, caption: '' }, fetchImpl);
  };
  await deliver().catch((err) => fail(502, `Не удалось доставить ответ в Telegram: ${err.message}`));
  // Кто из админов ответил, не сохраняем и не показываем — для всех это просто «Поддержка»
  await db.query(`insert into ticket_messages (ticket_id, sender, text) values ($1, 'admin', $2)`, [t.id, logText(body, media)]);
  await db.query(`update tickets set status = 'open', updated_at = now() where id = $1`, [t.id]);
  return { ok: true };
}

export async function setTicketStatus(ticketId, status, fetchImpl = fetch) {
  if (!['open', 'closed'].includes(status)) fail(400, 'Неизвестный статус');
  const db = await getDb();
  const t = await db.one('update tickets set status = $2, updated_at = now() where id = $1 returning *', [ticketId, status]);
  if (!t) fail(404, 'Тикет не найден');
  if (status === 'closed') {
    await tgApi('sendMessage', { chat_id: t.telegram_id, text: `✅ Обращение #${t.id} закрыто. Если остались вопросы — просто напиши сюда снова.` }, fetchImpl).catch(() => {});
  }
  return t;
}

export async function listTickets(status = 'open') {
  const db = await getDb();
  return db.query(
    `select t.*, (select text from ticket_messages m where m.ticket_id = t.id order by m.id desc limit 1) as last_text,
            (select sender from ticket_messages m where m.ticket_id = t.id order by m.id desc limit 1) as last_sender,
            (select count(*) from ticket_messages m where m.ticket_id = t.id)::int as messages
     from tickets t where t.status = $1 order by t.updated_at desc limit 100`,
    [status === 'closed' ? 'closed' : 'open'],
  );
}

export async function getTicket(id) {
  const db = await getDb();
  const t = await db.one('select * from tickets where id = $1', [id]);
  if (!t) fail(404, 'Тикет не найден');
  const messages = await db.query('select id, sender, text, created_at from ticket_messages where ticket_id = $1 order by id', [id]);
  return { ticket: t, messages };
}

// Сообщение от админа в боте: ответ (reply) на пересланный тикет или команды
export async function adminBotMessage(msg, fetchImpl = fetch) {
  const db = await getDb();
  const send = (text) => tgApi('sendMessage', { chat_id: msg.chat.id, text }, fetchImpl);
  const text = msg.text || msg.caption || '';
  const media = mediaOf(msg);

  if (text.startsWith('/tickets')) {
    const list = await listTickets('open');
    await send(list.length
      ? `Открытые тикеты (${list.length}):\n\n${list.slice(0, 20).map((t) => `#${t.id} · ${who(t)}\n${t.last_sender === 'user' ? '❗' : '✅'} ${String(t.last_text || '').slice(0, 80)}`).join('\n\n')}\n\nОтветить: /reply N текст`
      : 'Открытых тикетов нет 👌');
    return { handled: true };
  }
  const close = text.match(/^\/close\s+#?(\d+)/);
  if (close) {
    await setTicketStatus(Number(close[1]), 'closed', fetchImpl);
    await send(`Тикет #${close[1]} закрыт`);
    return { handled: true };
  }
  const cmd = text.match(/^\/reply\s+#?(\d+)(?:\s+([\s\S]+))?$/);
  let ticketId = cmd ? Number(cmd[1]) : null;
  let body = cmd ? cmd[2] || '' : null;
  if (!ticketId && msg.reply_to_message) {
    const map = await db.one('select ticket_id from ticket_admin_messages where chat_id = $1 and message_id = $2', [String(msg.chat.id), msg.reply_to_message.message_id]);
    if (map) { ticketId = map.ticket_id; body = text; }
  }
  if (!ticketId) return { handled: false };
  try {
    await adminReply(ticketId, body, null, fetchImpl, media);
    await send(`✅ Ответ на тикет #${ticketId} отправлен`);
  } catch (err) { await send(`⚠️ ${err.message}`); }
  return { handled: true };
}
