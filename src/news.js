import { InlineKeyboard } from 'grammy';
import { waitUntil } from '@vercel/functions';
import { config } from './config.js';

// Рассылка для админа: /news → бот ждёт сообщение → «Отправить всем N?» → копирует его каждому.
// Сообщение копируется целиком (copyMessage), поэтому сохраняются фото, видео и форматирование.

const BATCH = 20; // Telegram пропускает около 30 сообщений в секунду
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const people = (n) => {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return `${n} человеку`;
  return `${n} людям`;
};

export function registerNews(bot, db) {
  const recipients = async () => {
    const admins = await db.adminIds();
    return (await db.userIds()).filter((id) => !admins.has(id));
  };

  async function askConfirm(ctx, messageId) {
    const count = (await recipients()).length;
    if (!count) return ctx.reply('Пока некому отправлять: кроме тебя бота никто не запускал.');
    const id = await db.saveNewsDraft({ chatId: ctx.chat.id, messageId });
    await ctx.reply(`Отправить это сообщение ${people(count)}?`, {
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      reply_markup: new InlineKeyboard().text('Отправить', `news:${id}:go`).text('Отмена', `news:${id}:no`),
    });
  }

  bot.command('news', async (ctx, next) => {
    if (!(await db.actsAsAdmin(ctx.from.id))) return next();

    // «/news текст» — сразу черновик: бот повторяет текст с форматированием, его и разошлём
    const text = ctx.match.trim();
    if (text) {
      const start = ctx.message.text.indexOf(text);
      const entities = (ctx.message.entities || [])
        .filter((e) => e.offset >= start)
        .map((e) => ({ ...e, offset: e.offset - start }));
      const preview = await ctx.reply(text, { entities, link_preview_options: { is_disabled: true } });
      return askConfirm(ctx, preview.message_id);
    }

    await db.setNewsAwait(ctx.from.id);
    await ctx.reply(
      'Пришли одним сообщением то, что нужно разослать всем: текст, фото или видео с подписью. ' +
        'Форматирование сохранится.\n\n/cancel — отменить',
    );
  });

  bot.command('cancel', async (ctx, next) => {
    if (!(await db.actsAsAdmin(ctx.from.id))) return next();
    await db.clearNewsAwait(ctx.from.id);
    await ctx.reply('Рассылка отменена.');
  });

  // Сообщение после /news становится черновиком рассылки
  bot.on('message', async (ctx, next) => {
    if (ctx.message.text?.startsWith('/')) return next();
    if (!(await db.actsAsAdmin(ctx.from.id)) || !(await db.isNewsAwait(ctx.from.id))) return next();
    await db.clearNewsAwait(ctx.from.id);
    await askConfirm(ctx, ctx.message.message_id);
  });

  bot.callbackQuery(/^news:(\d+):(go|no)$/, async (ctx) => {
    if (!(await db.isAdmin(ctx.from.id))) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
    const [, id, action] = ctx.match;
    const draft = await db.getNewsDraft(id);
    if (!draft || !(await db.claimNews(id))) {
      return ctx.answerCallbackQuery({ text: 'Эта рассылка уже отправлена или отменена' });
    }
    if (action === 'no') {
      await ctx.answerCallbackQuery();
      return ctx.editMessageText('Рассылка отменена.').catch(() => {});
    }

    const users = await recipients();
    await ctx.answerCallbackQuery({ text: 'Рассылка запущена' });
    await ctx.editMessageText(`Отправляю… 0 из ${users.length}`).catch(() => {});
    const status = { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };

    // Отвечаем Telegram сразу, а рассылку доделываем в фоне (на Vercel функция живёт до её конца)
    const job = broadcast(bot.api, draft, users, status).catch((err) => console.error('[news]', err));
    waitUntil(job);
  });
}

async function broadcast(api, draft, users, status) {
  const keyboard = config.webAppUrl ? new InlineKeyboard().webApp('Открыть SOVSIDE', `${config.webAppUrl}/`) : undefined;

  const deliver = async (userId, retry = true) => {
    try {
      await api.copyMessage(userId, draft.chatId, draft.messageId, { reply_markup: keyboard });
      return true;
    } catch (err) {
      const wait = err.parameters?.retry_after;
      if (wait && retry) {
        await sleep(wait * 1000);
        return deliver(userId, false);
      }
      return false; // заблокировал бота, удалил аккаунт и т.п.
    }
  };

  let ok = 0;
  let done = 0;
  let lastEdit = Date.now();
  for (let i = 0; i < users.length; i += BATCH) {
    const started = Date.now();
    const results = await Promise.all(users.slice(i, i + BATCH).map((id) => deliver(id)));
    ok += results.filter(Boolean).length;
    done += results.length;
    if (done >= users.length) break;
    if (Date.now() - lastEdit > 3000) {
      lastEdit = Date.now();
      await api.editMessageText(status.chatId, status.messageId, `Отправляю… ${done} из ${users.length}`).catch(() => {});
    }
    await sleep(Math.max(0, 1000 - (Date.now() - started)));
  }

  const lines = [`Рассылка отправлена: ${ok} из ${users.length}.`];
  if (ok < users.length) lines.push(`Не доставлено: ${users.length - ok} (обычно это те, кто заблокировал бота).`);
  await api.editMessageText(status.chatId, status.messageId, lines.join('\n')).catch(() => {});
}
