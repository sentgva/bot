import fs from 'node:fs';
import path from 'node:path';

// Простое хранилище в JSON-файле. Для личного бота с заказами этого хватает с запасом:
// всё держится в памяти, на диск пишется атомарно с небольшой задержкой.

const RELAY_LIMIT = 5000;
const OTHER_SIDE = { client: 'admin', admin: 'client' };

const empty = () => ({
  seq: { msg: 0, order: 0 },
  users: {},
  threads: {},
  orders: {},
  relay: {},
});

export function openDb(dir) {
  const file = path.join(dir, 'db.json');
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });

  const state = empty();
  if (fs.existsSync(file)) Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8')));

  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };
  const save = () => {
    if (!timer) timer = setTimeout(flush, 250);
  };

  const ordersOf = (userId) =>
    Object.values(state.orders)
      .filter((o) => o.userId === Number(userId))
      .sort((a, b) => a.id - b.id);

  // side: 'client' | 'admin'
  const markRead = (userId, side) => {
    const t = state.threads[userId];
    const key = side === 'admin' ? 'unreadAdmin' : 'unreadClient';
    if (t?.[key]) {
      t[key] = 0;
      save();
    }
  };

  const thread = (userId) => {
    const id = String(userId);
    state.threads[id] ??= {
      userId: Number(userId),
      messages: [],
      updatedAt: 0,
      unreadAdmin: 0,
      unreadClient: 0,
      clientSeenAt: 0,
      adminSeenAt: 0,
    };
    return state.threads[id];
  };

  return {
    uploads,
    flush,

    upsertUser(u) {
      const prev = state.users[u.id];
      const next = {
        id: u.id,
        firstName: u.first_name || '',
        lastName: u.last_name || '',
        username: u.username || '',
        createdAt: prev?.createdAt || Date.now(),
      };
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
        state.users[u.id] = next;
        save();
      }
      return next;
    },

    getUser: (id) => state.users[id] || null,

    // from: 'client' | 'admin' | 'system'; unreadFor: чья сторона получит «непрочитанное»
    // kind у системных сообщений: 'order' (новый заказ) | 'status' (смена статуса)
    addMessage(userId, { from, text = '', image = null, orderId = null, kind = null }, unreadFor = OTHER_SIDE[from]) {
      const t = thread(userId);
      const msg = { id: ++state.seq.msg, from, kind, text, image, orderId, at: Date.now() };
      t.messages.push(msg);
      t.updatedAt = msg.at;
      if (unreadFor === 'admin') t.unreadAdmin++;
      if (unreadFor === 'client') t.unreadClient++;
      save();
      return msg;
    },

    messages(userId, afterId = 0) {
      const t = state.threads[userId];
      if (!t) return [];
      return afterId ? t.messages.filter((m) => m.id > afterId) : t.messages;
    },

    hasThread: (userId) => Boolean(state.threads[userId]?.messages.length),

    markRead,

    // Сторона открыла чат в Mini App
    seen(userId, side) {
      thread(userId)[`${side}SeenAt`] = Date.now();
      markRead(userId, side);
    },

    // Смотрит ли сторона в этот чат прямо сейчас (Mini App опрашивает сервер каждые пару секунд)
    isWatching(userId, side, windowMs = 9000) {
      const t = state.threads[userId];
      return Boolean(t && Date.now() - t[`${side}SeenAt`] < windowMs);
    },

    unread(userId, side) {
      const t = state.threads[userId];
      if (!t) return 0;
      return side === 'admin' ? t.unreadAdmin : t.unreadClient;
    },

    threads() {
      return Object.values(state.threads)
        .filter((t) => t.messages.length)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => ({
          user: state.users[t.userId] || { id: t.userId },
          last: t.messages[t.messages.length - 1],
          unread: t.unreadAdmin,
          updatedAt: t.updatedAt,
          order: ordersOf(t.userId).at(-1) || null,
        }));
    },

    totalUnreadAdmin: () => Object.values(state.threads).reduce((s, t) => s + t.unreadAdmin, 0),

    createOrder(userId, data) {
      const order = {
        id: ++state.seq.order,
        userId: Number(userId),
        status: 'new',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...data,
      };
      state.orders[order.id] = order;
      save();
      return order;
    },

    getOrder: (id) => state.orders[id] || null,

    setOrderStatus(id, status) {
      const order = state.orders[id];
      if (!order || order.status === status) return null;
      order.status = status;
      order.updatedAt = Date.now();
      save();
      return order;
    },

    ordersOf,

    countOrders: (status) => Object.values(state.orders).filter((o) => o.status === status).length,

    // Связь «сообщение бота у админа» -> клиент, чтобы ответ реплаем ушёл нужному человеку
    setRelay(chatId, messageId, userId) {
      state.relay[`${chatId}:${messageId}`] = Number(userId);
      const keys = Object.keys(state.relay);
      if (keys.length > RELAY_LIMIT) {
        for (const k of keys.slice(0, keys.length - RELAY_LIMIT)) delete state.relay[k];
      }
      save();
    },

    getRelay: (chatId, messageId) => state.relay[`${chatId}:${messageId}`] || null,
  };
}
