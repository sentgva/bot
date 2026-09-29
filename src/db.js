import { config } from './config.js';

// Данные бота поверх хранилища из store.js (Redis или файл).
//
//   sv:users            hash  id -> пользователь
//   sv:m:<id>           zset  сообщения чата клиента (score = id сообщения)
//   sv:t:*              hash  id клиента -> время, последнее сообщение, непрочитанное, версия чата
//   sv:orders           hash  id заказа -> заказ;  sv:uo:<id> list — заказы клиента
//   sv:seen:<side>:<id>       «сейчас смотрит этот чат в приложении», живёт 10 секунд
//   sv:relay:<chat>:<msg>     какому клиенту принадлежит уведомление у админа

const OTHER_SIDE = { client: 'admin', admin: 'client' };
const UNREAD = { admin: 't:ua', client: 't:uc' };

const J = (v) => JSON.stringify(v);
const P = (s) => (s == null ? null : JSON.parse(s));
const pairs = (flat) => {
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
};

// prefix позволяет держать в одной базе несколько ботов (или тесты)
export function openDb(store, { prefix = 'sv' } = {}) {
  const K = (...parts) => `${prefix}:${parts.join(':')}`;
  const users = new Map(); // кэш, чтобы не писать пользователя на каждый запрос
  let admins = { at: 0, ids: null };

  const db = {
    store,

    async upsertUser(u) {
      const id = String(u.id);
      const prevJson = users.get(id) ?? (await store.cmd('HGET', K('users'), id));
      const prev = P(prevJson);
      const next = {
        id: u.id,
        firstName: u.first_name || '',
        lastName: u.last_name || '',
        username: u.username || '',
        createdAt: prev?.createdAt || Date.now(),
      };
      const json = J(next);
      if (json !== prevJson) await store.cmd('HSET', K('users'), id, json);
      users.set(id, json);
      return next;
    },

    getUser: async (id) => P(await store.cmd('HGET', K('users'), String(id))),

    // from: 'client' | 'admin' | 'system'; kind у системных: 'order' | 'status'
    async addMessage(userId, { from, text = '', image = null, orderId = null, kind = null }, unreadFor = OTHER_SIDE[from]) {
      const id = Number(await store.cmd('INCR', K('seq', 'msg')));
      const msg = { id, from, kind, text, image, orderId, at: Date.now() };
      const u = String(userId);
      const cmds = [
        ['ZADD', K('m', u), id, J(msg)],
        ['HSET', K('t', 'updated'), u, msg.at],
        ['HSET', K('t', 'last'), u, J(msg)],
        ['HINCRBY', K('t', 'ver'), u, 1],
      ];
      if (UNREAD[unreadFor]) cmds.push(['HINCRBY', K(UNREAD[unreadFor]), u, 1]);
      await store.pipe(cmds);
      return msg;
    },

    messages: async (userId, afterId = 0) =>
      (await store.cmd('ZRANGEBYSCORE', K('m', userId), `(${afterId}`, '+inf')).map(P),

    // Отметка «смотрю чат» + версия чата одним запросом. Если версия не изменилась,
    // клиенту нечего перерисовывать и можно не читать сообщения.
    async touch(userId, side) {
      const [, ver] = await store.pipe([
        ['SET', K('seen', side, userId), 1, 'EX', 10],
        ['HGET', K('t', 'ver'), String(userId)],
      ]);
      return Number(ver) || 0;
    },

    markRead: (userId, side) => store.cmd('HSET', K(UNREAD[side]), String(userId), 0),

    isWatching: async (userId, side) => (await store.cmd('EXISTS', K('seen', side, userId))) > 0,

    unread: async (userId, side) => Number(await store.cmd('HGET', K(UNREAD[side]), String(userId))) || 0,

    async totalUnreadAdmin() {
      const vals = await store.cmd('HVALS', K('t', 'ua'));
      return vals.reduce((sum, v) => sum + (Number(v) || 0), 0);
    },

    async threads() {
      const [updated, last, unread, order] = (
        await store.pipe([
          ['HGETALL', K('t', 'updated')],
          ['HGETALL', K('t', 'last')],
          ['HGETALL', K('t', 'ua')],
          ['HGETALL', K('t', 'order')],
        ])
      ).map(pairs);
      const ids = Object.keys(updated).sort((a, b) => updated[b] - updated[a]).slice(0, 200);
      if (!ids.length) return [];
      const people = await store.cmd('HMGET', K('users'), ...ids);
      return ids.map((id, i) => ({
        user: P(people[i]) || { id: Number(id) },
        last: P(last[id]),
        unread: Number(unread[id]) || 0,
        updatedAt: Number(updated[id]),
        order: P(order[id]),
      }));
    },

    async createOrder(userId, data) {
      const id = Number(await store.cmd('INCR', K('seq', 'order')));
      const order = { id, userId: Number(userId), status: 'new', createdAt: Date.now(), updatedAt: Date.now(), ...data };
      const u = String(userId);
      await store.pipe([
        ['HSET', K('orders'), id, J(order)],
        ['RPUSH', K('uo', u), id],
        ['HSET', K('t', 'order'), u, J({ id, status: order.status })],
      ]);
      return order;
    },

    getOrder: async (id) => P(await store.cmd('HGET', K('orders'), String(id))),

    async setOrderStatus(id, status) {
      const order = await db.getOrder(id);
      if (!order || order.status === status) return null;
      const prev = order.status;
      order.status = status;
      order.updatedAt = Date.now();
      const u = String(order.userId);
      const [latest] = await store.cmd('LRANGE', K('uo', u), -1, -1);
      const cmds = [
        ['HSET', K('orders'), id, J(order)],
        ['HINCRBY', K('t', 'ver'), u, 1],
      ];
      if (Number(latest) === order.id) cmds.push(['HSET', K('t', 'order'), u, J({ id: order.id, status })]);
      if (status === 'done') cmds.push(['INCR', K('stat', 'done')]);
      if (prev === 'done') cmds.push(['DECRBY', K('stat', 'done'), 1]);
      await store.pipe(cmds);
      return order;
    },

    async ordersOf(userId) {
      const ids = await store.cmd('LRANGE', K('uo', userId), 0, -1);
      if (!ids.length) return [];
      return (await store.cmd('HMGET', K('orders'), ...ids)).map(P).filter(Boolean);
    },

    countDone: async () => Math.max(0, Number(await store.cmd('GET', K('stat', 'done'))) || 0),

    setRelay: (chatId, messageId, userId) =>
      store.cmd('SET', K('relay', chatId, messageId), userId, 'EX', 60 * 24 * 3600),

    getRelay: async (chatId, messageId) => Number(await store.cmd('GET', K('relay', chatId, messageId))) || null,

    // Админы: из ADMIN_ID и назначенные по секретной ссылке
    async adminIds() {
      if (admins.ids && Date.now() - admins.at < 30_000) return admins.ids;
      const saved = await store.cmd('SMEMBERS', K('admins'));
      admins = { at: Date.now(), ids: new Set([...config.adminIds, ...saved.map(Number)]) };
      return admins.ids;
    },
    isAdmin: async (id) => (await db.adminIds()).has(Number(id)),
    // Админ может временно работать как обычный клиент: 'admin' | 'client'
    getMode: async (id) => (await store.cmd('HGET', K('mode'), String(id))) || 'admin',
    setMode: (id, mode) => store.cmd('HSET', K('mode'), String(id), mode === 'client' ? 'client' : 'admin'),
    // Права админа и при этом не в режиме клиента
    actsAsAdmin: async (id) => (await db.isAdmin(id)) && (await db.getMode(id)) !== 'client',
    async addAdmin(id) {
      await store.cmd('SADD', K('admins'), id);
      admins = { at: 0, ids: null };
    },

    userIds: async () => (await store.cmd('HKEYS', K('users'))).map(Number),

    // Рассылка /news: «жду текст», черновики и защита от повторной отправки
    setNewsAwait: (adminId) => store.cmd('SET', K('news', 'await', adminId), 1, 'EX', 1800),
    isNewsAwait: async (adminId) => (await store.cmd('EXISTS', K('news', 'await', adminId))) > 0,
    clearNewsAwait: (adminId) => store.cmd('DEL', K('news', 'await', adminId)),
    async saveNewsDraft(draft) {
      const id = Number(await store.cmd('INCR', K('seq', 'news')));
      await store.cmd('SET', K('news', 'draft', id), J(draft), 'EX', 7 * 86400);
      return id;
    },
    getNewsDraft: async (id) => P(await store.cmd('GET', K('news', 'draft', id))),
    // true только для первого вызова: кнопку нажали дважды или Telegram повторил апдейт — второй раз не шлём
    async claimNews(id) {
      const [n] = await store.pipe([['INCR', K('news', 'lock', id)], ['EXPIRE', K('news', 'lock', id), 30 * 86400]]);
      return Number(n) === 1;
    },

    // Лимит запросов, общий для всех копий сервера
    async hit(kind, id, max, windowSec) {
      const key = K('rl', kind, id, Math.floor(Date.now() / 1000 / windowSec));
      const [n] = await store.pipe([['INCR', key], ['EXPIRE', key, windowSec]]);
      return Number(n) <= max;
    },

    cacheGet: async (key) => P(await store.cmd('GET', K('cache', key))),
    cacheSet: (key, value, ttlSec) => store.cmd('SET', K('cache', key), J(value), 'EX', ttlSec),
  };
  return db;
}
