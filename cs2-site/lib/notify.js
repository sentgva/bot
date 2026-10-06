// Уведомления админу в Telegram: новые выводы, заявки на продажу, ошибки провайдеров.
// Нужны TG_BOT_TOKEN (бот от @BotFather) и TG_ADMIN_CHAT_ID (id чата/группы админов).
// Ошибка отправки не ломает основную операцию.

import { config } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export async function notifyAdmin(lines) {
  if (!config.tgBotToken || !config.tgAdminChatId) return false;
  const text = lines.filter(Boolean).map(esc).join('\n') + `\n\n<a href="${config.siteUrl}/admin/">Открыть админку</a>`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.tgAdminChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch (err) {
    console.error('notifyAdmin:', err.message);
    return false;
  }
}

export const rub = (kop) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
