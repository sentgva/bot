// Промокоды: админ создаёт код на сумму LC с лимитом активаций и сроком; игрок активирует его один раз.

import { getDb } from './db.js';
import { fail } from './http.js';
import { changeBalance, lockUser } from './users.js';
import { isWholeLc } from './lc.js';

const normalize = (code) => String(code || '').trim().toUpperCase();
export const isValidCode = (code) => /^[A-Z0-9_-]{3,32}$/.test(code);

export async function createPromo({ code, amount, maxUses, days }) {
  code = normalize(code);
  if (!isValidCode(code)) fail(400, 'Код: 3–32 символа, латиница, цифры, - и _', { field: 'code' });
  if (!Number.isSafeInteger(amount) || amount <= 0 || !isWholeLc(amount)) fail(400, 'Сумма — целое число LC больше нуля', { field: 'amount' });
  if (amount > 100_000_000) fail(400, 'Не больше 1 000 000 LC за код', { field: 'amount' });
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) fail(400, 'Активаций — от 1 до 1 000 000', { field: 'maxUses' });
  if (days != null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) fail(400, 'Срок — от 1 до 3650 дней', { field: 'days' });
  const db = await getDb();
  const row = await db.one(
    `insert into promo_codes (code, amount, max_uses, expires_at) values ($1, $2, $3, case when $4::int is null then null else now() + make_interval(days => $4::int) end)
     on conflict (code) do nothing returning *`,
    [code, amount, maxUses, days ?? null],
  );
  if (!row) fail(409, 'Такой код уже есть', { field: 'code' });
  return row;
}

export async function listPromos() {
  const db = await getDb();
  return db.query('select * from promo_codes order by created_at desc limit 200');
}

export async function setPromoActive(code, active) {
  const db = await getDb();
  const row = await db.one('update promo_codes set active = $2 where code = $1 returning *', [normalize(code), Boolean(active)]);
  if (!row) fail(404, 'Промокод не найден');
  return row;
}

export async function redeemPromo(userId, rawCode) {
  const code = normalize(rawCode);
  if (!isValidCode(code)) fail(400, 'Проверь промокод', { field: 'code' });
  const db = await getDb();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const p = await q.one('select * from promo_codes where code = $1 for update', [code]);
    if (!p || !p.active) fail(404, 'Такого промокода нет или он выключен', { field: 'code' });
    if (p.expires_at && new Date(p.expires_at) < new Date()) fail(410, 'Срок действия промокода истёк', { field: 'code' });
    if (p.uses >= p.max_uses) fail(410, 'Промокод уже активировали максимальное число раз', { field: 'code' });
    const used = await q.one('insert into promo_redemptions (code, user_id) values ($1, $2) on conflict do nothing returning code', [code, userId]);
    if (!used) fail(409, 'Ты уже активировал этот промокод', { field: 'code' });
    await q.query('update promo_codes set uses = uses + 1 where code = $1', [code]);
    const balance = await changeBalance(q, userId, p.amount, 'promo', { ref: `promo:${code}`, note: `Промокод ${code}` });
    return { code, amount: p.amount, balance };
  });
}
