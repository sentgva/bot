// Рефералы: у каждого игрока своя ссылка. Кто пришёл по ней (при первом входе), навсегда закреплён за пригласившим.
// Пригласивший получает refPercent от каждого настоящего пополнения друга (звёзды, крипта),
// новичок — refInviteeBonus LC сверху стартового бонуса. Оба значения настраиваются в админке.
//
// Код — номер игрока в base36 со сдвигом (не секрет: по нему только засчитывают приглашение).

import { config } from './config.js';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { changeBalance } from './users.js';
import { floorLc } from './lc.js';

const OFFSET = 100_000;
export const refCode = (userId) => (Number(userId) + OFFSET).toString(36).toUpperCase();
export function refUserId(code) {
  if (typeof code !== 'string' || !/^[0-9A-Z]{2,12}$/i.test(code)) return null;
  const id = parseInt(code, 36) - OFFSET;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const refLinks = (userId) => ({
  code: refCode(userId),
  site: `${config.siteUrl}/?ref=${refCode(userId)}`,
  bot: config.tgBotUsername ? `https://t.me/${config.tgBotUsername}?start=${refCode(userId)}` : null,
});

// Новый игрок: закрепить за пригласившим и выдать бонус новичку (вызывается в транзакции регистрации)
export async function attachReferrer(q, newUserId, code) {
  const referrer = refUserId(code);
  if (!referrer || referrer === newUserId) return null;
  const exists = await q.one('select id from users where id = $1', [referrer]);
  if (!exists) return null;
  await q.query('update users set referred_by = $2 where id = $1 and referred_by is null', [newUserId, referrer]);
  const s = await getSettings();
  const bonus = floorLc(s.refInviteeBonus);
  if (bonus > 0) await changeBalance(q, newUserId, bonus, 'bonus', { note: 'Бонус за приглашение' });
  return referrer;
}

// Пополнение прошло: процент пригласившему (в той же транзакции, что и зачисление)
export async function rewardReferrer(q, userId, amount, paymentRef) {
  const u = await q.one('select referred_by from users where id = $1', [userId]);
  if (!u?.referred_by) return 0;
  const s = await getSettings();
  const reward = floorLc(Math.floor(amount * s.refPercent));
  if (reward <= 0) return 0;
  await changeBalance(q, u.referred_by, reward, 'referral', { ref: paymentRef, note: `${Math.round(s.refPercent * 100)}% от пополнения друга` });
  return reward;
}

export async function referralStats(userId) {
  const db = await getDb();
  const s = await getSettings();
  const st = await db.one(
    `select (select count(*) from users where referred_by = $1)::int as invited,
            (select coalesce(sum(amount), 0)::bigint from ledger where user_id = $1 and kind = 'referral') as earned`,
    [userId],
  );
  return { ...refLinks(userId), ...st, percent: s.refPercent, inviteeBonus: s.refInviteeBonus };
}
