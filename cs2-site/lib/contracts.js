// Контракты: игрок кладёт 3–10 своих скинов и получает один случайный скин из каталога
// стоимостью от contractMinMult до contractMaxMult суммы вклада (по умолчанию ×0,25…×4).
// Возможные результаты и их шансы видны до подписания; средняя стоимость результата = вклад × (1 − contractEdge).
// Бросок — тот же HMAC-SHA256(server_seed, client_seed:nonce), что в кейсах и апгрейдере.

import { getDb } from './db.js';
import { fail } from './http.js';
import { publicItem } from './catalog.js';
import { getSettings } from './settings.js';
import { lockUser } from './users.js';
import { computeRoll, hashSeed } from './fair.js';
import { sellPrice } from './inventory.js';
import { solveOdds } from './cases.js';
import { addXp } from './vip.js';

const POOL = 16; // сколько разных скинов может выпасть

function checkIds(ids, s) {
  const uniq = [...new Set(Array.isArray(ids) ? ids : [])].filter(Number.isSafeInteger);
  if (uniq.length < s.contractMinItems || uniq.length > s.contractMaxItems) {
    fail(400, `В контракт кладут от ${s.contractMinItems} до ${s.contractMaxItems} скинов`);
  }
  return uniq;
}

async function ownedInputs(q, userId, ids, lock = false) {
  const rows = await q.query(
    `select ui.id, ui.hash_name, i.price from user_items ui join items i on i.hash_name = ui.hash_name
     where ui.user_id = $1 and ui.id = any($2) and ui.status = 'owned'${lock ? ' for update of ui' : ''}`,
    [userId, ids],
  );
  if (rows.length !== ids.length) fail(409, 'Часть скинов уже недоступна. Обнови страницу');
  return rows;
}

// Возможные результаты: POOL скинов равномерно по цене в диапазоне, шансы — чтобы средний результат был value × (1 − edge)
async function buildPool(q, value, s) {
  const min = Math.ceil(value * s.contractMinMult);
  const max = Math.floor(value * s.contractMaxMult);
  const rows = await q.query(
    `select * from items where quantity > 0 and image is not null and price between $1 and $2 order by price asc, hash_name asc`,
    [min, max],
  );
  let picked = rows;
  if (rows.length > POOL) {
    const idx = new Set();
    for (let i = 0; i < POOL; i++) idx.add(Math.round((i * (rows.length - 1)) / (POOL - 1)));
    picked = [...idx].map((i) => rows[i]);
  }
  const ppm = solveOdds(picked.map((r) => r.price), value * (1 - s.contractEdge));
  if (!ppm) fail(400, 'Для такой суммы не нашлось подходящих скинов — добавь или убери скины');
  return { min, max, items: picked.map((row, i) => ({ row, ppm: ppm[i] })).sort((a, b) => b.row.price - a.row.price) };
}

export async function previewContract(userId, ids) {
  const s = await getSettings();
  const db = await getDb();
  const inputs = await ownedInputs(db, userId, checkIds(ids, s));
  const value = inputs.reduce((a, r) => a + r.price, 0);
  const pool = await buildPool(db, value, s);
  return { value, min: pool.min, max: pool.max, items: pool.items.map(({ row, ppm }) => ({ ...publicItem(row), ppm })) };
}

export async function signContract(userId, ids, expectedValue = null) {
  const s = await getSettings();
  const list = checkIds(ids, s);
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const inputs = await ownedInputs(q, userId, list, true);
    const value = inputs.reduce((a, r) => a + r.price, 0);
    if (expectedValue != null && expectedValue !== value) fail(409, 'Цены скинов обновились — проверь контракт ещё раз', { value });
    const pool = await buildPool(q, value, s);

    const nonce = u.nonce;
    const roll = computeRoll(u.server_seed, u.client_seed, nonce);
    const ascending = [...pool.items].reverse();
    let acc = 0;
    let drop = ascending[ascending.length - 1];
    for (const it of ascending) { acc += it.ppm; if (roll < acc) { drop = it; break; } }

    await q.query('update users set nonce = nonce + 1 where id = $1', [userId]);
    await addXp(q, userId, value, 'contract');
    await q.query(`update user_items set status = 'burned', updated_at = now() where id = any($1)`, [list]);
    const userItemId = (await q.one(
      `insert into user_items (user_id, hash_name, price, source) values ($1, $2, $3, 'contract') returning id`,
      [userId, drop.row.hash_name, drop.row.price],
    )).id;
    const c = await q.one(
      `insert into contracts (user_id, input_items, input_value, hash_name, item_price, chance_ppm, roll, server_seed_hash, client_seed, nonce, user_item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [userId, JSON.stringify(inputs.map((r) => ({ id: r.id, hashName: r.hash_name, price: r.price }))), value,
        drop.row.hash_name, drop.row.price, drop.ppm, roll, hashSeed(u.server_seed), u.client_seed, nonce, userItemId],
    );
    return { id: c.id, value, item: { ...publicItem(drop.row), ppm: drop.ppm }, userItemId, sellPrice: sellPrice(drop.row.price, s), roll };
  });
}
