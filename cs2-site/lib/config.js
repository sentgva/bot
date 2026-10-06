// Конфигурация из переменных окружения. Всё, что можно менять без редеплоя, лежит в settings.js.

const env = process.env;
const bool = (v) => v === '1' || v === 'true';

export const isProd = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';

export const config = {
  siteUrl: (env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || '',

  // Подпись cookie сессии. В продакшене обязательна, иначе сессии можно подделать.
  sessionSecret: env.SESSION_SECRET || (isProd ? '' : 'dev-secret-change-me'),
  // Ключ шифрования номеров карт (32 байта в hex). Без него вывод на карту выключен.
  dataKey: env.DATA_KEY || '',

  steamApiKey: env.STEAM_API_KEY || '',
  adminSteamIds: (env.ADMIN_STEAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Crypto Pay (@CryptoBot): пополнение и вывод в USDT/TON
  cryptoPayToken: env.CRYPTOPAY_TOKEN || '',
  cryptoPayTestnet: bool(env.CRYPTOPAY_TESTNET),

  // market.csgo.com: покупка скина и отправка игроку на трейд-ссылку
  marketApiKey: env.MARKET_API_KEY || '',

  // Уведомления админу в Telegram
  tgBotToken: env.TG_BOT_TOKEN || '',
  tgAdminChatId: env.TG_ADMIN_CHAT_ID || '',

  // Цены: валюта Skinport и курс, если валюта не рубли
  priceCurrency: env.PRICE_CURRENCY || 'RUB',
  usdRubRate: Number(env.USD_RUB_RATE || 0),
  priceTtlMinutes: Number(env.PRICE_TTL_MINUTES || 60),

  cronSecret: env.CRON_SECRET || '',

  // Тестовое пополнение кнопкой (для стенда). В бою — выключить!
  demoTopup: bool(env.DEMO_TOPUP),
  // Вход без Steam для локальной разработки (/api/auth/dev). В продакшене не работает никогда.
  devLogin: !isProd && bool(env.DEV_LOGIN),
};

export function assertConfig() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET не задан');
}
