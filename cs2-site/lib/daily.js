// Ежедневные награды: поставил за день (по Москве) от dailyNeed — забираешь награду.
// Награда растёт с серией: dailyBase, +dailyStep за каждый день подряд, но не больше dailyMax.
// Пропустил день — серия начинается заново. Ставки считаются по всем режимам: кейсы, апгрейд (баланс и скины), казино.

import { getDb } from './db.js';
import { fail } from './http.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { floorLc, fmtLc } from './lc.js';

const MSK = 3 * 3600_000;
export const mskDay = (t = Date.now()) => new Date(t + MSK).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - MSK);
const prevDay = (day) => mskDay(Date.parse(`${day}T12:00:00Z`) - 24 * 3600_000 - MSK);

export const rewardFor = (streak, s) => floorLc(Math.min(s.dailyBase + s.dailyStep * (streak - 1), s.dailyMax));

// Сколько игрок поставил с начала дня (сотые LC)
async function wageredSince(q, userId, since) {
  const r = await q.one(
    `select
       (select coalesce(sum(-amount), 0)::bigint from ledger where user_id = $1 and created_at >= $2 and amount < 0 and kind in ('case', 'casino', 'upgrade')) +
       (select coalesce(sum(input_value - input_balance), 0)::bigint from upgrades where user_id = $1 and created_at >= $2) as total`,
    [userId, since],
  );
  return Number(r.total);
}

async function state(q, userId, s, now = Date.now()) {
  const day = mskDay(now);
  const last = await q.one('select day, streak, amount from daily_rewards where user_id = $1 order by day desc limit 1', [userId]);
  const claimedToday = last?.day === day;
  const streak = claimedToday ? last.streak : last?.day === prevDay(day) ? last.streak + 1 : 1;
  const wagered = await wageredSince(q, userId, dayStart(day));
  return {
    day, claimed: claimedToday, streak, reward: claimedToday ? last.amount : rewardFor(streak, s),
    wagered, need: s.dailyNeed, ready: !claimedToday && wagered >= s.dailyNeed,
    // Что дадут в следующие 7 дней, если не пропускать
    upcoming: Array.from({ length: 7 }, (_, i) => rewardFor(streak + i + (claimedToday ? 1 : 0), s)),
    resetsAt: new Date(dayStart(day).getTime() + 24 * 3600_000).toISOString(),
  };
}

export async function getDaily(userId) {
  const s = await getSettings();
  return state(await getDb(), userId, s);
}

export async function claimDaily(userId) {
  const s = await getSettings();
  const db = await getDb();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const st = await state(q, userId, s);
    if (st.claimed) fail(409, 'Награда за сегодня уже получена — приходи завтра');
    if (st.wagered < st.need) fail(400, `Поставь ещё ${fmtLc(st.need - st.wagered)} сегодня, чтобы забрать награду`);
    await q.query('insert into daily_rewards (user_id, day, streak, amount) values ($1, $2, $3, $4)', [userId, st.day, st.streak, st.reward]);
    const balance = await changeBalance(q, userId, st.reward, 'bonus', { ref: `daily:${st.day}`, note: `Ежедневная награда · день ${st.streak}` });
    return { ...st, claimed: true, ready: false, balance, upcoming: st.upcoming.slice(1).concat(rewardFor(st.streak + 7, s)) };
  });
}
