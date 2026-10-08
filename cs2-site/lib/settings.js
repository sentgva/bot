// Бизнес-настройки: комиссии, наценки, лимиты. Хранятся в таблице settings, админ меняет их в /admin/.
// Если ключа в базе нет — берётся значение по умолчанию.

import { getDb } from './db.js';

export const DEFAULTS = {
  houseEdge: 0.05,          // край сервиса в апгрейдере: шанс = вход / цель × (1 − houseEdge)
  maxChance: 0.8,           // максимум шанса апгрейда
  minChance: 0,             // минимум шанса апгрейда (0 — можно ставить на любой скин, хоть 10 LC на 100 000 LC)
  maxUpgradeItems: 6,       // сколько скинов можно поставить в один апгрейд
  minUpgradeValue: 1000,    // минимальная ставка апгрейда, сотые LC (10 ₽)
  marketMarkup: 0.05,       // наценка маркета к рыночной цене
  siteSellRate: 0.95,       // продажа скина с сайта на баланс (доля от рыночной цены)
  cardFee: 0.03,            // комиссия вывода на карту / СБП
  cryptoFee: 0,             // комиссия вывода в крипту
  minWithdraw: 50000,       // минимальный вывод, сотые LC (500 ₽)
  maxWithdraw: 30000000,    // максимальный вывод за раз, сотые LC (300 000 ₽)
  minDeposit: 10000,        // минимальное пополнение, сотые LC (100 ₽)
  cryptoAutoLimit: 2000000, // крипто-вывод до этой суммы уходит автоматически, выше — на проверку
  statsMinPaid: 10000000,   // показывать «выплачено» на главной, только когда больше этого (100 000 ₽)
  bestDropMaxPrice: 15000000, // «лучший дроп» на главной — не дороже этого, сотые LC (150 000 LC)
  lcPerStar: 1.3,           // курс: сколько LC за 1 звезду Telegram (результат округляется вниз)
  minStars: 50,             // минимальное пополнение звёздами
  maxStars: 100000,         // максимальное пополнение звёздами за раз
  caseEdge: 0.1,
  contractEdge: 0.1,        // контракты: средний результат = вклад × (1 − contractEdge)
  contractMinMult: 0.25,    // контракты: самый дешёвый возможный результат — вклад × это число
  contractMaxMult: 4,       // контракты: самый дорогой — вклад × это число
  contractMinItems: 3,      // контракты: сколько скинов минимум
  contractMaxItems: 10,     // и максимум            // край сервиса в кейсах: средний дроп = цена кейса × (1 − caseEdge)
  refPercent: 0.1,          // рефералы: доля от пополнений друга, которую получает пригласивший
  refInviteeBonus: 0,       // рефералы: бонус новичку, пришедшему по ссылке, сотые LC
  casinoEdge: 0.05,         // казино (ракетка, мины, кости): средний возврат = ставка × (1 − casinoEdge)
  casinoMinBet: 100,        // казино: минимальная ставка, сотые LC (1 LC)
  casinoMaxBet: 100000000,  // казино: максимальная ставка, сотые LC (1 000 000 LC)
  casinoMaxWin: 100000000000, // казино: максимальный выигрыш за игру, сотые LC (1 000 000 000 LC)
  depositBonus: 0,          // акция: +N к каждому пополнению звёздами (0,1 = +10%); 0 — выключена
  depositBonusUntil: 0,     // акция действует до этого момента (мс с 1970 г.); 0 — пока не выключат
  signupBonus: 100000,      // стартовый бонус новому игроку при первом входе, сотые LC (1 000 LC); 0 — выключен
};

// Границы, чтобы опечатка в админке не сломала экономику
const LIMITS = {
  houseEdge: [0, 0.25], maxChance: [0.2, 1], minChance: [0, 0.5], maxUpgradeItems: [1, 20],
  minUpgradeValue: [100, 10_000_000], marketMarkup: [0, 1], siteSellRate: [0.1, 1],
  cardFee: [0, 0.5], cryptoFee: [0, 0.5], minWithdraw: [100, 100_000_000], maxWithdraw: [100, 1_000_000_000],
  minDeposit: [100, 100_000_000], cryptoAutoLimit: [0, 1_000_000_000], statsMinPaid: [0, 1e12], bestDropMaxPrice: [10_000, 1e12],
  lcPerStar: [0.01, 100], minStars: [1, 100_000], maxStars: [1, 1_000_000], signupBonus: [0, 100_000_000], refPercent: [0, 0.5], refInviteeBonus: [0, 100_000_000], caseEdge: [0.01, 0.5], contractEdge: [0.01, 0.5], contractMinMult: [0.05, 0.9], contractMaxMult: [1.5, 20], contractMinItems: [1, 10], contractMaxItems: [2, 20],
  casinoEdge: [0.01, 0.25], casinoMinBet: [100, 10_000_000], casinoMaxBet: [100, 100_000_000_000], casinoMaxWin: [10_000, 100_000_000_000],
  depositBonus: [0, 1], depositBonusUntil: [0, 1e14],
};

// Акция на пополнение сейчас: доля бонуса (0 — нет) и до какого момента
export function depositBonusNow(s, now = Date.now()) {
  const on = s.depositBonus > 0 && (!s.depositBonusUntil || now < s.depositBonusUntil);
  return on ? { percent: s.depositBonus, until: s.depositBonusUntil || null } : null;
}

let cache = { at: 0, value: null };

export async function getSettings() {
  if (cache.value && Date.now() - cache.at < 30_000) return cache.value;
  const db = await getDb();
  const rows = await db.query('select key, value from settings');
  const value = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && typeof r.value === 'number') value[r.key] = r.value;
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(patch) {
  const db = await getDb();
  const errors = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    const v = Number(raw);
    const [min, max] = LIMITS[key];
    if (!Number.isFinite(v) || v < min || v > max) { errors[key] = `от ${min} до ${max}`; continue; }
    await db.query(
      'insert into settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
      [key, JSON.stringify(v)],
    );
  }
  cache = { at: 0, value: null };
  return { settings: await getSettings(), errors };
}
