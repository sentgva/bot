// Вход через Telegram Login (oauth.telegram.org).
//   1. Кнопка ведёт на oauth.telegram.org с ID бота и адресом возврата (эта же страница).
//   2. Telegram спрашивает подтверждение и возвращает на страницу с #tgAuthResult=<base64 JSON>.
//   3. Отправляем данные на сервер, он проверяет подпись ключом бота и ставит сессию.
// В BotFather у бота должен быть указан домен сайта: /setdomain.
import { $, api, session, toastError } from './core.js';

const params = new URLSearchParams(location.search);
const next = /^\/(?!\/)/.test(params.get('next') || '') ? params.get('next') : '/profile/';
const text = $('[data-login-text]');

function decodeResult(hash) {
  const m = hash.match(/tgAuthResult=([^&]+)/);
  if (!m) return undefined;
  try {
    let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    return JSON.parse(json) || null;
  } catch {
    return null;
  }
}

async function finish(data) {
  text.textContent = 'Проверяем вход…';
  try {
    await api('/api/auth/telegram-widget', { method: 'POST', body: { data } });
    location.replace(next);
  } catch (err) {
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]auto=1/, ''));
    text.textContent = err.message;
    toastError(err);
    showButtons();
  }
}

let cfg = null;
function oauthUrl() {
  const back = `${location.origin}/login/?next=${encodeURIComponent(next)}`;
  const q = new URLSearchParams({ bot_id: cfg.telegramBotId, origin: location.origin, request_access: 'write', return_to: back });
  return `https://oauth.telegram.org/auth?${q}`;
}

function showButtons() {
  const go = $('[data-login-go]');
  if (cfg?.telegramBotId) {
    go.href = oauthUrl();
  } else {
    go.hidden = true;
    text.textContent = 'Вход через Telegram пока не настроен: укажи TG_BOT_TOKEN на сервере.';
  }
  if (cfg?.botUsername) {
    const bot = $('[data-login-bot]');
    bot.href = `https://t.me/${cfg.botUsername}`;
    bot.hidden = false;
  }
  if (cfg?.devLogin) {
    const dev = $('[data-login-dev]');
    dev.href = `/api/auth/dev?next=${encodeURIComponent(next)}`;
    dev.hidden = false;
  }
}

const s = await session();
if (s.user) {
  location.replace(next);
} else {
  cfg = s.config?.auth || null;
  const result = decodeResult(location.hash);
  if (result) {
    finish(result);
  } else {
    if (result === null) text.textContent = 'Вход отменён или не удался. Попробуй ещё раз.';
    showButtons();
    // Пришли с кнопки «Войти» — сразу отправляем в Telegram, без лишнего клика
    if (params.get('auto') === '1' && result === undefined && cfg?.telegramBotId) location.href = oauthUrl();
  }
}
