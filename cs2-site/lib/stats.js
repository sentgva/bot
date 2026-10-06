// Живые цифры для главной: считаются по базе, ничего не выдумываем.
// Пока выплат мало, «выплачено» не показываем (порог statsMinPaid в настройках) — фронт покажет факты о сервисе.

import { getDb } from './db.js';
import { getSettings } from './settings.js';

let cache = { at: 0, value: null };

export async function getStats() {
  if (cache.value && Date.now() - cache.at < 60_000) return cache.value;
  const db = await getDb();
  const s = await getSettings();
  const row = await db.one(`
    select
      (select count(*) from users)::int as users,
      (select count(*) from upgrades)::int as upgrades,
      (select coalesce(sum(amount - fee), 0)::bigint from payments where direction = 'out' and status = 'paid') as paid,
      (select percentile_cont(0.5) within group (order by extract(epoch from paid_at - created_at))::float8
         from payments where direction = 'out' and status = 'paid' and paid_at > now() - interval '30 days') as median_payout_sec,
      (select count(*) from payments where direction = 'out' and status = 'paid' and paid_at > now() - interval '30 days')::int as payouts_30d
  `);
  const value = {
    users: row.users,
    upgrades: row.upgrades,
    paid: row.paid >= s.statsMinPaid ? row.paid : null,
    // Медиана времени вывода — только когда есть на чём считать
    medianPayoutMinutes: row.payouts_30d >= 20 && row.median_payout_sec != null ? Math.max(1, Math.round(row.median_payout_sec / 60)) : null,
    maxChance: s.maxChance,
    cryptoFee: s.cryptoFee,
    cardFee: s.cardFee,
    siteSellRate: s.siteSellRate,
    minWithdraw: s.minWithdraw,
  };
  cache = { at: Date.now(), value };
  return value;
}
