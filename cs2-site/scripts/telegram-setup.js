// Настройка бота LuxeDrop: вебхук, кнопка меню «LuxeDrop» (открывает главную), команды.
// Запускается при продакшен-сборке на Vercel (buildCommand) или вручную: npm run telegram
// Нужны TG_BOT_TOKEN и SITE_URL (https).
import { config } from '../lib/config.js';
import { tgApi, webAppUrl, webhookSecret } from '../lib/telegram.js';

const manual = process.argv.includes('--force');
if (!config.tgBotToken) { console.log('TG_BOT_TOKEN не задан — настройка бота пропущена'); process.exit(0); }
if (!manual && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') { console.log('Не продакшен — бота не трогаем'); process.exit(0); }
if (!config.siteUrl.startsWith('https://')) { console.log('SITE_URL должен быть https:// — Telegram открывает Mini App только по https'); process.exit(0); }

try {
  await tgApi('setWebhook', { url: `${config.siteUrl}/api/telegram/webhook`, secret_token: webhookSecret(), allowed_updates: ['message', 'pre_checkout_query', 'callback_query'], drop_pending_updates: true }); // pre_checkout_query — оплата звёздами, callback_query — кнопки рассылки
  await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'LuxeDrop', web_app: { url: webAppUrl() } } });
  await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть LuxeDrop' }, { command: 'support', description: 'Написать в поддержку' }] });
  // Владельцам — ещё команды рассылки и поддержки (видны только им)
  for (const id of config.adminTgIds) {
    await tgApi('setMyCommands', {
      scope: { type: 'chat', chat_id: Number(id) },
      commands: [
        { command: 'news', description: 'Разослать новость всем' }, { command: 'tickets', description: 'Открытые обращения' },
        { command: 'start', description: 'Открыть LuxeDrop' }, { command: 'cancel', description: 'Отменить ввод новости' },
      ],
    }).catch((err) => console.warn(`Команды для ${id}: ${err.message}`));
  }
  await tgApi('setMyDescription', { description: 'Апгрейд скинов CS2 прямо в Telegram: ставь немного — выигрывай много. Кейсы CS2, апгрейд до 80%, пополнение звёздами, вывод на карту и по СБП.' });
  console.log(`Бот настроен: Mini App → ${webAppUrl()}`);
} catch (err) {
  // Ошибка настройки бота не должна ломать деплой сайта
  console.warn('Настройка бота не удалась:', err.message);
}
