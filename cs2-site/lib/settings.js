// Бизнес-настройки: комиссии, наценки, лимиты. Хранятся в таблице settings, админ меняет их в /admin/.
// Если ключа в базе нет — берётся значение по умолчанию.

import { getDb } from './db.js';

export const DEFAULTS = {
  houseEdge: 0.05,          // край сервиса в апгрейдере: шанс = вход / цель × (1 − houseEdge)
  maxChance: 0.8,           // максимум шанса апгрейда
  minChance: 0.01,          // минимум шанса апгрейда
  maxUpgradeItems: 6,       // сколько скинов можно поставить в один апгрейд
  minUpgradeValue: 1000,    // минимальная ставка апгрейда, копейки (10 ₽)
  marketMarkup: 0.05,       // наценка маркета к рыночной цене
  siteSellRate: 0.95,       // продажа скина с сайта на баланс (доля от рыночной цены)
  buybackRate: 0.85,        // выкуп скинов из Steam (доля от рыночной цены)
  cardFee: 0.03,            // комиссия вывода на карту / СБП
  cryptoFee: 0,             // комиссия вывода в крипту
  minWithdraw: 50000,       // минимальный вывод, копейки (500 ₽)
  maxWithdraw: 30000000,    // максимальный вывод за раз, копейки (300 000 ₽)
  minDeposit: 10000,        // минимальное пополнение, копейки (100 ₽)
  cryptoAutoLimit: 2000000, // крипто-вывод до этой суммы уходит автоматически, выше — на проверку
  statsMinPaid: 10000000,   // показывать «выплачено» на главной, только когда больше этого (100 000 ₽)
};

// Границы, чтобы опечатка в админке не сломала экономику
const LIMITS = {
  houseEdge: [0, 0.5], maxChance: [0.05, 0.95], minChance: [0.0001, 0.5], maxUpgradeItems: [1, 20],
  minUpgradeValue: [100, 10_000_000], marketMarkup: [0, 1], siteSellRate: [0.1, 1], buybackRate: [0.1, 1],
  cardFee: [0, 0.5], cryptoFee: [0, 0.5], minWithdraw: [100, 100_000_000], maxWithdraw: [100, 1_000_000_000],
  minDeposit: [100, 100_000_000], cryptoAutoLimit: [0, 1_000_000_000], statsMinPaid: [0, 1e12],
};

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
