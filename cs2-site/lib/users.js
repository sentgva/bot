// Пользователи и баланс.
// Любое изменение баланса идёт через changeBalance внутри транзакции: строка пользователя блокируется
// (select … for update), баланс не может уйти в минус (check в схеме), каждое движение пишется в ledger.

import { getDb } from './db.js';
import { fail } from './http.js';
import { hashSeed, newClientSeed, newServerSeed } from './fair.js';
import { getSettings } from './settings.js';
import { floorLc } from './lc.js';
import { config } from './config.js';

// Вход через Telegram (Mini App или Telegram Login на сайте): аккаунт привязан к Telegram ID
export async function upsertTelegramUser(tg, { ref = null } = {}) {
  const db = await getDb();
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 64) || tg.username || `Игрок ${String(tg.id).slice(-5)}`;
  const { signupBonus } = await getSettings();
  return db.tx(async (q) => {
    // xmax = 0 — строка только что вставлена, то есть это первый вход игрока
    const u = await q.one(
      `insert into users (telegram_id, tg_username, name, avatar, server_seed, client_seed)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (telegram_id) do update set tg_username = excluded.tg_username, name = excluded.name,
         avatar = coalesce(excluded.avatar, users.avatar), last_seen_at = now()
       returning *, (xmax = 0) as inserted`,
      [String(tg.id), tg.username || null, name, typeof tg.photo_url === 'string' && tg.photo_url.startsWith('https://') ? tg.photo_url : null, newServerSeed(), newClientSeed()],
    );
    const { inserted, ...user } = u;
    // Стартовый бонус новому игроку (настройка signupBonus в админке, 0 — выключен)
    const bonus = floorLc(signupBonus);
    if (inserted && bonus > 0) user.balance = await changeBalance(q, user.id, bonus, 'bonus', { note: 'Стартовый бонус' });
    if (inserted && ref) {
      const { attachReferrer } = await import('./referrals.js'); // ленивый импорт: referrals.js сам импортирует users.js
      if (await attachReferrer(q, user.id, ref)) Object.assign(user, await q.one('select balance, referred_by from users where id = $1', [user.id]));
    }
    return user;
  });
}

// Владелец — Telegram ID из ADMIN_TG_IDS или ник из ADMIN_TG_USERNAMES: может назначать и снимать админов.
// Админ — владелец или игрок, которому владелец выдал права в админ-панели (users.is_admin).
export const isOwner = (u) => Boolean(u?.telegram_id) && (config.adminTgIds.includes(String(u.telegram_id))
  || (Boolean(u.tg_username) && config.adminTgUsernames.includes(String(u.tg_username).toLowerCase())));
export const isAdmin = (u) => isOwner(u) || Boolean(u?.is_admin);

export async function getUser(id) {
  if (!id) return null;
  const db = await getDb();
  return db.one('select * from users where id = $1', [id]);
}

// То, что видит сам игрок (серверный сид — только хэш!)
export const publicUser = (u) => ({
  id: u.id,
  telegram: u.telegram_id ? { id: u.telegram_id, username: u.tg_username } : null,
  name: u.name,
  avatar: u.avatar,
  balance: u.balance,
  tradeUrl: u.trade_url,
  isAdmin: isAdmin(u),
  isOwner: isOwner(u),
  fair: { serverSeedHash: hashSeed(u.server_seed), clientSeed: u.client_seed, nonce: u.nonce },
});

// Заблокировать строку пользователя в транзакции
export async function lockUser(q, userId) {
  const u = await q.one('select * from users where id = $1 for update', [userId]);
  if (!u) fail(401, 'Войди через Steam');
  if (u.is_banned) fail(403, 'Аккаунт заблокирован. Напиши в поддержку');
  return u;
}

// amount > 0 — зачисление, < 0 — списание. Возвращает новый баланс.
export async function changeBalance(q, userId, amount, kind, { ref = null, note = null } = {}) {
  if (!Number.isSafeInteger(amount) || amount === 0) return null;
  const row = await q.one(
    'update users set balance = balance + $2 where id = $1 and balance + $2 >= 0 returning balance',
    [userId, amount],
  );
  if (!row) fail(400, 'Недостаточно средств на балансе');
  await q.query(
    'insert into ledger (user_id, amount, balance_after, kind, ref, note) values ($1, $2, $3, $4, $5, $6)',
    [userId, amount, row.balance, kind, ref, note],
  );
  return row.balance;
}

export async function setTradeUrl(userId, url) {
  const db = await getDb();
  await db.query('update users set trade_url = $2 where id = $1', [userId, url]);
}

export async function setClientSeed(userId, seed) {
  const db = await getDb();
  await db.query('update users set client_seed = $2 where id = $1', [userId, seed]);
}

// Смена серверного сида: старый раскрывается и сохраняется, чтобы игрок мог проверить прошлые броски
export async function rotateSeed(userId) {
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    await q.query(
      `insert into seeds (user_id, server_seed, server_seed_hash, client_seed, last_nonce) values ($1, $2, $3, $4, $5)
       on conflict (server_seed_hash) do nothing`,
      [userId, u.server_seed, hashSeed(u.server_seed), u.client_seed, u.nonce],
    );
    const next = newServerSeed();
    await q.query('update users set server_seed = $2, nonce = 0 where id = $1', [userId, next]);
    return { revealed: { serverSeed: u.server_seed, serverSeedHash: hashSeed(u.server_seed), clientSeed: u.client_seed, lastNonce: u.nonce }, serverSeedHash: hashSeed(next) };
  });
}

export async function ledgerOf(userId, limit = 50) {
  const db = await getDb();
  return db.query('select id, amount, balance_after, kind, ref, note, created_at from ledger where user_id = $1 order by id desc limit $2', [userId, limit]);
}
