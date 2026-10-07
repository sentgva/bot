// Уровни игрока: Новичок → VIP → Gold → Platinum → Diamond → Obsidian.
//
// Опыт (очки) копится за активность. Больше всего — за пополнения, меньше — за игру (зависит от суммы):
//   • пополнение: 1 очко за 1 LC;
//   • апгрейд и кейсы: 0,1 очка за 1 LC ставки / цены кейса;
//   • контракт: 0,05 очка за 1 LC стоимости вложенных скинов.
// Бонусы уровня:
//   • deposit  — +N% LC к каждому пополнению звёздами;
//   • upgrade  — шанс апгрейда × (1 + N%), но не выше максимального;
//   • cashback — N% от цены открытых кейсов возвращается на баланс.
// Опыт хранится в сотых долях очка (как деньги в сотых LC), пороги — в очках.

export const XP_WEIGHT = { deposit: 1, upgrade: 0.1, case: 0.1, contract: 0.05 };

export const TIERS = [
  { key: 'newbie', name: 'Новичок', xp: 0, deposit: 0, upgrade: 0, cashback: 0 },
  { key: 'vip', name: 'VIP', xp: 500, deposit: 0.01, upgrade: 0.005, cashback: 0.005 },
  { key: 'gold', name: 'Gold', xp: 3_000, deposit: 0.02, upgrade: 0.01, cashback: 0.01 },
  { key: 'platinum', name: 'Platinum', xp: 15_000, deposit: 0.03, upgrade: 0.015, cashback: 0.015 },
  { key: 'diamond', name: 'Diamond', xp: 60_000, deposit: 0.04, upgrade: 0.02, cashback: 0.02 },
  { key: 'obsidian', name: 'Obsidian', xp: 200_000, deposit: 0.05, upgrade: 0.03, cashback: 0.03 },
];

// Уровень по опыту (xp — в сотых долях очка)
export function tierFor(xp) {
  const points = Math.floor(Number(xp || 0) / 100);
  let i = 0;
  while (i + 1 < TIERS.length && points >= TIERS[i + 1].xp) i++;
  return { index: i, ...TIERS[i] };
}

// Что видит игрок: уровень, очки, следующий уровень и прогресс к нему
export function vipInfo(u) {
  const xp = Number(u?.xp || 0);
  const t = tierFor(xp);
  const next = TIERS[t.index + 1] || null;
  const points = Math.floor(xp / 100);
  const progress = next ? Math.min(1, (points - t.xp) / (next.xp - t.xp)) : 1;
  return {
    level: t.index, key: t.key, name: t.name, points,
    bonus: { deposit: t.deposit, upgrade: t.upgrade, cashback: t.cashback },
    next: next ? { key: next.key, name: next.name, points: next.xp, left: next.xp - points } : null,
    progress,
  };
}

// Начислить опыт в транзакции: amount — сумма в сотых LC, kind — deposit | upgrade | case | contract.
// Возвращает уровень до и после (чтобы при желании поздравить с новым).
export async function addXp(q, userId, amount, kind) {
  const add = Math.floor(Math.max(0, Number(amount) || 0) * (XP_WEIGHT[kind] || 0));
  const row = await q.one('update users set xp = xp + $2 where id = $1 returning xp', [userId, add]);
  const after = tierFor(row?.xp);
  const before = tierFor(Number(row?.xp || 0) - add);
  return { added: add, before, after };
}
