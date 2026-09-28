import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, isAdmin } from './config.js';
import { verifyInitData } from './auth.js';
import { about, links, steps, catalog, since } from './content.js';
import { discordStats } from './discord.js';
import { STATUS, buildOrder, totalLabel } from './orders.js';

const WEB_DIR = path.resolve(import.meta.dirname, '../webapp');
const MAX_TEXT = 3500;
const MAX_IMAGE = 8 * 1024 * 1024;

const fail = (status, message) => Object.assign(new Error(message), { status });

function rateLimit(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw fail(429, 'Слишком часто, подожди немного');
    recent.push(now);
    hits.set(key, recent);
  };
}

const IMAGE_SIGNATURES = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  webp: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};

function saveImage(dataUrl, dir) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!m) throw fail(400, 'Можно отправить только JPG, PNG или WEBP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE) throw fail(413, 'Картинка слишком большая');
  if (!IMAGE_SIGNATURES[m[1]](buf)) throw fail(400, 'Файл повреждён');
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

const publicOrder = (o) => ({
  id: o.id,
  status: o.status,
  statusLabel: STATUS[o.status],
  items: o.items,
  total: totalLabel(o.total),
  comment: o.comment,
  createdAt: o.createdAt,
});

const publicUser = (u) =>
  u && { id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username };

export function createServer(db, chat) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/assets', express.static(path.join(WEB_DIR, 'assets'), { maxAge: '7d' }));
  app.use('/media', express.static(db.uploads, { maxAge: '30d', immutable: true, index: false }));
  app.use(
    express.static(WEB_DIR, {
      index: 'index.html',
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '12mb' }));

  const limitMessages = rateLimit(30, 60_000);
  const limitOrders = rateLimit(5, 10 * 60_000);

  api.get('/info', async (req, res) => {
    const discord = await discordStats();
    res.json({
      about,
      steps,
      catalog,
      links: { ...links, telegram: config.telegramLink || null },
      bot: config.botUsername || null,
      stats: {
        members: discord.members,
        online: discord.online,
        orders: db.countOrders('done') + config.completedOrdersBase,
        since,
      },
    });
  });

  // Всё ниже требует подписи Telegram
  api.use((req, res, next) => {
    const data = verifyInitData(req.get('X-Init-Data'), config.botToken);
    if (!data) throw fail(401, 'Открой приложение через Telegram');
    req.user = db.upsertUser(data.user);
    req.admin = isAdmin(data.user.id);
    next();
  });

  const adminOnly = (req, res, next) => (req.admin ? next() : next(fail(403, 'Нет доступа')));

  // В чьём чате действие: админ указывает клиента, клиент всегда в своём
  const threadOf = (req, raw) => {
    if (!req.admin) return req.user.id;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || !db.getUser(id)) throw fail(404, 'Клиент не найден');
    return id;
  };

  api.get('/me', (req, res) => {
    res.json({
      user: publicUser(req.user),
      isAdmin: req.admin,
      unread: req.admin ? db.totalUnreadAdmin() : db.unread(req.user.id, 'client'),
    });
  });

  api.get('/chat', (req, res) => {
    const userId = threadOf(req, req.query.user);
    db.seen(userId, req.admin ? 'admin' : 'client');
    res.json({
      messages: db.messages(userId, Number(req.query.after) || 0),
      orders: db.ordersOf(userId).map(publicOrder),
      peer: req.admin ? publicUser(db.getUser(userId)) : null,
    });
  });

  api.post('/chat', (req, res) => {
    const userId = threadOf(req, req.body?.user);
    const text = String(req.body?.text ?? '').trim();
    if (text.length > MAX_TEXT) throw fail(400, 'Слишком длинное сообщение');
    if (!text && !req.body?.image) throw fail(400, 'Пустое сообщение');
    limitMessages(req.user.id);

    const image = req.body?.image ? saveImage(String(req.body.image), db.uploads) : null;
    const message = req.admin ? chat.fromAdmin(userId, { text, image }) : chat.fromClient(req.user, { text, image });
    res.json({ message });
  });

  api.post('/orders', (req, res) => {
    let order;
    try {
      order = buildOrder(req.body?.items, req.body?.comment);
    } catch (err) {
      throw fail(400, err.message);
    }
    limitOrders(req.user.id);
    res.json({ order: publicOrder(chat.placeOrder(req.user, order)) });
  });

  api.get('/admin/threads', adminOnly, (req, res) => {
    res.json({
      threads: db.threads().map((t) => ({
        user: publicUser(t.user),
        last: t.last,
        unread: t.unread,
        updatedAt: t.updatedAt,
        order: t.order && { id: t.order.id, status: t.order.status, statusLabel: STATUS[t.order.status] },
      })),
    });
  });

  api.post('/admin/orders/:id', adminOnly, (req, res) => {
    const order = chat.setStatus(Number(req.params.id), String(req.body?.status));
    res.json({ order: publicOrder(order) });
  });

  api.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

  app.use('/api', api);

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message =
      status >= 500 ? 'Ошибка сервера, попробуй ещё раз'
      : err.type === 'entity.too.large' ? 'Картинка слишком большая'
      : err.type ? 'Неверный запрос'
      : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}
