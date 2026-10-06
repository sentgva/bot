// Апгрейдер: ставишь скины и/или часть баланса, выбираешь скин дороже — сервер честно бросает.
// Вся операция — одна транзакция: блокируем игрока и его скины, считаем шанс, бросаем, пишем результат.

import { getDb } from './db.js';
import { fail } from './http.js';
import { getItem, publicItem } from './catalog.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { ROLL_MAX, computeRoll, hashSeed } from './fair.js';

export async function runUpgrade(userId, { itemIds = [], balance = 0, target }) {
  const s = await getSettings();
  const ids = [...new Set(itemIds)];
  if (ids.length > s.maxUpgradeItems) fail(400, `Не больше ${s.maxUpgradeItems} скинов за раз`);
  if (!Number.isSafeInteger(balance) || balance < 0) fail(400, 'Некорректная сумма');
  if (!ids.length && !balance) fail(400, 'Выбери скины или сумму с баланса');
  if (typeof target !== 'string' || !target) fail(400, 'Выбери скин, который хочешь получить');

  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const items = ids.length
      ? await q.query(
        `select ui.id, ui.hash_name, i.price from user_items ui join items i on i.hash_name = ui.hash_name
         where ui.user_id = $1 and ui.id = any($2) and ui.status = 'owned' for update of ui`,
        [userId, ids],
      )
      : [];
    if (items.length !== ids.length) fail(409, 'Часть скинов уже недоступна. Обнови страницу');

    const targetItem = await getItem(q, target);
    if (!targetItem) fail(404, 'Целевой скин не найден');

    const inputValue = items.reduce((sum, i) => sum + i.price, 0) + balance;
    if (inputValue < s.minUpgradeValue) fail(400, `Минимальная ставка — ${s.minUpgradeValue / 100} ₽`);
    const raw = (inputValue / targetItem.price) * (1 - s.houseEdge);
    if (raw > s.maxChance) fail(400, `Шанс больше ${Math.round(s.maxChance * 100)}% — выбери скин дороже`);
    if (raw < s.minChance) fail(400, `Шанс меньше ${s.minChance * 100}% — выбери скин дешевле`);
    const chance = Math.floor(raw * ROLL_MAX);

    const nonce = u.nonce;
    const roll = computeRoll(u.server_seed, u.client_seed, nonce);
    const won = roll < chance;

    await q.query('update users set nonce = nonce + 1 where id = $1', [userId]);
    if (items.length) await q.query(`update user_items set status = 'burned', updated_at = now() where id = any($1)`, [ids]);

    let resultItemId = null;
    if (won) {
      resultItemId = (await q.one(
        `insert into user_items (user_id, hash_name, price, source) values ($1, $2, $3, 'upgrade') returning id`,
        [userId, targetItem.hash_name, targetItem.price],
      )).id;
    }
    const up = await q.one(
      `insert into upgrades (user_id, input_items, input_balance, input_value, target_hash_name, target_price, chance_ppm, roll, won,
                             server_seed_hash, client_seed, nonce, result_item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [userId, JSON.stringify(items.map((i) => ({ id: i.id, hashName: i.hash_name, price: i.price }))), balance, inputValue,
        targetItem.hash_name, targetItem.price, chance, roll, won, hashSeed(u.server_seed), u.client_seed, nonce, resultItemId],
    );
    const newBalance = balance ? await changeBalance(q, userId, -balance, 'upgrade', { ref: `upgrade:${up.id}` }) : u.balance;

    return {
      id: up.id,
      won,
      roll,
      chance,
      target: publicItem(targetItem),
      resultItemId,
      balance: newBalance,
      fair: { serverSeedHash: hashSeed(u.server_seed), clientSeed: u.client_seed, nonce },
    };
  });
}

// История апгрейдов игрока; если сид уже раскрыт — отдаём его для проверки
export async function listUpgrades(userId, limit = 30) {
  const db = await getDb();
  return db.query(
    `select u.id, u.input_value, u.target_hash_name, u.target_price, u.chance_ppm, u.roll, u.won,
            u.server_seed_hash, u.client_seed, u.nonce, u.created_at, s.server_seed
     from upgrades u left join seeds s on s.server_seed_hash = u.server_seed_hash
     where u.user_id = $1 order by u.id desc limit $2`,
    [userId, limit],
  );
}

// Лента последних побед (публичная, без личных данных кроме ника)
export async function recentWins(limit = 12) {
  const db = await getDb();
  const rows = await db.query(
    `select up.id, up.chance_ppm, up.input_value, up.created_at, us.name as user_name, i.*
     from upgrades up join users us on us.id = up.user_id join items i on i.hash_name = up.target_hash_name
     where up.won order by up.id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, chance: r.chance_ppm, inputValue: r.input_value, user: r.user_name, at: r.created_at, item: publicItem(r) }));
}
