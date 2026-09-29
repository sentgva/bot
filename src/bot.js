import path from 'node:path';
import { InputFile } from 'grammy';
import { config } from './config.js';
import { STATUS } from './orders.js';
import { registerNews } from './news.js';
import { BANNED_TEXT, MUTE_FOR, muteUntil, mutedText, restrictLabel } from './restrict.js';

const COVER = path.resolve(import.meta.dirname, '../webapp/assets/cover.jpg');
const MAX_TEXT = 3500;

const CLIENT_COMMANDS = [
  { command: 'start', description: 'Открыть SOVSIDE' },
  { command: 'clear', description: 'Очистить чат' },
  { command: 'id', description: 'Мой Telegram ID' },
];
const ADMIN_COMMANDS = [
  { command: 'start', description: 'Открыть SOVSIDE' },
  { command: 'news', description: 'Рассылка всем клиентам' },
  { command: 'cancel', description: 'Отменить рассылку' },
  { command: 'mode', description: 'Переключиться: админ / клиент' },
  { command: 'clear', description: 'Очистить чат' },
  { command: 'id', description: 'Мой Telegram ID' },
];

// У админа в меню свои команды (с /news), у клиентов — обычные
export const setAdminCommands = (api, chatId) =>
  api.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: chatId } });

const NO_AVATARS = { touch() {} };

export function registerBot(bot, db, chat, avatars = NO_AVATARS) {
  let coverFileId = null;

  // Только личные сообщения
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.from && !ctx.from.is_bot) avatars.touch(await db.upsertUser(ctx.from));
    await next();
  });

  // Приветствие: обложка, описание и кнопка приложения. Его же видно после /clear.
  async function welcome(ctx) {
    const admin = await db.actsAsAdmin(ctx.from.id);
    const caption = admin
      ? '<b>SOVSIDE</b> · режим админа\n\n' +
        'Сообщения и заказы клиентов приходят сюда. Ответь реплаем, и ответ уйдёт клиенту. ' +
        'Все переписки и статусы заказов в приложении.\n\n' +
        'Рассылка всем клиентам: /news\n' +
        'Посмотреть всё глазами клиента: /mode\n' +
        'Бан и мут: ответь на сообщение клиента командой /ban, /mute 24 (часы), /unban или /unmute'
      : '<b>SOVSIDE</b> · моды для GTA5RP и Majestic RP\n\n' +
        'Ганпаки, одежда, редуксы. В приложении прайс, заказ и чат со мной.';
    const cover = coverFileId || (config.webAppUrl ? `${config.webAppUrl}/assets/cover.jpg` : new InputFile(COVER));
    const sent = await ctx.replyWithPhoto(cover, {
      caption: config.webAppUrl ? caption : `${caption}\n\n<i>Приложение ещё не подключено.</i>`,
      parse_mode: 'HTML',
      reply_markup: chat.appButton('Открыть SOVSIDE'),
    });
    coverFileId ??= sent.photo?.at(-1)?.file_id ?? null;
  }

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
    await welcome(ctx);
  });

  bot.command('id', (ctx) => ctx.reply(`Твой ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

  // Очищает чат с ботом в Telegram и переписку в приложении у того, кто вызвал,
  // и присылает обычное приветствие — чат выглядит как новый. У продавца история клиента остаётся.
  bot.command('clear', async (ctx) => {
    await db.clearForClient(ctx.from.id);
    await clearTelegramChat(ctx.api, ctx.chat.id, ctx.message.message_id);
    await welcome(ctx);
  });

  // Бан и мут реплаем на уведомление о сообщении или заказе клиента
  const restrictCommand = (name, apply) =>
    bot.command(name, async (ctx, next) => {
      if (!(await db.actsAsAdmin(ctx.from.id))) return next();
      const reply = ctx.message.reply_to_message;
      const clientId = reply && (await db.getRelay(ctx.chat.id, reply.message_id));
      if (!clientId) return ctx.reply(`Ответь командой /${name} на сообщение или заказ клиента.`);
      if (await db.isAdmin(clientId)) return ctx.reply('Админа нельзя забанить или замутить.');
      const done = await apply(clientId, ctx.match.trim());
      const u = await db.getUser(clientId);
      const who = u?.username ? `@${u.username}` : u?.firstName || `ID ${clientId}`;
      const now = restrictLabel(await db.restriction(clientId));
      await ctx.reply(`${who}: ${done}${now ? ` (сейчас: ${now})` : ''}.`);
    });

  restrictCommand('ban', async (id) => (await db.setBan(id, true), 'забанен'));
  restrictCommand('unban', async (id) => (await db.setBan(id, false), 'разбанен'));
  restrictCommand('unmute', async (id) => (await db.setMute(id, null), 'мут снят'));
  restrictCommand('mute', async (id, arg) => {
    // /mute — на сутки, /mute 3 — на 3 часа, /mute навсегда
    const forever = /^(навсегда|forever|0)$/i.test(arg);
    const hours = Number(arg);
    const until = forever ? 0 : Date.now() + (hours > 0 ? Math.min(hours, 24 * 365) : 24) * 3600e3;
    await db.setMute(id, until);
    return forever ? `в муте ${MUTE_FOR.forever.label}` : 'в муте';
  });

  // Админ переключается между режимом админа и обычного клиента
  bot.command('mode', async (ctx, next) => {
    if (!(await db.isAdmin(ctx.from.id))) return next();
    const mode = (await db.getMode(ctx.from.id)) === 'client' ? 'admin' : 'client';
    await db.setMode(ctx.from.id, mode);
    await ctx.reply(
      mode === 'client'
        ? 'Режим клиента: бот и приложение работают с тобой как с обычным покупателем. ' +
            'Уведомления о заказах клиентов продолжат приходить.\n\nВернуться в админку: /mode'
        : 'Режим админа включён.',
    );
  });

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
    if (await db.actsAsAdmin(ctx.from.id)) {
      const reply = msg.reply_to_message;
      clientId = reply && (await db.getRelay(ctx.chat.id, reply.message_id));
      if (!clientId) {
        return ctx.reply('Чтобы ответить клиенту, ответь реплаем на его сообщение. Или открой приложение.', {
          reply_markup: chat.appButton('Все чаты', '?tab=chat'),
        });
      }
    }

    // бан и мут проверяем до скачивания фото; на админов (даже в режиме клиента) они не действуют
    if (!clientId && !(await db.isAdmin(ctx.from.id))) {
      const r = await db.restriction(ctx.from.id);
      if (r.banned) return ctx.reply(BANNED_TEXT);
      if (r.muted) return ctx.reply(mutedText(r));
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

// В личке с ботом номера сообщений идут подряд, поэтому удаляем назад от команды /clear.
// Telegram разрешает боту удалять сообщения не старше 48 часов, остальные остаются.
const CLEAR_DEPTH = 1000;

async function clearTelegramChat(api, chatId, lastId) {
  for (let top = lastId; top > 0 && top > lastId - CLEAR_DEPTH; top -= 100) {
    const ids = [];
    for (let id = top; id > Math.max(0, top - 100); id--) ids.push(id);
    try {
      await api.deleteMessages(chatId, ids);
    } catch {
      // Пачка не удалилась целиком: пробуем по одному. Если не удалилось ничего — дальше только старше, выходим.
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 10) {
        const results = await Promise.all(ids.slice(i, i + 10).map((id) => api.deleteMessage(chatId, id).then(() => 1, () => 0)));
        deleted += results.reduce((a, b) => a + b, 0);
      }
      if (!deleted) return;
    }
  }
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
