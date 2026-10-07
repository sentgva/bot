// Запросы для админки. Доступ проверяется в lib/app.js (requireAdmin: ADMIN_TG_IDS / ADMIN_TG_USERNAMES).

import { getDb } from './db.js';
import { config } from './config.js';
import { fail } from './http.js';
import { changeBalance, isOwner } from './users.js';
import { isWholeLc } from './lc.js';
import { revealCard } from './payments.js';

export async function overview() {
  const db = await getDb();
  return db.one(`
    select
      (select count(*) from payments where direction = 'out' and status in ('review', 'sending'))::int as withdrawals,
      (select count(*) from skin_withdrawals where status = 'review')::int as skin_withdrawals,
      (select count(*) from users)::int as users,
      (select coalesce(sum(balance), 0)::bigint from users) as total_balance,
      (select coalesce(sum(amount), 0)::bigint from payments where direction = 'in' and status = 'paid' and method <> 'demo') as deposits,
      (select coalesce(sum(amount - fee), 0)::bigint from payments where direction = 'out' and status = 'paid') as payouts,
      (select count(*) from users where created_at > now() - interval '24 hours')::int as users_day,
      (select count(*) from case_opens)::int as cases_opened,
      (select coalesce(sum(case_price - item_price), 0)::bigint from case_opens) as cases_profit,
      (select count(*) from upgrades)::int as upgrades,
      (select coalesce(sum(input_value), 0)::bigint - coalesce(sum(target_price) filter (where won), 0)::bigint from upgrades) as upgrades_profit,
      (select coalesce(sum(amount), 0)::bigint from ledger where kind in ('admin', 'bonus') and amount > 0) as granted,
      (select count(*) from tickets t where t.status = 'open'
         and (select sender from ticket_messages m where m.ticket_id = t.id order by m.id desc limit 1) = 'user')::int as tickets
  `);
}

export async function listWithdrawals(status = 'open') {
  const db = await getDb();
  const statuses = status === 'open' ? ['review', 'processing', 'sending'] : ['paid', 'rejected'];
  const rows = await db.query(
    `select p.*, u.name as user_name, u.telegram_id, u.tg_username from payments p join users u on u.id = p.user_id
     where p.direction = 'out' and p.status = any($1) order by p.id ${status === 'open' ? 'asc' : 'desc'} limit 100`,
    [statuses],
  );
  return rows.map(({ details, ...r }) => {
    const { cardEnc, ...rest } = details || {};
    // Полный номер карты админ видит только у открытых заявок
    let cardFull = null;
    if (cardEnc) { try { cardFull = revealCard(details); } catch { cardFull = 'не расшифровать: проверь DATA_KEY'; } }
    return { ...r, details: { ...rest, cardFull } };
  });
}

export async function listSkinWithdrawals(status = 'open') {
  const db = await getDb();
  return db.query(
    `select w.*, u.name as user_name, u.telegram_id, u.tg_username from skin_withdrawals w join users u on u.id = w.user_id
     where w.status = any($1) order by w.id ${status === 'open' ? 'asc' : 'desc'} limit 100`,
    [status === 'open' ? ['review', 'processing'] : ['sent', 'refunded']],
  );
}

export async function findUsers(query) {
  const db = await getDb();
  const q = String(query || '').trim();
  const cols = 'id, telegram_id, tg_username, name, avatar, balance, is_banned, is_admin, trade_url, created_at, last_seen_at';
  // «admins» — список админов: назначенные в панели и владельцы из настроек
  const rows = q === 'admins'
    ? await db.query(
      `select ${cols} from users where is_admin or telegram_id = any($1) or lower(tg_username) = any($2) order by last_seen_at desc limit 100`,
      [config.adminTgIds, config.adminTgUsernames],
    )
    : await db.query(
      `select ${cols} from users
       where $1 = '' or telegram_id = $1 or tg_username = ltrim($1, '@') or name ilike $2 or id::text = $1
       order by last_seen_at desc limit 50`,
      [q, `%${q.replace(/[%_\\]/g, '\\$&')}%`],
    );
  return rows.map((r) => ({ ...r, is_owner: isOwner(r) }));
}

// Карточка игрока: профиль, сводка и последние операции по балансу
export async function userDetail(id) {
  const db = await getDb();
  const user = await db.one(
    `select u.id, u.telegram_id, u.tg_username, u.name, u.avatar, u.balance, u.is_banned, u.is_admin, u.trade_url, u.created_at, u.last_seen_at,
            r.id as referrer_id, r.name as referrer_name
     from users u left join users r on r.id = u.referred_by where u.id = $1`,
    [id],
  );
  if (!user) fail(404, 'Пользователь не найден');
  user.is_owner = isOwner(user);
  const stats = await db.one(`
    select
      (select coalesce(sum(amount), 0)::bigint from payments where user_id = $1 and direction = 'in' and status = 'paid' and method <> 'demo') as deposits,
      (select coalesce(sum(amount), 0)::bigint from payments where user_id = $1 and direction = 'out' and status = 'paid') as withdrawn,
      (select coalesce(sum(amount), 0)::bigint from ledger where user_id = $1 and kind in ('admin', 'bonus') and amount > 0) as granted,
      (select count(*) from upgrades where user_id = $1)::int as upgrades,
      (select count(*) from upgrades where user_id = $1 and won)::int as upgrades_won,
      (select count(*) from case_opens where user_id = $1)::int as cases,
      (select count(*) from users where referred_by = $1)::int as invited,
      (select coalesce(sum(amount), 0)::bigint from ledger where user_id = $1 and kind = 'referral') as ref_earned,
      (select count(*) from user_items where user_id = $1 and status = 'owned')::int as items,
      (select coalesce(sum(price), 0)::bigint from user_items where user_id = $1 and status = 'owned') as items_value`, [id]);
  const ledger = await db.query(
    'select id, amount, balance_after, kind, note, created_at from ledger where user_id = $1 order by id desc limit 40',
    [id],
  );
  return { user, stats, ledger };
}

export async function updateUser(id, { action, amount, note }, actor = null) {
  const db = await getDb();
  // Выдать или снять админку может только владелец
  if (action === 'make_admin' || action === 'remove_admin') {
    if (!isOwner(actor)) fail(403, 'Выдавать и снимать админку может только владелец');
    const target = await db.one('select * from users where id = $1', [id]);
    if (!target) fail(404, 'Пользователь не найден');
    if (action === 'remove_admin' && isOwner(target)) fail(400, 'Владельца нельзя лишить прав из панели — он задан в настройках Vercel');
    await db.query('update users set is_admin = $2 where id = $1', [id, action === 'make_admin']);
    return { id, isAdmin: action === 'make_admin' || isOwner(target) };
  }
  if (action === 'ban' || action === 'unban') {
    if (action === 'ban') {
      const target = await db.one('select * from users where id = $1', [id]);
      if (isOwner(target)) fail(400, 'Владельца забанить нельзя');
      if (target?.is_admin && !isOwner(actor)) fail(403, 'Админа может забанить только владелец');
    }
    const r = await db.one('update users set is_banned = $2 where id = $1 returning id', [id, action === 'ban']);
    if (!r) fail(404, 'Пользователь не найден');
    return { id };
  }
  if (action === 'adjust') {
    if (!Number.isSafeInteger(amount) || amount === 0) fail(400, 'Укажи сумму');
    if (!isWholeLc(amount)) fail(400, 'Сумма — целое число LC');
    if (Math.abs(amount) > 100_000_000) fail(400, 'Не больше 1 000 000 LC за раз');
    if (!note) fail(400, 'Укажи причину корректировки');
    return db.tx(async (q) => {
      const u = await q.one('select id from users where id = $1 for update', [id]);
      if (!u) fail(404, 'Пользователь не найден');
      return { id, balance: await changeBalance(q, id, amount, 'admin', { note }) };
    });
  }
  fail(400, 'Неизвестное действие');
}
