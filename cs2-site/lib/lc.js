// LuxeCoin (LC) — валюта сайта. 1 LC = 1 ₽ рыночной стоимости скинов.
// В базе суммы хранятся в сотых долях LC (как копейки), но все цены, баланс и движения — целые LC:
// любая пересчитанная сумма округляется ВНИЗ до целого LC.

export const UNIT = 100; // сотых долей в 1 LC

export const floorLc = (v) => Math.floor(v / UNIT) * UNIT;
export const isWholeLc = (v) => Number.isSafeInteger(v) && v % UNIT === 0;
export const fmtLc = (v) => `${Math.floor(v / UNIT).toLocaleString('ru-RU')} LC`;

// Звёзды Telegram → LC по курсу из настроек (lcPerStar), вниз до целых LC
export const starsToLc = (stars, lcPerStar) => floorLc(Math.floor(stars * lcPerStar * UNIT));
