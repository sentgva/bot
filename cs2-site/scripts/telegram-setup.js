// Настройка бота LuxeDrop для Mini App апгрейдера: вебхук, кнопка меню «Апгрейд», команды.
// Запускается при продакшен-сборке на Vercel (buildCommand) или вручную: npm run telegram
// Нужны TG_BOT_TOKEN и SITE_URL (https).
import { config } from '../lib/config.js';
import { tgApi, webAppUrl, webhookSecret } from '../lib/telegram.js';

const manual = process.argv.includes('--force');
if (!config.tgBotToken) { console.log('TG_BOT_TOKEN не задан — настройка бота пропущена'); process.exit(0); }
if (!manual && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') { console.log('Не продакшен — бота не трогаем'); process.exit(0); }
if (!config.siteUrl.startsWith('https://')) { console.log('SITE_URL должен быть https:// — Telegram открывает Mini App только по https'); process.exit(0); }

try {
  await tgApi('setWebhook', { url: `${config.siteUrl}/api/telegram/webhook`, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: true });
  await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Апгрейд', web_app: { url: webAppUrl() } } });
  await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть апгрейдер LuxeDrop' }] });
  await tgApi('setMyDescription', { description: 'Апгрейд скинов CS2 прямо в Telegram: шанс до 80% с проверкой каждого броска, вывод в USDT за 2 минуты и на карту.' });
  console.log(`Бот настроен: Mini App → ${webAppUrl()}`);
} catch (err) {
  // Ошибка настройки бота не должна ломать деплой сайта
  console.warn('Настройка бота не удалась:', err.message);
}
