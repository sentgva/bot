// Telegram: Mini App LuxeDrop (открывается на главной).
//   • Проверка initData — подписанных Telegram данных об игроке, которые Mini App получает при запуске.
//     Подделать их без токена бота нельзя: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   • Вебхук бота: на /start отвечаем кнопкой «Открыть апгрейдер».
//   • Настройка бота (вебхук, кнопка меню, команды) — scripts/telegram-setup.js.

import crypto from 'node:crypto';
import { config } from './config.js';

export const MAX_AGE_SEC = 24 * 3600; // initData старше суток не принимаем

export const webAppUrl = () => `${config.siteUrl}/`;

// Секрет вебхука выводим из токена: отдельная переменная не нужна, а подделать запрос без токена нельзя
export const webhookSecret = () => crypto.createHash('sha256').update(`webhook:${config.tgBotToken}`).digest('hex').slice(0, 48);

// Возвращает пользователя Telegram ({ id, first_name, username, photo_url, … }) или null
export function verifyInitData(initData, botToken = config.tgBotToken, { now = Date.now(), maxAge = MAX_AGE_SEC } = {}) {
  if (!botToken || typeof initData !== 'string' || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const checkString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAge) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

// Для тестов и локальной разработки: подписать initData так же, как это делает Telegram
export function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE-test', user: JSON.stringify(user) });
  const checkString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}

// Вход на сайте через Telegram Login (oauth.telegram.org). Данные подписаны ключом SHA-256(токен бота):
// https://core.telegram.org/widgets/login#checking-authorization
export function verifyLoginWidget(data, botToken = config.tgBotToken, { now = Date.now(), maxAge = MAX_AGE_SEC } = {}) {
  if (!botToken || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { hash, ...fields } = data;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const keys = Object.keys(fields).filter((k) => ['string', 'number'].includes(typeof fields[k]));
  if (keys.length > 20) return null;
  const checkString = keys.sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
  const authDate = Number(fields.auth_date);
  if (!authDate || now / 1000 - authDate > maxAge) return null;
  const id = Number(fields.id);
  if (!Number.isSafeInteger(id)) return null;
  return { id, first_name: fields.first_name, last_name: fields.last_name, username: fields.username, photo_url: fields.photo_url };
}

// Для тестов: подписать данные так же, как Telegram Login
export function signLoginWidget(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { ...user, auth_date: authDate };
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  return { ...fields, hash: crypto.createHmac('sha256', secret).update(checkString).digest('hex') };
}

// ID бота — часть токена до двоеточия; нужен странице входа (он не секретный)
export const botId = () => (config.tgBotToken.includes(':') ? config.tgBotToken.split(':')[0] : null);

export async function tgApi(method, body, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${config.tgBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// ref — код пригласившего из /start КОД: передаём его на сайт, чтобы засчитать приглашение при первом входе
const openButton = (text = '🎯 Открыть LuxeDrop', ref = null) => ({
  inline_keyboard: [[{ text, web_app: { url: ref ? `${webAppUrl()}?ref=${encodeURIComponent(ref)}` : webAppUrl() } }]],
});

// Обработка входящего сообщения боту. Отвечаем на любое сообщение в личке кнопкой Mini App.
export async function handleUpdate(update, fetchImpl = fetch) {
  const msg = update?.message;
  if (!msg?.chat || msg.chat.type !== 'private') return { skipped: true };
  const isStart = typeof msg.text === 'string' && msg.text.startsWith('/start');
  const text = isStart
    ? `Привет, ${msg.from?.first_name || 'игрок'}! Это LuxeDrop — апгрейд скинов CS2.\n\n`
      + '• Ставь немного — выигрывай много: шанс до 80%\n• Пополнение звёздами ⭐ — баланс в LuxeCoin (1 LC = 1 ₽)\n• Вывод в USDT за 2 минуты, на карту — в среднем за 15\n\nЖми кнопку ниже — LuxeDrop откроется прямо в Telegram.\n\nЕсть вопрос? Просто напиши его сюда — ответит поддержка.'
    : 'LuxeDrop открывается кнопкой ниже 👇\nЕсть вопрос? Просто напиши его сюда — ответит поддержка.';
  const ref = isStart ? (msg.text.split(/\s+/)[1] || '').match(/^[0-9A-Za-z]{2,12}$/)?.[0] || null : null;
  await tgApi('sendMessage', { chat_id: msg.chat.id, text, reply_markup: openButton(undefined, ref) }, fetchImpl);
  return { ok: true };
}
