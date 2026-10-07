// Все маршруты API. Обработчик один и тот же для Vercel (api/index.js) и локального сервера (scripts/dev.js).

import { waitUntil } from '@vercel/functions';
import { config } from './config.js';
import {
  HttpError, assertSameOrigin, createRouter, fail, int, ipKey, rateLimit, readBody, readJson, redirect, sendJson, str,
} from './http.js';
import { endSession, sessionUserId, startSession } from './session.js';
import { getUser, isAdmin, ledgerOf, publicUser, rotateSeed, setClientSeed, setTradeUrl, upsertTelegramUser } from './users.js';
import { botId, handleUpdate, verifyInitData, verifyLoginWidget, webhookSecret } from './telegram.js';
import { listItems, pricesAreStale, syncCatalog } from './catalog.js';
import { buyItem, buyPrice, finishSkinWithdrawal, listOwned, listSkinWithdrawals, pollSkinWithdrawals, sellItems, withdrawItem } from './inventory.js';
import { listUpgrades, recentWins, runUpgrade } from './upgrade.js';
import {
  createCryptoDeposit, createStarsInvoice, demoTopup, finishWithdraw, handleCryptoWebhook, handlePreCheckout, handleStarsPaid,
  listPayments, methodsInfo, requestWithdraw, sendCryptoCheck,
} from './payments.js';
import { getStats } from './stats.js';
import { getLive } from './live.js';
import { getSettings, updateSettings } from './settings.js';
import { isValidClientSeed } from './fair.js';
import { parseTradeUrl, rublesToKop } from './validate.js';
import * as admin from './admin.js';
import { getCase, listCases, openCase } from './cases.js';

const r = createRouter();

// ── Помощники ──────────────────────────────────────────────

async function currentUser(req) {
  const u = await getUser(sessionUserId(req));
  return u && !u.is_banned ? u : null;
}

async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) fail(401, 'Войди через Telegram, чтобы продолжить');
  return u;
}

async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!isAdmin(u)) fail(403, 'Нет доступа');
  return u;
}

// Только внутренние пути, чтобы после входа нельзя было увести на чужой сайт
const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/)[\w\-/.#?=&%]*$/.test(v) ? v : '/profile/');

function refreshPricesInBackground() {
  waitUntil(
    pricesAreStale()
      .then((stale) => stale && syncCatalog())
      .catch((err) => console.warn('Обновление цен не удалось:', err.message)),
  );
}

// ── Вход: только через Telegram ────────────────────────────

// Сайт: Telegram Login. Страница /login/ получает подписанные данные от oauth.telegram.org и пересылает сюда.
r.post('/api/auth/telegram-widget', async (req, res) => {
  await rateLimit(`tg-login:${ipKey(req)}`, 30, 600);
  const { data } = await readJson(req);
  const tg = verifyLoginWidget(data);
  if (!tg) fail(401, 'Не получилось войти через Telegram. Попробуй ещё раз');
  const user = await upsertTelegramUser(tg);
  if (user.is_banned) fail(403, 'Аккаунт заблокирован. Напиши в поддержку');
  startSession(res, user.id);
  return { user: publicUser(user) };
});

// Только локально (DEV_LOGIN=1): войти тестовым игроком без Telegram
r.get('/api/auth/dev', async (req, res, { url }) => {
  if (!config.devLogin) fail(404, 'Не найдено');
  const id = int(url.searchParams.get('tgId')) || 100001;
  const user = await upsertTelegramUser({ id, first_name: url.searchParams.get('name') || 'Тестовый игрок', username: `tester${id}` });
  startSession(res, user.id);
  redirect(res, safeNext(url.searchParams.get('next')));
});

// Вход из Telegram Mini App: initData подписаны Telegram ключом нашего бота
r.post('/api/auth/telegram', async (req, res) => {
  await rateLimit(`tg-login:${ipKey(req)}`, 30, 600);
  const { initData } = await readJson(req);
  const tg = verifyInitData(str(initData, 4096));
  if (!tg) fail(401, 'Не получилось войти через Telegram. Закрой и снова открой приложение из бота');
  const user = await upsertTelegramUser(tg);
  if (user.is_banned) fail(403, 'Аккаунт заблокирован. Напиши в поддержку');
  return { token: startSession(res, user.id), user: publicUser(user) };
});

// Вебхук бота: Telegram присылает секрет в заголовке, без него запрос отклоняем
r.post('/api/telegram/webhook', async (req) => {
  if (!config.tgBotToken || req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) fail(401, 'unauthorized');
  const update = await readJson(req);
  try {
    // Оплата звёздами: проверка перед списанием и зачисление после оплаты
    if (update.pre_checkout_query) await handlePreCheckout(update.pre_checkout_query);
    else if (update.message?.successful_payment) await handleStarsPaid(update.message);
    else await handleUpdate(update);
  } catch (err) {
    console.error('telegram update:', err.message);
  }
  return { ok: true };
});

r.post('/api/auth/logout', async (req, res) => {
  endSession(res);
  return { ok: true };
});

// ── Профиль ────────────────────────────────────────────────

r.get('/api/me', async (req) => {
  const u = await currentUser(req);
  const s = await getSettings();
  return {
    user: u ? publicUser(u) : null,
    config: {
      payments: methodsInfo(s),
      upgrade: { houseEdge: s.houseEdge, maxChance: s.maxChance, minChance: s.minChance, maxItems: s.maxUpgradeItems, minValue: s.minUpgradeValue },
      market: { markup: s.marketMarkup, sellRate: s.siteSellRate },
      cases: { edge: s.caseEdge },
      // Для страницы входа: ID и имя бота LuxeDrop (не секретные), тестовый вход — только локально
      auth: { telegramBotId: botId(), botUsername: config.tgBotUsername || null, devLogin: config.devLogin },
    },
  };
});

r.patch('/api/me', async (req) => {
  const u = await requireUser(req);
  const body = await readJson(req);
  if ('tradeUrl' in body) {
    const trade = parseTradeUrl(body.tradeUrl);
    if (!trade) fail(400, 'Проверь трейд-ссылку', { field: 'tradeUrl' });
    // Steam не привязан к аккаунту: трейд-ссылку проверяем по формату, скины уйдут на неё
    await setTradeUrl(u.id, trade.url);
  }
  if ('clientSeed' in body) {
    if (!isValidClientSeed(body.clientSeed)) fail(400, 'Сид: латиница, цифры, - и _, до 32 символов', { field: 'clientSeed' });
    await setClientSeed(u.id, body.clientSeed);
  }
  return { user: publicUser(await getUser(u.id)) };
});

r.post('/api/me/seed/rotate', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`seed:${u.id}`, 10, 3600);
  return rotateSeed(u.id);
});

r.get('/api/me/ledger', async (req) => ledgerOf((await requireUser(req)).id));
r.get('/api/me/payments', async (req) => listPayments((await requireUser(req)).id));
r.get('/api/me/upgrades', async (req) => listUpgrades((await requireUser(req)).id));
r.get('/api/me/skin-withdrawals', async (req) => listSkinWithdrawals((await requireUser(req)).id));

// ── Каталог и маркет ───────────────────────────────────────

r.get('/api/items', async (req, res, { url }) => {
  refreshPricesInBackground();
  const p = url.searchParams;
  const s = await getSettings();
  const data = await listItems({
    q: str(p.get('q'), 80),
    rarity: str(p.get('rarity'), 20),
    min: int(p.get('min')) || 0,
    max: int(p.get('max')) || 0,
    sort: str(p.get('sort'), 20),
    offset: int(p.get('offset')) || 0,
    limit: int(p.get('limit')) || 24,
  });
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
  return { total: data.total, items: data.items.map((i) => ({ ...i, buyPrice: buyPrice(i.price, s) })) };
});

r.post('/api/market/buy', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`buy:${u.id}`, 30, 60);
  const { hashName, price } = await readJson(req);
  return buyItem(u.id, str(hashName, 200), int(price));
});

r.get('/api/inventory', async (req) => listOwned((await requireUser(req)).id));

r.post('/api/inventory/sell', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`sell:${u.id}`, 30, 60);
  const { ids } = await readJson(req);
  return sellItems(u.id, Array.isArray(ids) ? ids.map(int).filter(Number.isSafeInteger) : []);
});

r.post('/api/inventory/withdraw', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`wd-skin:${u.id}`, 10, 600);
  const { id } = await readJson(req);
  return withdrawItem(u.id, int(id));
});

// ── Апгрейдер ──────────────────────────────────────────────

r.post('/api/upgrade', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`upgrade:${u.id}`, 20, 60);
  const body = await readJson(req);
  return runUpgrade(u.id, {
    itemIds: Array.isArray(body.itemIds) ? body.itemIds.map(int).filter(Number.isSafeInteger) : [],
    balance: int(body.balance) || 0,
    target: str(body.target, 200),
  });
});

r.get('/api/upgrades/recent', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=10');
  return recentWins(12);
});

// ── Кейсы ──────────────────────────────────────────────────

r.get('/api/cases', async (req, res) => {
  refreshPricesInBackground();
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
  return listCases();
});
r.get('/api/cases/:slug', async (req, res, { params }) => {
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
  return getCase(str(params.slug, 40));
});
r.post('/api/cases/:slug/open', async (req, res, { params }) => {
  const u = await requireUser(req);
  await rateLimit(`case:${u.id}`, 60, 60);
  return openCase(u.id, str(params.slug, 40));
});

// ── Деньги ─────────────────────────────────────────────────

r.post('/api/deposit/crypto', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`dep:${u.id}`, 10, 600);
  const { amount } = await readJson(req);
  return createCryptoDeposit(u.id, rublesToKop(amount));
});

// Пополнение звёздами Telegram: возвращает ссылку на счёт (в Mini App открывается через openInvoice)
r.post('/api/deposit/stars', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`stars:${u.id}`, 20, 600);
  const { stars } = await readJson(req);
  return createStarsInvoice(u.id, int(stars));
});

r.post('/api/deposit/demo', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`demo:${u.id}`, 5, 3600);
  return demoTopup(u.id);
});

r.post('/api/withdraw', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`wd:${u.id}`, 5, 600);
  const b = await readJson(req);
  return requestWithdraw(u.id, {
    method: str(b.method, 10), amount: rublesToKop(b.amount),
    card: str(b.card, 30), phone: str(b.phone, 30), bank: str(b.bank, 40), asset: str(b.asset, 10),
  });
});

r.post('/api/webhooks/cryptopay', async (req) => {
  const raw = await readBody(req);
  return handleCryptoWebhook(raw, req.headers['crypto-pay-api-signature']);
});

// ── Публичная статистика ───────────────────────────────────

r.get('/api/stats', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return getStats();
});

// Лента над сайтом: онлайн, последние выигрыши, лучший дроп. Заодно отмечает посетителя как «онлайн».
r.get('/api/live', async (req, res) => {
  await rateLimit(`live:${ipKey(req)}`, 120, 60);
  const u = await currentUser(req);
  return getLive(u ? `u:${u.id}` : `g:${ipKey(req)}`);
});

// ── Крон (Vercel Cron шлёт Authorization: Bearer CRON_SECRET) ──

r.get('/api/cron/prices', async (req) => {
  if (!config.cronSecret || req.headers.authorization !== `Bearer ${config.cronSecret}`) fail(401, 'unauthorized');
  const prices = await syncCatalog();
  const delivered = await pollSkinWithdrawals();
  return { ...prices, delivered };
});

// ── Админка ────────────────────────────────────────────────

r.get('/api/admin/overview', async (req) => { await requireAdmin(req); return admin.overview(); });
r.get('/api/admin/withdrawals', async (req, res, { url }) => { await requireAdmin(req); return admin.listWithdrawals(url.searchParams.get('status') || 'open'); });
r.post('/api/admin/withdrawals/:id', async (req, res, { params }) => {
  await requireAdmin(req);
  const { action, note } = await readJson(req);
  if (action === 'send') { const c = await sendCryptoCheck(int(params.id)); return { id: int(params.id), status: 'paid', checkUrl: c.url }; }
  return finishWithdraw(int(params.id), action, str(note, 300));
});
r.get('/api/admin/skin-withdrawals', async (req, res, { url }) => { await requireAdmin(req); return admin.listSkinWithdrawals(url.searchParams.get('status') || 'open'); });
r.post('/api/admin/skin-withdrawals/:id', async (req, res, { params }) => {
  await requireAdmin(req);
  const { action, note } = await readJson(req);
  if (!['sent', 'refunded'].includes(action)) fail(400, 'Неизвестное действие');
  return finishSkinWithdrawal(int(params.id), action, str(note, 300) || null);
});
r.get('/api/admin/users', async (req, res, { url }) => { await requireAdmin(req); return admin.findUsers(url.searchParams.get('q')); });
r.post('/api/admin/users/:id', async (req, res, { params }) => {
  await requireAdmin(req);
  const b = await readJson(req);
  const amount = b.amount === undefined ? undefined : Math.round(Number(b.amount) * 100);
  return admin.updateUser(int(params.id), { action: b.action, amount, note: str(b.note, 200) });
});
r.get('/api/admin/settings', async (req) => { await requireAdmin(req); return getSettings(); });
r.post('/api/admin/settings', async (req) => { await requireAdmin(req); return updateSettings(await readJson(req)); });

// ── Точка входа ────────────────────────────────────────────

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const WEBHOOKS = new Set(['/api/webhooks/cryptopay', '/api/telegram/webhook']);

export async function handler(req, res) {
  const url = new URL(req.url, config.siteUrl);
  try {
    const found = r.match(req.method, url.pathname);
    if (!found) fail(404, 'Не найдено');
    if (found === 'method') fail(405, 'Метод не поддерживается');
    // Вебхуки приходят с серверов Crypto Pay и Telegram — у них своя проверка подписи
    if (MUTATING.has(req.method) && !WEBHOOKS.has(url.pathname)) assertSameOrigin(req);
    const result = await found.handler(req, res, { url, params: found.params });
    if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
    console.error(req.method, url.pathname, err);
    sendJson(res, 500, { error: 'Что-то пошло не так. Попробуй ещё раз' });
  }
}
