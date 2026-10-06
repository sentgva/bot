// Продажа скинов из Steam: заявка → админ присылает трейд → после получения скинов зачисляет деньги.
// Заявку можно оставить и без входа — через форму на главной.

import { getDb } from './db.js';
import { fail } from './http.js';
import { getSettings } from './settings.js';
import { changeBalance } from './users.js';
import { fetchInventory } from './steam.js';
import { priceMap } from './catalog.js';
import { normalizePhone, normalizeTelegram, parseTradeUrl } from './validate.js';
import { notifyAdmin, rub } from './notify.js';

export const SELL_METHODS = { balance: 'на баланс', card: 'на карту', sbp: 'по СБП', crypto: 'в крипту (USDT/TON)' };
const CACHE_MINUTES = 10;

// Инвентарь Steam с ценами выкупа. Кэшируем, потому что Steam строго ограничивает частоту.
export async function steamInventoryWithPrices(steamId, { refresh = false } = {}) {
  const db = await getDb();
  const s = await getSettings();
  let cached = await db.one('select data, fetched_at from steam_inventory_cache where steam_id = $1', [steamId]);
  // Кэш живёт час; кнопкой «Обновить» можно перезапросить не чаще раза в 10 минут
  const age = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
  if (age > (refresh ? CACHE_MINUTES : 60) * 60_000) {
    try {
      const items = await fetchInventory(steamId);
      await db.query(
        `insert into steam_inventory_cache (steam_id, data, fetched_at) values ($1, $2, now())
         on conflict (steam_id) do update set data = excluded.data, fetched_at = now()`,
        [steamId, JSON.stringify(items)],
      );
      cached = { data: items, fetched_at: new Date() };
    } catch (err) {
      if (!cached) {
        if (err.code === 'private') fail(400, 'Инвентарь скрыт. Открой его в настройках приватности Steam и обнови страницу');
        fail(502, 'Steam не отдал инвентарь. Попробуй через минуту');
      }
    }
  }
  const prices = await priceMap(db, [...new Set(cached.data.map((i) => i.hashName))]);
  const items = cached.data.map((i) => {
    const p = prices.get(i.hashName);
    return {
      ...i,
      rarity: p?.rarity ?? null,
      wear: p?.wear ?? null,
      image: i.image || p?.image || null,
      price: p?.price ?? null,
      buyback: p && i.tradable ? Math.floor(p.price * s.buybackRate) : null,
    };
  }).sort((a, b) => (b.buyback ?? -1) - (a.buyback ?? -1));
  return { items, fetchedAt: cached.fetched_at, rate: s.buybackRate };
}

export async function createSellRequest({ user, tradeUrl, method, contact, assetIds = [] }) {
  const trade = parseTradeUrl(tradeUrl);
  if (!trade) fail(400, 'Проверь трейд-ссылку: её можно скопировать в Steam → Инвентарь → Предложения обмена', { field: 'tradeUrl' });
  if (!SELL_METHODS[method]) fail(400, 'Выбери, куда получить деньги', { field: 'method' });
  if (method === 'balance' && !user) fail(400, 'Чтобы получить деньги на баланс, войди через Steam', { field: 'method' });
  let normContact = null;
  if (contact || !user) {
    normContact = normalizePhone(contact) || normalizeTelegram(contact);
    if (!normContact) fail(400, 'Укажи телефон +7… или ник в Telegram', { field: 'contact' });
  }

  // Если игрок выбрал конкретные скины — фиксируем их и оценку выкупа
  let items = [];
  let estimate = 0;
  if (user?.steam_id && assetIds.length) {
    const inv = await steamInventoryWithPrices(user.steam_id);
    const chosen = new Set(assetIds.map(String));
    items = inv.items.filter((i) => chosen.has(i.assetId) && i.buyback).map((i) => ({ assetId: i.assetId, hashName: i.hashName, price: i.buyback }));
    if (!items.length) fail(400, 'Выбранные скины нельзя продать: они не обмениваются или у них нет цены');
    estimate = items.reduce((s, i) => s + i.price, 0);
  }

  const db = await getDb();
  const row = await db.one(
    `insert into sell_requests (user_id, trade_url, method, contact, items, estimate) values ($1, $2, $3, $4, $5, $6) returning id`,
    [user?.id ?? null, trade.url, method, normContact, JSON.stringify(items), estimate],
  );
  await notifyAdmin([
    '🛒 Заявка на продажу скинов',
    `#${row.id}: ${SELL_METHODS[method]}${estimate ? `, оценка ${rub(estimate)} (${items.length} шт.)` : ''}`,
    user ? `Игрок: ${user.name} (${user.steam_id ? `Steam ${user.steam_id}` : `Telegram ${user.tg_username ? '@' + user.tg_username : user.telegram_id}`})` : null,
    normContact ? `Контакт: ${normContact}` : null,
    trade.url,
  ]);
  return { id: row.id, estimate };
}

export async function listSellRequests(userId) {
  const db = await getDb();
  return db.query('select id, method, items, estimate, status, amount, created_at from sell_requests where user_id = $1 order by id desc limit 20', [userId]);
}

// Админ: взять в работу / завершить (с зачислением на баланс) / отклонить
export async function updateSellRequest(id, action, { amount, note } = {}) {
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.one(`select * from sell_requests where id = $1 and status in ('new', 'in_work') for update`, [id]);
    if (!r) fail(409, 'Заявка уже закрыта');
    if (action === 'take') {
      await q.query(`update sell_requests set status = 'in_work', updated_at = now() where id = $1`, [id]);
    } else if (action === 'reject') {
      await q.query(`update sell_requests set status = 'rejected', admin_note = $2, updated_at = now() where id = $1`, [id, note || null]);
    } else if (action === 'done') {
      if (!Number.isSafeInteger(amount) || amount <= 0) fail(400, 'Укажи итоговую сумму');
      // На баланс зачисляем сразу; для карты/крипты админ платит сам, сумма фиксируется для истории
      if (r.method === 'balance' && r.user_id) await changeBalance(q, r.user_id, amount, 'buyback', { ref: `sell:${id}` });
      await q.query(`update sell_requests set status = 'done', amount = $2, admin_note = $3, updated_at = now() where id = $1`, [id, amount, note || null]);
    } else {
      fail(400, 'Неизвестное действие');
    }
    return { id, action };
  });
}
