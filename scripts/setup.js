// Настраивает бота под текущий адрес приложения: команды, кнопку меню и вебхук.
// На Vercel запускается сам при каждом продакшн-деплое (buildCommand в vercel.json).
// Вручную: node scripts/setup.js [--webhook]

const onVercelBuild = Boolean(process.env.VERCEL);
if (onVercelBuild && process.env.VERCEL_ENV !== 'production') {
  console.log('Превью-деплой: бота не трогаем.');
  process.exit(0);
}

try {
  const { Api } = await import('grammy');
  const { config } = await import('../src/config.js');
  const { setupBot } = await import('../src/bot.js');

  const webhook = onVercelBuild || process.argv.includes('--webhook');
  const api = new Api(config.botToken);
  await setupBot(api, { webhook });
  const me = await api.getMe();
  console.log(`@${me.username} настроен: ${config.webAppUrl || 'без WEBAPP_URL'}${webhook ? ', вебхук включён' : ''}`);
  if (!config.adminIds.length) console.log(`Стать админом (сработает один раз): https://t.me/${me.username}?start=${config.adminClaim}`);
} catch (err) {
  // Деплой не валим: сайт должен выйти в любом случае
  console.warn('Не удалось настроить бота:', err.description || err.message);
}
