import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { STATUS, itemLabel, totalLabel } from './orders.js';

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const STATUS_NOTICE = {
  new: (id) => `Заказ #${id} снова в очереди.`,
  work: (id) => `Взял заказ #${id} в работу.`,
  done: (id) => `Заказ #${id} готов.`,
  cancel: (id) => `Заказ #${id} отменён.`,
};

export const displayName = (u) =>
  [u?.firstName, u?.lastName].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : `ID ${u?.id}`);

const who = (u) => `<b>${esc(displayName(u))}</b>${u?.username ? ` · @${esc(u.username)}` : ''}`;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Всё общение клиент <-> админ проходит здесь: и из Mini App, и из самого бота.
// Уведомления отправляются до ответа на запрос: на Vercel после ответа функция может заснуть.
export function createChat(db, api, media) {
  const log = (where) => (err) => console.error(`[${where}]`, err.description || err.message);

  const appButton = (text, query = '') =>
    config.webAppUrl ? new InlineKeyboard().webApp(text, `${config.webAppUrl}/${query}`) : undefined;

  async function send(chatId, { html, photo, keyboard }) {
    const extra = { parse_mode: 'HTML', reply_markup: keyboard };
    if (photo) {
      if (html.length <= 1000) return api.sendPhoto(chatId, photo, { ...extra, caption: html });
      await api.sendPhoto(chatId, photo);
    }
    return api.sendMessage(chatId, html, { ...extra, link_preview_options: { is_disabled: true } });
  }

  // Шлём всем админам и запоминаем, какому клиенту принадлежит уведомление,
  // чтобы ответ реплаем в боте ушёл этому клиенту.
  // Уведомления идут всем админам в любом режиме, кроме самого автора (админ в режиме клиента)
  async function toAdmins(userId, build) {
    for (const adminId of await db.adminIds()) {
      if (adminId === Number(userId)) continue;
      try {
        const sent = await send(adminId, build());
        await db.setRelay(adminId, sent.message_id, userId);
      } catch (err) {
        log('admin')(err);
      }
    }
  }

  const photoFor = (fileId, image) => fileId || (image ? media.forTelegram(image) : null);

  async function orderHtml(order) {
    const u = (await db.getUser(order.userId)) || { id: order.userId };
    const lines = [
      `<b>Заказ #${order.id}</b> · ${STATUS[order.status]}`,
      `от ${who(u)}`,
      '',
      ...order.items.map((i) => `• ${esc(itemLabel(i))}`),
      '',
      `Итого: <b>${esc(totalLabel(order.total))}</b>`,
    ];
    if (order.comment) lines.push('', `<i>${esc(order.comment)}</i>`);
    return lines.join('\n');
  }

  function orderKeyboard(order) {
    const kb = config.webAppUrl
      ? new InlineKeyboard().webApp('Открыть чат', `${config.webAppUrl}/?chat=${order.userId}`).row()
      : new InlineKeyboard();
    for (const [status, label] of [['work', 'В работу'], ['done', 'Готов'], ['cancel', 'Отмена']]) {
      kb.text(order.status === status ? `· ${label} ·` : label, `st:${order.id}:${status}`);
    }
    return kb;
  }

  return {
    orderHtml,
    orderKeyboard,
    appButton,

    // fileId есть, если фото пришло через бота (перешлём без повторной загрузки)
    async fromClient(user, { text = '', image = null, fileId = null }) {
      const msg = await db.addMessage(user.id, { from: 'client', text, image });
      if (!(await db.isWatching(user.id, 'admin'))) {
        await toAdmins(user.id, () => ({
          html: [`💬 ${who(user)}`, esc(text)].filter(Boolean).join('\n'),
          photo: photoFor(fileId, image),
          keyboard: appButton('Открыть чат', `?chat=${user.id}`),
        }));
      }
      return msg;
    },

    async fromAdmin(userId, { text = '', image = null, fileId = null }) {
      const msg = await db.addMessage(userId, { from: 'admin', text, image });
      if (!(await db.isWatching(userId, 'client'))) {
        await send(userId, {
          html: ['<b>SOVSIDE</b>', esc(text)].filter(Boolean).join('\n'),
          photo: photoFor(fileId, image),
          keyboard: appButton('Открыть чат', '?tab=chat'),
        }).catch(log('client'));
      }
      return msg;
    },

    async placeOrder(user, { items, comment, total }) {
      const order = await db.createOrder(user.id, { items, comment, total });
      await db.addMessage(user.id, { from: 'system', kind: 'order', orderId: order.id, text: `Заказ #${order.id}` }, 'admin');
      const html = await orderHtml(order);
      await toAdmins(user.id, () => ({ html, keyboard: orderKeyboard(order) }));
      return order;
    },

    async setStatus(orderId, status) {
      if (!STATUS[status]) throw fail(400, 'Неизвестный статус');
      const current = await db.getOrder(orderId);
      if (!current) throw fail(404, 'Заказ не найден');
      const order = await db.setOrderStatus(orderId, status);
      if (!order) return current;

      await db.addMessage(
        order.userId,
        { from: 'system', kind: 'status', orderId, text: `Заказ #${orderId} · ${STATUS[status]}` },
        'client',
      );
      if (!(await db.isWatching(order.userId, 'client'))) {
        await send(order.userId, { html: STATUS_NOTICE[status](orderId), keyboard: appButton('Открыть чат', '?tab=chat') })
          .catch(log('client'));
      }
      return order;
    },

    // Скачивает фото из Telegram к себе, чтобы показать его в Mini App
    async downloadPhoto(fileId) {
      const file = await api.getFile(fileId);
      const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Не удалось скачать фото: ${res.status}`);
      const ext = path.extname(file.file_path).slice(1).toLowerCase();
      return media.save(Buffer.from(await res.arrayBuffer()), ['png', 'webp'].includes(ext) ? ext : 'jpg');
    },
  };
}
