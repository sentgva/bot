import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { config, isAdmin } from './config.js';
import { createChat } from './chat.js';
import { STATUS } from './orders.js';

const COVER = path.resolve(import.meta.dirname, '../webapp/assets/cover.jpg');
const MAX_TEXT = 3500;

export function createBot(db) {
  const bot = new Bot(config.botToken);
  const chat = createChat(db, bot.api);
  let coverFileId = null;

  // Только личные сообщения
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.from && !ctx.from.is_bot) db.upsertUser(ctx.from);
    await next();
  });

  bot.command('start', async (ctx) => {
    const admin = isAdmin(ctx.from.id);
    const caption = admin
      ? '<b>SOVSIDE</b> · режим админа\n\n' +
        'Сообщения и заказы клиентов приходят сюда. Ответь реплаем, и ответ уйдёт клиенту. ' +
        'Все переписки и статусы заказов в приложении.'
      : '<b>SOVSIDE</b> · моды для GTA5RP и Majestic RP\n\n' +
        'Ганпаки, одежда, редуксы. В приложении прайс, заказ и личный чат со мной.';
    const extra = {
      caption: config.webAppUrl ? caption : `${caption}\n\n<i>Приложение ещё не подключено.</i>`,
      parse_mode: 'HTML',
      reply_markup: chat.appButton('Открыть SOVSIDE'),
    };
    const sent = await ctx.replyWithPhoto(coverFileId || new InputFile(COVER), extra);
    coverFileId ??= sent.photo?.at(-1)?.file_id ?? null;
  });

  bot.command('id', (ctx) => ctx.reply(`Твой ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  bot.callbackQuery(/^st:(\d+):(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    try {
      const order = chat.setStatus(Number(ctx.match[1]), ctx.match[2]);
      await ctx.answerCallbackQuery({ text: `Заказ #${order.id}: ${STATUS[order.status]}` });
      await ctx
        .editMessageText(chat.orderHtml(order), { parse_mode: 'HTML', reply_markup: chat.orderKeyboard(order) })
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
    if (isAdmin(ctx.from.id)) {
      const reply = msg.reply_to_message;
      clientId = reply && db.getRelay(ctx.chat.id, reply.message_id);
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
      chat.fromAdmin(clientId, { text, image, fileId });
      db.markRead(clientId, 'admin');
    } else {
      chat.fromClient(db.getUser(ctx.from.id), { text, image, fileId });
    }
    await ctx.react('👌').catch(() => {});
  });

  bot.on('message', (ctx) => ctx.reply('Сюда можно отправить текст или фото.'));

  bot.catch(({ error, ctx }) => {
    console.error(`Ошибка в апдейте ${ctx.update.update_id}:`, error);
  });

  return { bot, chat };
}

export async function setupBot(bot) {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть SOVSIDE' },
    { command: 'id', description: 'Мой Telegram ID' },
  ]);
  if (!config.webAppUrl) return;
  await bot.api.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'SOVSIDE', web_app: { url: `${config.webAppUrl}/` } },
  });
}
