// Каталог скинов и цены.
//
// Источники:
//   • Skinport public API — цены всех скинов CS2 одним запросом (кэш на их стороне 5 минут, лимит 8 запросов / 5 минут).
//     https://docs.skinport.com/items  (обязателен заголовок Accept-Encoding: br)
//   • ByMykel/CSGO-API — открытый JSON с картинками, редкостью и износом.
//     https://github.com/ByMykel/CSGO-API
// Метаданные обновляем раз в сутки, цены — раз в PRICE_TTL_MINUTES (по крону и «лениво» при запросах).

import fs from 'node:fs';
import { config } from './config.js';
import { getDb } from './db.js';
import { floorLc } from './lc.js';

const SKINPORT_URL = 'https://api.skinport.com/v1/items';
const META_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json';
const STICKERS_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json';
const MIN_PRICE = 500; // скины дешевле 5 ₽ не показываем
const MIN_LISTINGS = 2; // минимум лотов на Skinport, чтобы цене можно было верить
// Наклейки на Skinport продаются редко: берём рекомендованную цену и без лотов, но без явных выбросов
const STICKER_MIN_PRICE = 100;
const STICKER_MAX_UNLISTED = 5_000_000;
const META_VERSION = 2; // 2 — с наклейками
export const isSticker = (hashName) => hashName.startsWith('Sticker | ');

const WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const WEAR_RE = new RegExp(` \\((${WEARS.join('|')})\\)$`);

// Редкость по цвету Steam → наш ключ
const RARITY_BY_COLOR = {
  '#b0c3d9': 'consumer', '#5e98d9': 'industrial', '#4b69ff': 'milspec', '#8847ff': 'restricted',
  '#d32ce6': 'classified', '#eb4b4b': 'covert', '#e4ae39': 'gold', '#caab05': 'gold',
};
export const RARITIES = ['consumer', 'industrial', 'milspec', 'restricted', 'classified', 'covert', 'gold'];

export function splitHashName(hashName) {
  const m = hashName.match(WEAR_RE);
  return { name: m ? hashName.slice(0, m.index) : hashName, wear: m ? m[1] : null };
}

const toKop = (price) => {
  const rate = config.priceCurrency === 'RUB' ? 1 : config.usdRubRate;
  // Цена скина в LC (1 LC = 1 ₽), округление вниз до целого LC
  return rate > 0 && Number.isFinite(price) ? floorLc(Math.floor(price * rate * 100)) : 0;
};

export async function fetchSkinportPrices(fetchImpl = fetch) {
  const url = `${SKINPORT_URL}?app_id=730&currency=${config.priceCurrency}&tradable=0`;
  const res = await fetchImpl(url, { headers: { 'Accept-Encoding': 'br' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Skinport ответил ${res.status}`);
  const list = await res.json();
  const map = new Map();
  for (const it of list) {
    // Только скины, которые реально продаются (есть лоты), иначе «рекомендованная» цена бывает фантастической.
    // Берём меньшую из рекомендованной и минимальной цены лота — так цена ближе к реальной сделке.
    if (!it.market_hash_name) continue;
    const listed = (it.quantity || 0) >= MIN_LISTINGS;
    const sticker = isSticker(it.market_hash_name);
    if (!listed && !sticker) continue;
    const candidates = (listed ? [it.suggested_price, it.min_price] : [it.suggested_price]).filter((p) => Number.isFinite(p) && p > 0);
    if (!candidates.length) continue;
    const price = toKop(Math.min(...candidates));
    if (price < (sticker ? STICKER_MIN_PRICE : MIN_PRICE) || (!listed && price > STICKER_MAX_UNLISTED)) continue;
    // quantity > 0 — предмет есть в каталоге; у наклеек без лотов ставим 1
    map.set(it.market_hash_name, { price, quantity: Math.max(1, it.quantity || 0) });
  }
  return map;
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`CSGO-API ответил ${res.status}`);
  return res.json();
}

export async function fetchMetadata(fetchImpl = fetch) {
  const [list, stickers] = await Promise.all([fetchJson(META_URL, fetchImpl), fetchJson(STICKERS_URL, fetchImpl).catch(() => [])]);
  const map = new Map();
  for (const s of list) {
    const hashName = s.market_hash_name || s.name;
    if (!hashName) continue;
    const color = String(s.rarity?.color || '').toLowerCase();
    map.set(hashName, {
      weapon: s.weapon?.name || null,
      rarity: hashName.startsWith('★') ? 'gold' : RARITY_BY_COLOR[color] || null,
      rarityColor: color || null,
      image: s.image || null,
      stattrak: Boolean(s.stattrak) || hashName.includes('StatTrak™'),
    });
  }
  // Наклейки: редкость по цвету (High Grade → синий, Remarkable → фиолетовый, Exotic → розовый, Extraordinary → красный)
  for (const s of Array.isArray(stickers) ? stickers : []) {
    const hashName = s.market_hash_name;
    if (!hashName || !isSticker(hashName)) continue;
    const color = String(s.rarity?.color || '').toLowerCase();
    map.set(hashName, { weapon: 'Sticker', rarity: RARITY_BY_COLOR[color] || null, rarityColor: color || null, image: s.image || null, stattrak: false });
  }
  return map;
}

// Пакетная запись: один запрос на 500 строк
async function upsertItems(db, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const col = (k) => chunk.map((r) => r[k]);
    await db.query(
      `insert into items (hash_name, name, weapon, wear, rarity, rarity_color, image, stattrak, price, quantity, updated_at)
       select *, now() from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::bigint[], $10::int[])
       on conflict (hash_name) do update set
         name = excluded.name, weapon = coalesce(excluded.weapon, items.weapon), wear = excluded.wear,
         rarity = coalesce(excluded.rarity, items.rarity), rarity_color = coalesce(excluded.rarity_color, items.rarity_color),
         image = coalesce(excluded.image, items.image), stattrak = excluded.stattrak,
         price = excluded.price, quantity = excluded.quantity, updated_at = now()`,
      [col('hashName'), col('name'), col('weapon'), col('wear'), col('rarity'), col('rarityColor'), col('image'), col('stattrak'), col('price'), col('quantity')],
    );
  }
}

async function setMeta(db, key, value) {
  await db.query('insert into meta(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, JSON.stringify(value)]);
}
async function getMeta(db, key) {
  return (await db.one('select value from meta where key = $1', [key]))?.value ?? null;
}

// Полная синхронизация: цены + (раз в сутки) метаданные
export async function syncCatalog({ fetchImpl = fetch, forceMeta = false } = {}) {
  const db = await getDb();
  const startedAt = new Date();
  const prices = await fetchSkinportPrices(fetchImpl);
  const metaAt = await getMeta(db, 'catalog_meta_at');
  // Версия метаданных: поменяли состав (например, добавили наклейки) — обновляем сразу, не дожидаясь суток
  const metaV = await getMeta(db, 'catalog_meta_v');
  const needMeta = forceMeta || !metaAt || metaV !== META_VERSION || Date.now() - metaAt > 24 * 3600_000;
  let rows;
  if (needMeta) {
    const meta = await fetchMetadata(fetchImpl);
    rows = [];
    for (const [hashName, p] of prices) {
      const m = meta.get(hashName);
      if (!m) continue; // стикеры, кейсы, агенты и прочее без метаданных пропускаем
      rows.push({ hashName, ...splitHashName(hashName), ...m, ...p });
    }
    await upsertItems(db, rows);
    await setMeta(db, 'catalog_meta_at', Date.now());
    await setMeta(db, 'catalog_meta_v', META_VERSION);
  } else {
    // Только цены для уже известных скинов
    const known = await db.query('select hash_name, name, weapon, wear, rarity, rarity_color as "rarityColor", image, stattrak from items');
    rows = known.filter((k) => prices.has(k.hash_name)).map((k) => ({ ...k, hashName: k.hash_name, ...prices.get(k.hash_name) }));
    await upsertItems(db, rows);
  }
  // Скины, которых больше нет в продаже, скрываем из каталога (удалять нельзя: на них ссылаются инвентари)
  if (rows.length) await db.query('update items set quantity = 0 where updated_at < $1', [startedAt]);
  await setMeta(db, 'prices_at', Date.now());
  return { updated: rows.length, meta: needMeta };
}

// «Ленивое» обновление: если цены устарели, обновляем в фоне (один процесс за раз)
export async function pricesAreStale() {
  const db = await getDb();
  const at = await getMeta(db, 'prices_at');
  if (at && Date.now() - at < config.priceTtlMinutes * 60_000) return false;
  // Захватываем «замок» на 5 минут, чтобы параллельные запросы не дёргали Skinport
  const lock = await db.one(
    `insert into meta(key, value) values ('prices_lock', $1) on conflict (key) do update set value = excluded.value
     where (meta.value)::text::bigint < $2 returning key`,
    [JSON.stringify(Date.now()), Date.now() - 5 * 60_000],
  );
  return Boolean(lock);
}

// Демо-каталог для локальной разработки без интернета
export async function seedDemoItems() {
  const db = await getDb();
  const { count } = await db.one('select count(*)::int as count from items');
  if (count > 0) return 0;
  const seed = JSON.parse(fs.readFileSync(new URL('../db/seed-items.json', import.meta.url), 'utf8'));
  const rows = seed.map((s) => ({ ...splitHashName(s.hashName), hashName: s.hashName, weapon: s.weapon, rarity: s.rarity, rarityColor: s.rarityColor ?? null, image: s.image ?? null, stattrak: s.hashName.includes('StatTrak'), price: s.price, quantity: 10 }));
  await upsertItems(db, rows);
  return rows.length;
}

// Запрос каталога с фильтрами
const SORTS = { price_asc: 'price asc', price_desc: 'price desc', popular: 'quantity desc, price desc', name: 'name asc' };

export async function listItems({ q = '', rarity = '', min = 0, max = 0, sort = 'popular', offset = 0, limit = 24 } = {}) {
  const db = await getDb();
  const where = ['price >= $1', 'quantity > 0'];
  const params = [Math.max(MIN_PRICE, min || 0)];
  if (max > 0) { params.push(max); where.push(`price <= $${params.length}`); }
  if (q) { params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`hash_name ilike $${params.length}`); }
  if (RARITIES.includes(rarity)) { params.push(rarity); where.push(`rarity = $${params.length}`); }
  const order = SORTS[sort] || SORTS.popular;
  params.push(Math.min(Math.max(limit, 1), 60), Math.max(offset, 0));
  const rows = await db.query(
    `select hash_name, name, weapon, wear, rarity, rarity_color, image, stattrak, price, count(*) over() as total
     from items where ${where.join(' and ')} order by ${order}, hash_name limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { total: rows[0]?.total ?? 0, items: rows.map(publicItem) };
}

// Скин, доступный для покупки и как цель апгрейда
export async function getItem(db, hashName) {
  return db.one('select * from items where hash_name = $1 and quantity > 0', [hashName]);
}

export async function priceMap(db, hashNames) {
  if (!hashNames.length) return new Map();
  const rows = await db.query('select hash_name, name, wear, rarity, rarity_color, image, price from items where hash_name = any($1)', [hashNames]);
  return new Map(rows.map((r) => [r.hash_name, r]));
}

export const publicItem = (r) => ({
  hashName: r.hash_name,
  name: r.name,
  weapon: r.weapon,
  wear: r.wear,
  rarity: r.rarity,
  rarityColor: r.rarity_color,
  image: r.image,
  stattrak: r.stattrak,
  price: r.price,
});
