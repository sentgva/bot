// Сессия в подписанной cookie: base64url(JSON) + "." + HMAC-SHA256.
// Сервер ничего не хранит; подделать cookie без SESSION_SECRET нельзя.

import crypto from 'node:crypto';
import { config, assertConfig } from './config.js';
import { parseCookies, setCookie } from './http.js';

const COOKIE = 'ld_sess';
const MAX_AGE = 30 * 24 * 3600; // 30 дней

const sign = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

export function encodeSession(payload) {
  assertConfig();
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function decodeSession(token) {
  if (!token || !config.sessionSecret) return null;
  const [data, mac] = token.split('.');
  if (!data || !mac) return null;
  const expected = sign(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// Возвращает токен: его же Mini App передаёт в заголовке Authorization
export function startSession(res, userId) {
  const token = encodeSession({ uid: userId, exp: Date.now() + MAX_AGE * 1000 });
  setCookie(res, COOKIE, token, { maxAge: MAX_AGE });
  return token;
}

export function endSession(res) {
  setCookie(res, COOKIE, '', { maxAge: 0 });
}

// Сессия из cookie (сайт) или из заголовка Authorization: Bearer … (Telegram Mini App:
// в Telegram Web приложение открывается во фрейме, и браузер не отдаёт туда cookie).
// Заголовок не подставляется браузером сам, поэтому CSRF через него невозможен.
export function sessionUserId(req) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  return decodeSession(bearer || parseCookies(req)[COOKIE])?.uid ?? null;
}
