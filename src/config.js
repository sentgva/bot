import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

if (!env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN не задан. Локально: скопируй .env.example в .env. На Vercel: Settings → Environment Variables.');
}

const token = env.BOT_TOKEN.trim();
const secret = (purpose, length) => crypto.createHash('sha256').update(`${token}:${purpose}`).digest('hex').slice(0, length);
const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

export const config = {
  botToken: token,
  adminIds: (env.ADMIN_ID || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0),
  webAppUrl: (env.WEBAPP_URL || vercelUrl).trim().replace(/\/+$/, ''),
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  telegramLink: (env.TELEGRAM_LINK || '').trim(),
  completedOrdersBase: Math.max(0, Number(env.COMPLETED_ORDERS_BASE) || 0),

  // Vercel: база Neon Postgres или Upstash Redis (подключаются в Storage), фото в Vercel Blob
  onVercel: Boolean(env.VERCEL),
  postgresUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  redisUrl: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '',
  redisToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '',
  blobToken: env.BLOB_READ_WRITE_TOKEN || '',

  // Секреты выводятся из токена, отдельно их задавать не нужно
  webhookSecret: secret('webhook', 48),
  adminClaim: `admin-${secret('admin', 24)}`,

  botUsername: '',
};

if (config.onVercel && !config.postgresUrl && !config.redisUrl) {
  throw new Error('На Vercel нужна база: Storage → Neon (Postgres) или Upstash (Redis) → Connect to project.');
}
