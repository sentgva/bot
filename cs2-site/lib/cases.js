// Кейсы: фиксированная цена, внутри — реальные скины каталога с открытыми шансами.
//
//   • Состав кейса — группы фильтров по каталогу (оружие, редкость, цена). Из каждой группы берём n скинов,
//     равномерно по цене, чтобы были и дешёвые, и дорогие.
//   • Шансы подбираются так, чтобы средняя стоимость дропа была ровно цена × (1 − caseEdge):
//     вероятность скина ∝ цена^(−k), k ищем бисекцией. Цены каталога меняются — шансы пересчитываются сами,
//     а край сервиса остаётся тем же. Шансы показываются игроку до открытия.
//   • Бросок — тот же HMAC-SHA256(server_seed, client_seed:nonce), что и в апгрейдере (lib/fair.js).

import { getDb } from './db.js';
import { fail } from './http.js';
import { publicItem } from './catalog.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { ROLL_MAX, computeRoll, hashSeed } from './fair.js';
import { sellPrice } from './inventory.js';

const LC = 100; // сотых долей в 1 LC
const PISTOLS = ['Glock-18', 'USP-S', 'P2000', 'P250', 'Five-SeveN', 'Tec-9', 'CZ75-Auto', 'Desert Eagle', 'Dual Berettas', 'R8 Revolver'];
const SMGS = ['MP9', 'MAC-10', 'UMP-45', 'P90', 'MP7', 'PP-Bizon', 'MP5-SD'];
const RIFLES = ['AK-47', 'M4A4', 'M4A1-S'];
const SNIPERS = ['AWP', 'SSG 08', 'SCAR-20', 'G3SG1'];

// where — SQL-условие по таблице items (только константы из кода, без ввода игрока); min/max — цена в LC
export const CASES = [
  { slug: 'bratan', name: 'Братан', fresh: true, price: 19, color: '#f97316', groups: [{ where: "rarity <> 'gold'", min: 2, max: 250, n: 14 }] },
  { slug: 'starter', name: 'Стартовый', price: 29, color: '#7d9cc0', groups: [{ where: "rarity <> 'gold'", min: 3, max: 400, n: 14 }] },
  { slug: 'smg', name: 'Пулемётчик', price: 49, color: '#8847ff', groups: [{ where: 'weapon = any($weapons)', weapons: SMGS, min: 4, max: 2500, n: 14 }] },
  { slug: 'pistol', name: 'Пистолетный', price: 69, color: '#4b69ff', groups: [{ where: 'weapon = any($weapons)', weapons: PISTOLS, min: 5, max: 4000, n: 14 }] },
  { slug: 'kobildzhon', name: 'Кобилджон', fresh: true, price: 119, color: '#84cc16', groups: [{ where: 'weapon = any($weapons)', weapons: ['AWP', 'Desert Eagle'], min: 7, max: 10000, n: 14 }] },
  { slug: 'rifle', name: 'Калаш и эмка', price: 149, color: '#d32ce6', groups: [{ where: 'weapon = any($weapons)', weapons: RIFLES, min: 10, max: 12000, n: 14 }] },
  { slug: 'sniper', name: 'Снайперский', price: 249, color: '#2fb37a', groups: [{ where: 'weapon = any($weapons)', weapons: SNIPERS, min: 10, max: 30000, n: 14 }] },
  { slug: 'factory', name: 'С завода', price: 299, color: '#38bdf8', groups: [{ where: "wear = 'Factory New' and rarity <> 'gold'", min: 20, max: 25000, n: 14 }] },
  { slug: 'stattrak', name: 'StatTrak™', price: 399, color: '#cf6a32', groups: [{ where: "stattrak and rarity <> 'gold'", min: 30, max: 30000, n: 14 }] },
  {
    slug: 'pantera', name: 'Пантера', fresh: true, price: 549, color: '#a855f7',
    groups: [
      { where: "rarity <> 'gold' and name ~* '(black|night|dark|onyx|obsidian|shadow|noir|midnight|panther|graphite|carbon)'", min: 10, max: 32000, n: 12 },
      { where: "rarity = 'gold' and name ~* '(night|black|ultraviolet|dark|shadow)'", min: 3000, max: 40000, n: 3 },
    ],
  },
  {
    slug: 'covert', name: 'Тайный', price: 790, color: '#eb4b4b',
    groups: [{ where: "rarity = 'covert'", min: 500, max: 45000, n: 10 }, { where: "rarity = 'classified'", min: 60, max: 600, n: 6 }],
  },
  {
    slug: 'koch', name: 'Коч', fresh: true, price: 1490, color: '#22d3ee',
    groups: [{ where: "rarity = 'gold' and (weapon ilike '%gloves%' or weapon = 'Hand Wraps')", min: 1700, max: 30000, n: 8 }, { where: "rarity in ('covert', 'classified')", min: 50, max: 1500, n: 8 }],
  },
  {
    slug: 'knife', name: 'Ножевой', price: 2990, color: '#e4ae39',
    groups: [{ where: "rarity = 'gold'", min: 3000, max: 70000, n: 8 }, { where: "rarity in ('covert', 'classified')", min: 100, max: 2500, n: 8 }],
  },
  {
    slug: 'luxe', name: 'Люкс', price: 9990, color: '#f5d76e',
    groups: [{ where: "rarity = 'gold'", min: 10000, max: 150000, n: 8 }, { where: "rarity in ('covert', 'gold')", min: 500, max: 8000, n: 8 }],
  },
];
const BY_SLUG = new Map(CASES.map((c) => [c.slug, c]));

// Скины группы: n штук равномерно по цене (самый дешёвый и самый дорогой — всегда)
async function groupItems(q, g) {
  const where = g.where.replace('$weapons', '$3');
  const params = [g.min * LC, g.max * LC];
  if (g.weapons) params.push(g.weapons);
  const rows = await q.query(
    `select * from items where quantity > 0 and image is not null and price between $1 and $2 and (${where})
     order by price asc, hash_name asc`,
    params,
  );
  if (rows.length <= g.n) return rows;
  const picked = new Set();
  for (let i = 0; i < g.n; i++) picked.add(Math.round((i * (rows.length - 1)) / (g.n - 1)));
  return [...picked].map((i) => rows[i]);
}

// Шансы в миллионных долях (сумма ровно 1 000 000), средняя стоимость ≈ target. null — подобрать нельзя.
export function solveOdds(prices, target) {
  if (prices.length < 3) return null;
  const min = Math.min(...prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (!(min < target && target < mean)) return null;
  const ev = (k) => {
    const w = prices.map((p) => (p / min) ** -k);
    const sum = w.reduce((a, b) => a + b, 0);
    return w.reduce((acc, wi, i) => acc + (wi / sum) * prices[i], 0);
  };
  let lo = 0;
  let hi = 1;
  while (ev(hi) > target && hi < 64) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ev(mid) > target) lo = mid; else hi = mid;
  }
  const w = prices.map((p) => (p / min) ** -hi);
  const sum = w.reduce((a, b) => a + b, 0);
  // Каждому скину — хотя бы 1 ppm (0,0001%), остаток округления — самому дешёвому
  const ppm = w.map((wi) => Math.max(1, Math.floor((wi / sum) * ROLL_MAX)));
  const cheapest = prices.indexOf(min);
  ppm[cheapest] += ROLL_MAX - ppm.reduce((a, b) => a + b, 0);
  return ppm;
}

async function buildCase(q, def, edge) {
  const seen = new Set();
  const rows = [];
  for (const g of def.groups) {
    for (const r of await groupItems(q, g)) if (!seen.has(r.hash_name)) { seen.add(r.hash_name); rows.push(r); }
  }
  const price = def.price * LC;
  const ppm = solveOdds(rows.map((r) => r.price), price * (1 - edge));
  if (!ppm) return null;
  const items = rows.map((r, i) => ({ row: r, ppm: ppm[i] })).sort((a, b) => b.row.price - a.row.price);
  return { slug: def.slug, name: def.name, price, color: def.color, fresh: Boolean(def.fresh), items };
}

const pub = (c) => ({
  slug: c.slug, name: c.name, price: c.price, color: c.color, fresh: c.fresh,
  items: c.items.map(({ row, ppm }) => ({ ...publicItem(row), ppm })),
});

// Кэш на минуту: состав и шансы зависят только от цен каталога
let cache = { at: 0, edge: null, list: null };
export async function listCases() {
  const s = await getSettings();
  if (cache.list && cache.edge === s.caseEdge && Date.now() - cache.at < 60_000) return cache.list;
  const db = await getDb();
  const list = [];
  for (const def of CASES) {
    const c = await buildCase(db, def, s.caseEdge);
    if (c) list.push(pub(c));
  }
  cache = { at: Date.now(), edge: s.caseEdge, list };
  return list;
}
export function resetCasesCache() { cache = { at: 0, edge: null, list: null }; }

export async function getCase(slug) {
  const c = (await listCases()).find((x) => x.slug === slug);
  if (!c) fail(404, 'Кейс не найден');
  return c;
}

export async function openCase(userId, slug) {
  const def = BY_SLUG.get(slug);
  if (!def) fail(404, 'Кейс не найден');
  const s = await getSettings();
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const c = await buildCase(q, def, s.caseEdge);
    if (!c) fail(503, 'Кейс временно недоступен');
    if (u.balance < c.price) fail(400, 'Недостаточно LC на балансе');

    const nonce = u.nonce;
    const roll = computeRoll(u.server_seed, u.client_seed, nonce);
    let acc = 0;
    let drop = c.items[c.items.length - 1];
    // Сначала дешёвые: так бросок 0…N соответствует самому частому скину
    for (const it of [...c.items].reverse()) {
      acc += it.ppm;
      if (roll < acc) { drop = it; break; }
    }

    await q.query('update users set nonce = nonce + 1 where id = $1', [userId]);
    const userItemId = (await q.one(
      `insert into user_items (user_id, hash_name, price, source) values ($1, $2, $3, 'case') returning id`,
      [userId, drop.row.hash_name, drop.row.price],
    )).id;
    const open = await q.one(
      `insert into case_opens (user_id, case_slug, case_price, hash_name, item_price, chance_ppm, roll, server_seed_hash, client_seed, nonce, user_item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [userId, c.slug, c.price, drop.row.hash_name, drop.row.price, drop.ppm, roll, hashSeed(u.server_seed), u.client_seed, nonce, userItemId],
    );
    const balance = await changeBalance(q, userId, -c.price, 'case', { ref: `case:${open.id}`, note: `Кейс «${c.name}»` });
    return {
      id: open.id,
      item: { ...publicItem(drop.row), ppm: drop.ppm },
      userItemId,
      sellPrice: sellPrice(drop.row.price, s),
      roll,
      balance,
    };
  });
}

// Последние заносы из кейсов для живой ленты: дроп дороже цены кейса
export async function recentCaseDrops(limit = 20) {
  const db = await getDb();
  const rows = await db.query(
    `select co.id, co.chance_ppm, co.case_price, co.created_at, us.name as user_name, i.*
     from case_opens co join users us on us.id = co.user_id join items i on i.hash_name = co.hash_name
     where co.item_price > co.case_price order by co.id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({ id: `c${r.id}`, chance: r.chance_ppm, inputValue: r.case_price, user: r.user_name, at: r.created_at, item: publicItem(r) }));
}
