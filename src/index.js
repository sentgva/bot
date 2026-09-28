import { config } from './config.js';
import { openDb } from './db.js';
import { createBot, setupBot } from './bot.js';
import { createServer } from './server.js';

const db = openDb(config.dataDir);
const { bot, chat } = createBot(db);
const server = createServer(db, chat).listen(config.port, () => {
  console.log(`Mini App: http://localhost:${config.port}`);
});

try {
  await bot.init();
} catch (err) {
  console.error('Не удалось подключиться к Telegram. Проверь BOT_TOKEN в .env:', err.description || err.message);
  process.exit(1);
}
config.botUsername = bot.botInfo.username;
console.log(`Бот: @${bot.botInfo.username}`);

if (!config.adminIds.length) {
  console.warn('ADMIN_ID не задан: напиши боту /id и впиши это число в .env, иначе сообщения клиентов некому получать.');
}
if (!config.webAppUrl) {
  console.warn('WEBAPP_URL не задан: кнопка приложения в боте не появится (нужен https-адрес).');
}
await setupBot(bot).catch((err) => console.warn('Не удалось настроить меню бота:', err.description || err.message));

bot.start({ allowed_updates: ['message', 'callback_query'] }).catch((err) => {
  // 409: этот же бот уже запущен где-то ещё
  console.error('Бот остановился:', err.description || err.message);
  process.exit(1);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await bot.stop().catch(() => {});
  server.close();
  db.flush();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
