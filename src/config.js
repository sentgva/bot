import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

if (!env.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Скопируй .env.example в .env и впиши токен от @BotFather.');
  process.exit(1);
}

export const config = {
  botToken: env.BOT_TOKEN.trim(),
  adminIds: (env.ADMIN_ID || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isSafeInteger)
    .filter((n) => n > 0),
  webAppUrl: (env.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  telegramLink: (env.TELEGRAM_LINK || '').trim(),
  completedOrdersBase: Math.max(0, Number(env.COMPLETED_ORDERS_BASE) || 0),
};

export const isAdmin = (id) => config.adminIds.includes(Number(id));
