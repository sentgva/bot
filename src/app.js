import path from 'node:path';
import { config } from './config.js';
import { openStore } from './store.js';
import { openDb } from './db.js';
import { openMedia } from './media.js';
import { createChat } from './chat.js';
import { Bot } from 'grammy';
import { registerBot } from './bot.js';
import { createServer } from './server.js';
import { createAvatars } from './avatars.js';

// Собирает всё приложение. webhook: true — для Vercel, false — локально с опросом Telegram.
export function createApp({ webhook }) {
  const store = openStore({
    postgresUrl: config.postgresUrl,
    redisUrl: config.redisUrl,
    redisToken: config.redisToken,
    file: path.join(config.dataDir, 'db.json'),
  });
  const db = openDb(store);
  const media = openMedia({ blobToken: config.blobToken, dataDir: config.dataDir });

  const bot = new Bot(config.botToken);
  const chat = createChat(db, bot.api, media);
  const avatars = createAvatars(db, bot.api, (fileId) => chat.downloadPhoto(fileId));
  registerBot(bot, db, chat, avatars);

  const server = createServer({ db, chat, bot, media, avatars, webhook, serveStatic: !config.onVercel });
  return { server, bot, db, store, chat };
}
