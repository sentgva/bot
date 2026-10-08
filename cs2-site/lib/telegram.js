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
// Приветствие: открыть приложение + поддержка (кнопка «Поддержка» обрабатывается в lib/app.js, callback_data = support)
const welcomeKeyboard = (ref) => ({ inline_keyboard: [...openButton(undefined, ref).inline_keyboard, [{ text: '💬 Поддержка', callback_data: 'support' }]] });

export const SUPPORT_TEXT = '💬 Поддержка LuxeDrop\n\nНапиши вопрос сюда — можно текстом, фото, видео, кружком или голосовым. Передадим админам, ответ придёт в этот чат.';
export const welcomeImageUrl = () => `${config.siteUrl}/assets/img/bot-welcome.jpg`;
const escHtml = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function welcomeCaption(firstName, bonusLc = 1000) {
  return [
    `Привет, ${escHtml(firstName || 'игрок')}! 👋 Это <b>LuxeDrop</b> — кейсы и апгрейд скинов CS2 прямо в Telegram.`,
    '',
    bonusLc > 0 ? `🎁 <b>${bonusLc.toLocaleString('ru-RU')} LC</b> на баланс при первом входе` : null,
    '📦 35 кейсов: настоящие кейсы CS2, наклейки и наши',
    '🎯 Апгрейд на любой скин — шанс до 80%',
    '',
    'Жми кнопку ниже и открывай первый кейс 👇',
  ].filter((l) => l !== null).join('\n');
}

// Обработка входящего сообщения боту: на /start — баннер с приветствием и кнопками, на прочие команды — кнопка приложения
export async function handleUpdate(update, fetchImpl = fetch, { bonusLc = 1000 } = {}) {
  const msg = update?.message;
  if (!msg?.chat || msg.chat.type !== 'private') return { skipped: true };
  const isStart = typeof msg.text === 'string' && msg.text.startsWith('/start');
  const ref = isStart ? (msg.text.split(/\s+/)[1] || '').match(/^[0-9A-Za-z]{2,12}$/)?.[0] || null : null;
  if (isStart) {
    const caption = welcomeCaption(msg.from?.first_name, bonusLc);
    try {
      await tgApi('sendPhoto', { chat_id: msg.chat.id, photo: welcomeImageUrl(), caption, parse_mode: 'HTML', reply_markup: welcomeKeyboard(ref) }, fetchImpl);
    } catch {
      // Картинка недоступна — то же приветствие текстом
      await tgApi('sendMessage', { chat_id: msg.chat.id, text: caption, parse_mode: 'HTML', reply_markup: welcomeKeyboard(ref) }, fetchImpl);
    }
    return { ok: true };
  }
  await tgApi('sendMessage', {
    chat_id: msg.chat.id,
    text: 'LuxeDrop открывается кнопкой ниже 👇\nЕсть вопрос? Просто напиши его сюда — ответит поддержка.',
    reply_markup: welcomeKeyboard(null),
  }, fetchImpl);
  return { ok: true };
}
