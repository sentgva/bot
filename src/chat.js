import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InlineKeyboard, InputFile } from 'grammy';
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

// Всё общение клиент <-> админ проходит здесь: и из Mini App, и из самого бота.
// Каждый клиент видит только свой чат, админ видит все.
export function createChat(db, api) {
  const log = (where) => (err) => console.error(`[${where}]`, err.description || err.message);

  const appButton = (text, query = '') =>
    config.webAppUrl ? new InlineKeyboard().webApp(text, `${config.webAppUrl}/${query}`) : undefined;

  const localPhoto = (name) => (name ? new InputFile(path.join(db.uploads, name)) : null);

  async function send(chatId, { html, photo, keyboard }) {
    const extra = { parse_mode: 'HTML', reply_markup: keyboard };
    if (photo) {
      if (html.length <= 1000) return api.sendPhoto(chatId, photo, { ...extra, caption: html });
      await api.sendPhoto(chatId, photo);
    }
    return api.sendMessage(chatId, html, { ...extra, link_preview_options: { is_disabled: true } });
  }

  // Шлём всем админам и запоминаем, какому клиенту принадлежит сообщение,
  // чтобы ответ реплаем в боте ушёл этому клиенту.
  async function toAdmins(userId, build) {
    for (const adminId of config.adminIds) {
      try {
        const sent = await send(adminId, build());
        db.setRelay(adminId, sent.message_id, userId);
      } catch (err) {
        log('admin')(err);
      }
    }
  }

  function orderHtml(order) {
    const u = db.getUser(order.userId) || { id: order.userId };
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

    // Сообщение от клиента. fileId есть, если фото пришло через бота (перешлём без повторной загрузки).
    fromClient(user, { text = '', image = null, fileId = null }) {
      const msg = db.addMessage(user.id, { from: 'client', text, image });
      if (!db.isWatching(user.id, 'admin')) {
        toAdmins(user.id, () => ({
          html: [`💬 ${who(user)}`, esc(text)].filter(Boolean).join('\n'),
          photo: fileId || localPhoto(image),
          keyboard: appButton('Открыть чат', `?chat=${user.id}`),
        }));
      }
      return msg;
    },

    fromAdmin(userId, { text = '', image = null, fileId = null }) {
      const msg = db.addMessage(userId, { from: 'admin', text, image });
      if (!db.isWatching(userId, 'client')) {
        send(userId, {
          html: ['<b>SOVSIDE</b>', esc(text)].filter(Boolean).join('\n'),
          photo: fileId || localPhoto(image),
          keyboard: appButton('Открыть чат', '?tab=chat'),
        }).catch(log('client'));
      }
      return msg;
    },

    placeOrder(user, { items, comment, total }) {
      const order = db.createOrder(user.id, { items, comment, total });
      db.addMessage(user.id, { from: 'system', kind: 'order', orderId: order.id, text: `Заказ #${order.id}` }, 'admin');
      toAdmins(user.id, () => ({ html: orderHtml(order), keyboard: orderKeyboard(order) }));
      return order;
    },

    setStatus(orderId, status) {
      if (!STATUS[status]) throw Object.assign(new Error('Неизвестный статус'), { status: 400 });
      const current = db.getOrder(orderId);
      if (!current) throw Object.assign(new Error('Заказ не найден'), { status: 404 });
      const order = db.setOrderStatus(orderId, status);
      if (!order) return current;

      db.addMessage(
        order.userId,
        { from: 'system', kind: 'status', orderId, text: `Заказ #${orderId} · ${STATUS[status]}` },
        'client',
      );
      if (!db.isWatching(order.userId, 'client')) {
        send(order.userId, { html: STATUS_NOTICE[status](orderId), keyboard: appButton('Открыть чат', '?tab=chat') })
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
      const name = `${crypto.randomBytes(12).toString('hex')}${path.extname(file.file_path) || '.jpg'}`;
      await fs.promises.writeFile(path.join(db.uploads, name), Buffer.from(await res.arrayBuffer()));
      return name;
    },
  };
}
