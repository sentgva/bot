import path from 'node:path';
import express from 'express';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { verifyInitData } from './auth.js';
import { about, links, steps, catalog, since, payment } from './content.js';
import { discordStats } from './discord.js';
import { STATUS, buildOrder, totalLabel } from './orders.js';

const WEB_DIR = path.resolve(import.meta.dirname, '../webapp');
const MAX_TEXT = 3500;
const MAX_IMAGE = 3 * 1024 * 1024; // на Vercel тело запроса не больше 4.5 МБ

const fail = (status, message) => Object.assign(new Error(message), { status });

const IMAGE_SIGNATURES = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  webp: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};

function decodeImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!m) throw fail(400, 'Можно отправить только JPG, PNG или WEBP');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_IMAGE) throw fail(413, 'Картинка слишком большая');
  if (!IMAGE_SIGNATURES[m[1]](buffer)) throw fail(400, 'Файл повреждён');
  return { buffer, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
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

// static: раздавать ли Mini App самим сервером (на Vercel это делает CDN)
export function createServer({ db, chat, bot, media, webhook = false, serveStatic = true }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  if (serveStatic) {
    app.use('/assets', express.static(path.join(WEB_DIR, 'assets'), { maxAge: '7d' }));
    if (media.uploads) app.use('/media', express.static(media.uploads, { maxAge: '30d', immutable: true, index: false }));
    app.use(express.static(WEB_DIR, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  }

  const api = express.Router();
  api.use(express.json({ limit: '4mb' }));

  if (webhook) {
    // Telegram присылает апдейты сюда, заголовок с секретом проверяет grammY
    api.post('/telegram', webhookCallback(bot, 'express', { secretToken: config.webhookSecret, timeoutMilliseconds: 25_000 }));
  }

  api.get('/info', async (req, res) => {
    const [discord, done] = await Promise.all([discordStats(db), db.countDone()]);
    if (!config.botUsername) {
      await bot.init().then(() => (config.botUsername = bot.botInfo.username)).catch(() => {});
    }
    res.set('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.json({
      about,
      steps,
      catalog,
      payment,
      links: { ...links, telegram: config.telegramLink || null },
      bot: config.botUsername || null,
      stats: {
        members: discord.members,
        online: discord.online,
        orders: done + config.completedOrdersBase,
        since,
      },
    });
  });

  // Всё ниже требует подписи Telegram
  api.use(async (req, res, next) => {
    const data = verifyInitData(req.get('X-Init-Data'), config.botToken);
    if (!data) throw fail(401, 'Открой приложение через Telegram');
    req.user = await db.upsertUser(data.user);
    req.canAdmin = await db.isAdmin(data.user.id);
    req.admin = req.canAdmin && (await db.getMode(data.user.id)) !== 'client';
    res.set('Cache-Control', 'no-store');
    next();
  });

  const adminOnly = (req, res, next) => (req.admin ? next() : next(fail(403, 'Нет доступа')));

  // В чьём чате действие: админ указывает клиента, клиент всегда в своём
  const threadOf = async (req, raw) => {
    if (!req.admin) return req.user.id;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || !(await db.getUser(id))) throw fail(404, 'Клиент не найден');
    return id;
  };

  const me = async (req) => ({
    user: publicUser(req.user),
    isAdmin: req.admin,
    canAdmin: req.canAdmin,
    unread: req.admin ? await db.totalUnreadAdmin() : await db.unread(req.user.id, 'client'),
  });

  api.get('/me', async (req, res) => res.json(await me(req)));

  // Переключение админа между режимом админа и клиента
  api.post('/mode', async (req, res) => {
    if (!req.canAdmin) throw fail(403, 'Нет доступа');
    const mode = req.body?.mode === 'client' ? 'client' : 'admin';
    await db.setMode(req.user.id, mode);
    req.admin = mode === 'admin';
    res.json(await me(req));
  });

  // Опрос чата. v — версия чата у клиента: если не изменилась, отвечаем сразу.
  api.get('/chat', async (req, res) => {
    const userId = await threadOf(req, req.query.user);
    const side = req.admin ? 'admin' : 'client';
    const v = await db.touch(userId, side);
    if (req.query.v !== undefined && Number(req.query.v) === v) return res.json({ v, same: true });

    const [messages, orders, peer] = await Promise.all([
      db.messages(userId, Number(req.query.after) || 0),
      db.ordersOf(userId),
      req.admin ? db.getUser(userId) : null,
      db.markRead(userId, side),
    ]);
    res.json({ v, messages, orders: orders.map(publicOrder), peer: publicUser(peer) });
  });

  api.post('/chat', async (req, res) => {
    const userId = await threadOf(req, req.body?.user);
    const text = String(req.body?.text ?? '').trim();
    if (text.length > MAX_TEXT) throw fail(400, 'Слишком длинное сообщение');
    if (!text && !req.body?.image) throw fail(400, 'Пустое сообщение');
    if (!(await db.hit('msg', req.user.id, 30, 60))) throw fail(429, 'Слишком часто, подожди немного');

    let image = null;
    if (req.body?.image) {
      const { buffer, ext } = decodeImage(String(req.body.image));
      image = await media.save(buffer, ext);
    }
    const message = req.admin
      ? await chat.fromAdmin(userId, { text, image })
      : await chat.fromClient(req.user, { text, image });
    res.json({ message });
  });

  api.post('/orders', async (req, res) => {
    let order;
    try {
      order = buildOrder(req.body?.items, req.body?.comment);
    } catch (err) {
      throw fail(400, err.message);
    }
    if (!(await db.hit('order', req.user.id, 5, 600))) throw fail(429, 'Слишком много заказов, подожди немного');
    res.json({ order: publicOrder(await chat.placeOrder(req.user, order)) });
  });

  api.get('/admin/threads', adminOnly, async (req, res) => {
    const threads = await db.threads();
    res.json({
      threads: threads.map((t) => ({
        user: publicUser(t.user),
        last: t.last,
        unread: t.unread,
        updatedAt: t.updatedAt,
        order: t.order && { ...t.order, statusLabel: STATUS[t.order.status] },
      })),
    });
  });

  api.post('/admin/orders/:id', adminOnly, async (req, res) => {
    const order = await chat.setStatus(Number(req.params.id), String(req.body?.status));
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
