import path from 'node:path';
import { InputFile } from 'grammy';
import { config } from './config.js';
import { STATUS } from './orders.js';
import { registerNews } from './news.js';

const COVER = path.resolve(import.meta.dirname, '../webapp/assets/cover.jpg');
const MAX_TEXT = 3500;

const CLIENT_COMMANDS = [
  { command: 'start', description: 'Открыть SOVSIDE' },
  { command: 'id', description: 'Мой Telegram ID' },
];
const ADMIN_COMMANDS = [
  { command: 'start', description: 'Открыть SOVSIDE' },
  { command: 'news', description: 'Рассылка всем клиентам' },
  { command: 'cancel', description: 'Отменить рассылку' },
  { command: 'id', description: 'Мой Telegram ID' },
];

// У админа в меню свои команды (с /news), у клиентов — обычные
export const setAdminCommands = (api, chatId) =>
  api.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: chatId } });

export function registerBot(bot, db, chat) {
  let coverFileId = null;

  // Только личные сообщения
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.from && !ctx.from.is_bot) await db.upsertUser(ctx.from);
    await next();
  });

  bot.command('start', async (ctx) => {
    // Секретная ссылка t.me/<бот>?start=admin-… делает первого открывшего админом
    if (ctx.match === config.adminClaim) {
      const admins = await db.adminIds();
      if (admins.has(ctx.from.id)) return ctx.reply('Ты уже админ.');
      if (admins.size) return ctx.reply('Админ уже назначен. Чтобы добавить ещё одного, впиши его ID в ADMIN_ID.');
      await db.addAdmin(ctx.from.id);
      await setAdminCommands(ctx.api, ctx.from.id).catch(() => {});
      return ctx.reply('Готово, теперь ты админ. Сообщения и заказы клиентов будут приходить сюда. Нажми /start.');
    }

    const admin = await db.isAdmin(ctx.from.id);
    const caption = admin
      ? '<b>SOVSIDE</b> · режим админа\n\n' +
        'Сообщения и заказы клиентов приходят сюда. Ответь реплаем, и ответ уйдёт клиенту. ' +
        'Все переписки и статусы заказов в приложении.\n\n' +
        'Рассылка всем клиентам: /news'
      : '<b>SOVSIDE</b> · моды для GTA5RP и Majestic RP\n\n' +
        'Ганпаки, одежда, редуксы. В приложении прайс, заказ и чат со мной.';
    const cover = coverFileId || (config.webAppUrl ? `${config.webAppUrl}/assets/cover.jpg` : new InputFile(COVER));
    const sent = await ctx.replyWithPhoto(cover, {
      caption: config.webAppUrl ? caption : `${caption}\n\n<i>Приложение ещё не подключено.</i>`,
      parse_mode: 'HTML',
      reply_markup: chat.appButton('Открыть SOVSIDE'),
    });
    coverFileId ??= sent.photo?.at(-1)?.file_id ?? null;
  });

  bot.command('id', (ctx) => ctx.reply(`Твой ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  registerNews(bot, db);

  bot.callbackQuery(/^st:(\d+):(\w+)$/, async (ctx) => {
    if (!(await db.isAdmin(ctx.from.id))) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    try {
      const order = await chat.setStatus(Number(ctx.match[1]), ctx.match[2]);
      await ctx.answerCallbackQuery({ text: `Заказ #${order.id}: ${STATUS[order.status]}` });
      await ctx
        .editMessageText(await chat.orderHtml(order), { parse_mode: 'HTML', reply_markup: chat.orderKeyboard(order) })
        .catch(() => {});
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err.message });
    }
  });

  bot.on(['message:text', 'message:photo'], async (ctx) => {
    const msg = ctx.message;
    if (msg.text?.startsWith('/')) return ctx.reply('Такой команды нет. Жми /start');

    // Админ отвечает клиенту реплаем на пересланное ботом сообщение
    let clientId = null;
    if (await db.isAdmin(ctx.from.id)) {
      const reply = msg.reply_to_message;
      clientId = reply && (await db.getRelay(ctx.chat.id, reply.message_id));
      if (!clientId) {
        return ctx.reply('Чтобы ответить клиенту, ответь реплаем на его сообщение. Или открой приложение.', {
          reply_markup: chat.appButton('Все чаты', '?tab=chat'),
        });
      }
    }

    let text = (msg.text ?? msg.caption ?? '').trim().slice(0, MAX_TEXT);
    const fileId = msg.photo?.at(-1)?.file_id ?? null;
    const image = fileId ? await chat.downloadPhoto(fileId).catch(() => null) : null;
    if (fileId && !image && !text) text = 'Фото (открой в боте)';
    if (!text && !image) return;

    if (clientId) {
      await chat.fromAdmin(clientId, { text, image, fileId });
      await db.markRead(clientId, 'admin');
    } else {
      await chat.fromClient(await db.getUser(ctx.from.id), { text, image, fileId });
    }
    await ctx.react('👌').catch(() => {});
  });

  bot.on('message', (ctx) => ctx.reply('Сюда можно отправить текст или фото.'));

  bot.catch(({ error, ctx }) => {
    console.error(`Ошибка в апдейте ${ctx.update.update_id}:`, error);
  });

  return bot;
}

// Кнопка меню, команды и (на Vercel) вебхук. Вызывается при деплое и локальном запуске.
export async function setupBot(api, { webhook }) {
  await api.setMyCommands(CLIENT_COMMANDS);
  for (const adminId of config.adminIds) {
    // не упадём, если админ ещё не запускал бота
    await setAdminCommands(api, adminId).catch((err) => console.warn(`Команды для ${adminId}:`, err.description || err.message));
  }
  if (!config.webAppUrl) return;
  await api.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'SOVSIDE', web_app: { url: `${config.webAppUrl}/` } },
  });
  if (webhook) {
    await api.setWebhook(`${config.webAppUrl}/api/telegram`, {
      secret_token: config.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
    });
  }
}
