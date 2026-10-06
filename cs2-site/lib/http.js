// Минимальный HTTP-слой без фреймворка: роутер, разбор тела, cookies, ответы, ограничение частоты.

import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';

// Ошибка, которую можно показать пользователю
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function createRouter() {
  const routes = [];
  const add = (method) => (path, handler) => {
    // '/api/items/:id' → регулярка с именованными группами
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$');
    routes.push({ method, re, handler });
  };
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'),
    match(method, pathname) {
      for (const r of routes) {
        const m = pathname.match(r.re);
        if (m && r.method === method) return { handler: r.handler, params: m.groups || {} };
      }
      return routes.some((r) => r.re.test(pathname)) ? 'method' : null;
    },
  };
}

export async function readBody(req, limit = 64 * 1024) {
  // На Vercel тело может быть уже прочитано
  if (req.rawBody !== undefined) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  req.rawBody = Buffer.concat(chunks).toString('utf8');
  return req.rawBody;
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    fail(400, 'Некорректный JSON');
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const secure = config.siteUrl.startsWith('https://');
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// Хэш IP: для лимитов храним не сам адрес
export const ipKey = (req) => crypto.createHash('sha256').update(clientIp(req) + config.sessionSecret).digest('hex').slice(0, 24);

// Защита от CSRF: изменяющие запросы принимаем только со своего сайта
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    // Браузеры шлют Origin на POST; без него требуем наш заголовок (его нельзя выставить кросс-доменно без CORS)
    if (req.headers['x-requested-with'] !== 'luxedrop') fail(403, 'Запрос отклонён');
    return;
  }
  const own = new URL(config.siteUrl).origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const allowed = [own, `https://${host}`, `http://${host}`];
  if (!allowed.includes(origin)) fail(403, 'Запрос отклонён');
}

// Не больше limit запросов за windowSec секунд на ключ
export async function rateLimit(key, limit, windowSec) {
  const db = await getDb();
  const window = Math.floor(Date.now() / 1000 / windowSec);
  const row = await db.one(
    `insert into rate_limits(key, window_start, hits) values ($1, $2, 1)
     on conflict (key, window_start) do update set hits = rate_limits.hits + 1
     returning hits`,
    [key, window],
  );
  // Изредка чистим старые окна
  if (Math.random() < 0.01) await db.query('delete from rate_limits where window_start < $1', [window - 1000]).catch(() => {});
  if (row.hits > limit) fail(429, 'Слишком часто. Подожди немного и попробуй снова');
}

// Числа и строки из запроса
export const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : NaN);
export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
