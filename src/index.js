// Локальный запуск или VPS: сервер + бот, который сам опрашивает Telegram
import { config } from './config.js';
import { createApp } from './app.js';
import { setupBot } from './bot.js';

const { server, bot, db, store } = createApp({ webhook: false });
const http = server.listen(config.port, () => console.log(`Mini App: http://localhost:${config.port}`));

try {
  await bot.init();
} catch (err) {
  console.error('Не удалось подключиться к Telegram. Проверь BOT_TOKEN в .env:', err.description || err.message);
  process.exit(1);
}
config.botUsername = bot.botInfo.username;
console.log(`Бот: @${bot.botInfo.username} · хранилище: ${store.kind}`);

// Если бот уже работает на Vercel через вебхук, опрос его бы сломал
const hook = await bot.api.getWebhookInfo();
if (hook.url && process.env.FORCE_POLLING !== '1') {
  console.error(`Бот уже работает через вебхук: ${hook.url}\nЛокальный запуск отключит его. Если это нужно, запусти с FORCE_POLLING=1.`);
  process.exit(1);
}

if (!(await db.adminIds()).size) {
  console.warn(`Админ не назначен. Открой ссылку и нажми «Start»: https://t.me/${bot.botInfo.username}?start=${config.adminClaim}`);
}
if (!config.webAppUrl) console.warn('WEBAPP_URL не задан: кнопка приложения в боте не появится (нужен https-адрес).');
await setupBot(bot.api, { webhook: false }).catch((err) => console.warn('Не удалось настроить меню бота:', err.description || err.message));

bot.start({ allowed_updates: ['message', 'callback_query'] }).catch((err) => {
  console.error('Бот остановился:', err.description || err.message);
  process.exit(1);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await bot.stop().catch(() => {});
  http.close();
  store.flush?.();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
