// Все маршруты API. Обработчик один и тот же для Vercel (api/index.js) и локального сервера (scripts/dev.js).

import { waitUntil } from '@vercel/functions';
import { config } from './config.js';
import {
  HttpError, assertSameOrigin, createRouter, fail, int, ipKey, parseCookies, rateLimit, readBody, readJson,
  redirect, sendJson, setCookie, str,
} from './http.js';
import { endSession, sessionUserId, startSession } from './session.js';
import { getProfile, isAdmin, loginUrl, verifyLogin } from './steam.js';
import { getUser, ledgerOf, publicUser, rotateSeed, setClientSeed, setTradeUrl, upsertSteamUser } from './users.js';
import { listItems, pricesAreStale, syncCatalog } from './catalog.js';
import { buyItem, buyPrice, finishSkinWithdrawal, listOwned, listSkinWithdrawals, pollSkinWithdrawals, sellItems, withdrawItem } from './inventory.js';
import { listUpgrades, recentWins, runUpgrade } from './upgrade.js';
import {
  createCryptoDeposit, demoTopup, finishWithdraw, handleCryptoWebhook, listPayments, methodsInfo, requestWithdraw, sendCryptoCheck,
} from './payments.js';
import { createSellRequest, listSellRequests, steamInventoryWithPrices, updateSellRequest } from './sell.js';
import { getStats } from './stats.js';
import { getSettings, updateSettings } from './settings.js';
import { isValidClientSeed } from './fair.js';
import { parseTradeUrl, rublesToKop } from './validate.js';
import * as admin from './admin.js';

const r = createRouter();
const CALLBACK = '/api/auth/steam/callback';

// ── Помощники ──────────────────────────────────────────────

async function currentUser(req) {
  const u = await getUser(sessionUserId(req));
  return u && !u.is_banned ? u : null;
}

async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) fail(401, 'Войди через Steam, чтобы продолжить');
  return u;
}

async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!isAdmin(u.steam_id)) fail(403, 'Нет доступа');
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

// ── Вход через Steam ───────────────────────────────────────

r.get('/api/auth/steam', async (req, res, { url }) => {
  await rateLimit(`login:${ipKey(req)}`, 20, 600);
  setCookie(res, 'ld_next', safeNext(url.searchParams.get('next')), { maxAge: 600 });
  redirect(res, loginUrl(config.siteUrl + CALLBACK));
});

r.get(CALLBACK, async (req, res, { url }) => {
  const steamId = await verifyLogin(url.searchParams, config.siteUrl + CALLBACK).catch(() => null);
  if (!steamId) return redirect(res, '/?login=failed');
  const profile = await getProfile(steamId);
  const user = await upsertSteamUser({ steamId, ...profile });
  if (user.is_banned) return redirect(res, '/?login=banned');
  startSession(res, user.id);
  const next = safeNext(parseCookies(req).ld_next);
  setCookie(res, 'ld_next', '', { maxAge: 0 });
  redirect(res, next);
});

// Только локально (DEV_LOGIN=1): войти тестовым игроком без Steam
r.get('/api/auth/dev', async (req, res, { url }) => {
  if (!config.devLogin) fail(404, 'Не найдено');
  const steamId = /^\d{17}$/.test(url.searchParams.get('steamId') || '') ? url.searchParams.get('steamId') : '76561198000000001';
  const user = await upsertSteamUser({ steamId, name: url.searchParams.get('name') || 'Тестовый игрок', avatar: null });
  startSession(res, user.id);
  redirect(res, safeNext(url.searchParams.get('next')));
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
      market: { markup: s.marketMarkup, sellRate: s.siteSellRate, buybackRate: s.buybackRate },
    },
  };
});

r.patch('/api/me', async (req) => {
  const u = await requireUser(req);
  const body = await readJson(req);
  if ('tradeUrl' in body) {
    const trade = parseTradeUrl(body.tradeUrl);
    if (!trade) fail(400, 'Проверь трейд-ссылку', { field: 'tradeUrl' });
    // Трейд-ссылка должна принадлежать этому же аккаунту Steam
    const steamId = (76561197960265728n + BigInt(trade.partner)).toString();
    if (steamId !== u.steam_id) fail(400, 'Это трейд-ссылка другого аккаунта Steam', { field: 'tradeUrl' });
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
r.get('/api/me/sell-requests', async (req) => listSellRequests((await requireUser(req)).id));
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

// ── Деньги ─────────────────────────────────────────────────

r.post('/api/deposit/crypto', async (req) => {
  const u = await requireUser(req);
  await rateLimit(`dep:${u.id}`, 10, 600);
  const { amount } = await readJson(req);
  return createCryptoDeposit(u.id, rublesToKop(amount));
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

// ── Продажа скинов из Steam ────────────────────────────────

r.get('/api/steam-inventory', async (req, res, { url }) => {
  const u = await requireUser(req);
  const refresh = url.searchParams.get('refresh') === '1';
  if (refresh) await rateLimit(`inv:${u.id}`, 6, 600);
  return steamInventoryWithPrices(u.steam_id, { refresh });
});

r.post('/api/sell-requests', async (req) => {
  const b = await readJson(req);
  // Ловушка для ботов: скрытое поле заполнено или форму отправили быстрее чем за 2 секунды
  if (str(b.website) || (Number(b.startedAt) && Date.now() - Number(b.startedAt) < 2000)) return { id: 0, estimate: 0 };
  await rateLimit(`sellreq:${ipKey(req)}`, 5, 3600);
  const user = await currentUser(req);
  return createSellRequest({
    user,
    tradeUrl: str(b.tradeUrl, 200) || user?.trade_url,
    method: str(b.method, 10),
    contact: str(b.contact, 60),
    assetIds: Array.isArray(b.assetIds) ? b.assetIds.slice(0, 100).map((x) => str(String(x), 24)) : [],
  });
});

// ── Публичная статистика ───────────────────────────────────

r.get('/api/stats', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return getStats();
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
r.get('/api/admin/sell-requests', async (req, res, { url }) => { await requireAdmin(req); return admin.listSellRequests(url.searchParams.get('status') || 'open'); });
r.post('/api/admin/sell-requests/:id', async (req, res, { params }) => {
  await requireAdmin(req);
  const { action, amount, note } = await readJson(req);
  return updateSellRequest(int(params.id), action, { amount: rublesToKop(amount), note: str(note, 300) });
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

export async function handler(req, res) {
  const url = new URL(req.url, config.siteUrl);
  try {
    const found = r.match(req.method, url.pathname);
    if (!found) fail(404, 'Не найдено');
    if (found === 'method') fail(405, 'Метод не поддерживается');
    // Вебхук приходит с сервера Crypto Pay — у него своя проверка подписи
    if (MUTATING.has(req.method) && url.pathname !== '/api/webhooks/cryptopay') assertSameOrigin(req);
    const result = await found.handler(req, res, { url, params: found.params });
    if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
    console.error(req.method, url.pathname, err);
    sendJson(res, 500, { error: 'Что-то пошло не так. Попробуй ещё раз' });
  }
}
