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

export function startSession(res, userId) {
  setCookie(res, COOKIE, encodeSession({ uid: userId, exp: Date.now() + MAX_AGE * 1000 }), { maxAge: MAX_AGE });
}

export function endSession(res) {
  setCookie(res, COOKIE, '', { maxAge: 0 });
}

export function sessionUserId(req) {
  return decodeSession(parseCookies(req)[COOKIE])?.uid ?? null;
}
