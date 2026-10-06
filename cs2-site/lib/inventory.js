// Скины на сайте: покупка в маркете, продажа на баланс, вывод в Steam.

import { getDb } from './db.js';
import { fail } from './http.js';
import { getItem, publicItem } from './catalog.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { parseTradeUrl } from './validate.js';
import { notifyAdmin, rub } from './notify.js';
import * as market from './providers/market-csgo.js';

export const buyPrice = (price, s) => Math.ceil(price * (1 + s.marketMarkup));
export const sellPrice = (price, s) => Math.floor(price * s.siteSellRate);

export async function buyItem(userId, hashName, expectedPrice) {
  const db = await getDb();
  const s = await getSettings();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const item = await getItem(q, hashName);
    if (!item) fail(404, 'Скин не найден');
    const price = buyPrice(item.price, s);
    // Цена могла обновиться, пока игрок смотрел на страницу
    if (expectedPrice !== price) fail(409, 'Цена изменилась, проверь новую', { price });
    const ui = await q.one(
      `insert into user_items (user_id, hash_name, price, source) values ($1, $2, $3, 'market') returning id`,
      [userId, hashName, item.price],
    );
    const balance = await changeBalance(q, userId, -price, 'buy', { ref: `item:${ui.id}`, note: item.hash_name });
    return { itemId: ui.id, balance };
  });
}

// Скины игрока на сайте с актуальной ценой
export async function listOwned(userId) {
  const db = await getDb();
  const s = await getSettings();
  const rows = await db.query(
    `select ui.id, ui.status, ui.source, ui.created_at, i.*
     from user_items ui join items i on i.hash_name = ui.hash_name
     where ui.user_id = $1 and ui.status in ('owned', 'withdrawing')
     order by i.price desc, ui.id desc`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, source: r.source, ...publicItem(r), sellPrice: sellPrice(r.price, s) }));
}

export async function sellItems(userId, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50) fail(400, 'Выбери скины для продажи');
  const db = await getDb();
  const s = await getSettings();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const rows = await q.query(
      `select ui.id, i.price, i.hash_name from user_items ui join items i on i.hash_name = ui.hash_name
       where ui.user_id = $1 and ui.id = any($2) and ui.status = 'owned' for update of ui`,
      [userId, ids],
    );
    if (rows.length !== new Set(ids).size) fail(409, 'Часть скинов уже недоступна. Обнови страницу');
    const total = rows.reduce((sum, r) => sum + sellPrice(r.price, s), 0);
    await q.query(`update user_items set status = 'sold', updated_at = now() where id = any($1)`, [ids]);
    const balance = await changeBalance(q, userId, total, 'sell', { ref: `items:${ids.join(',')}`, note: `${rows.length} шт.` });
    return { total, balance };
  });
}

// Вывод скина в Steam: через market.csgo (если настроен) или вручную админом
export async function withdrawItem(userId, itemId) {
  const db = await getDb();
  const w = await db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const trade = parseTradeUrl(u.trade_url);
    if (!trade) fail(400, 'Сначала укажи трейд-ссылку в профиле');
    const ui = await q.one(
      `select ui.id, ui.hash_name, i.price from user_items ui join items i on i.hash_name = ui.hash_name
       where ui.id = $1 and ui.user_id = $2 and ui.status = 'owned' for update of ui`,
      [itemId, userId],
    );
    if (!ui) fail(409, 'Скин уже недоступен');
    await q.query(`update user_items set status = 'withdrawing', updated_at = now() where id = $1`, [ui.id]);
    return q.one(
      `insert into skin_withdrawals (user_id, user_item_id, hash_name, price, trade_url, status)
       values ($1, $2, $3, $4, $5, 'review') returning *`,
      [userId, ui.id, ui.hash_name, ui.price, trade.url],
    );
  });

  let status = 'review';
  if (market.isConfigured()) {
    const trade = parseTradeUrl(w.trade_url);
    try {
      const { providerId } = await market.buyFor({ hashName: w.hash_name, price: w.price, partner: trade.partner, token: trade.token, customId: `ld-${w.id}` });
      await db.query(`update skin_withdrawals set status = 'processing', provider_id = $2, updated_at = now() where id = $1`, [w.id, providerId]);
      status = 'processing';
    } catch (err) {
      await db.query('update skin_withdrawals set error = $2, updated_at = now() where id = $1', [w.id, String(err.message).slice(0, 300)]);
    }
  }
  if (status === 'review') await notifyAdmin(['🎯 Вывод скина на проверку', `#${w.id} ${w.hash_name} — ${rub(w.price)}`, w.trade_url]);
  return { id: w.id, status };
}

// Завершение вывода: sent — скин у игрока; refunded — вернуть скин на сайт
export async function finishSkinWithdrawal(id, result, note = null) {
  const db = await getDb();
  return db.tx(async (q) => {
    const w = await q.one(`select * from skin_withdrawals where id = $1 and status in ('review', 'processing') for update`, [id]);
    if (!w) fail(409, 'Вывод уже обработан');
    await q.query('update skin_withdrawals set status = $2, error = coalesce($3, error), updated_at = now() where id = $1', [id, result, note]);
    await q.query('update user_items set status = $2, updated_at = now() where id = $1', [w.user_item_id, result === 'sent' ? 'withdrawn' : 'owned']);
    return { id, status: result };
  });
}

// Проверка статусов у маркета (вызывается кроном)
export async function pollSkinWithdrawals() {
  if (!market.isConfigured()) return 0;
  const db = await getDb();
  const rows = await db.query(`select id from skin_withdrawals where status = 'processing' order by id limit 50`);
  let done = 0;
  for (const { id } of rows) {
    try {
      const st = await market.checkStatus(`ld-${id}`);
      if (st === 'sent') { await finishSkinWithdrawal(id, 'sent'); done++; }
      if (st === 'failed') {
        // Маркет не смог — отдаём админу (купить вручную или вернуть скин)
        await db.query(`update skin_withdrawals set status = 'review', error = 'маркет отменил сделку', updated_at = now() where id = $1`, [id]);
        await notifyAdmin([`⚠️ Маркет не доставил скин, вывод #${id} вернулся на проверку`]);
      }
    } catch (err) {
      console.error('poll withdrawal', id, err.message);
    }
  }
  return done;
}

export async function listSkinWithdrawals(userId) {
  const db = await getDb();
  return db.query('select id, hash_name, price, status, created_at, updated_at from skin_withdrawals where user_id = $1 order by id desc limit 30', [userId]);
}
