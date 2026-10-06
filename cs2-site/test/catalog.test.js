import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { listItems, splitHashName, syncCatalog } from '../lib/catalog.js';
import { getDb } from '../lib/db.js';

beforeEach(freshDb);

// Подменяем внешние API: Skinport (цены) и CSGO-API (метаданные)
function fakeFetch({ skinport, meta }) {
  return async (url) => new Response(JSON.stringify(String(url).includes('skinport') ? skinport : meta));
}

const SKINPORT = [
  { market_hash_name: 'AK-47 | Redline (Field-Tested)', suggested_price: 1300, min_price: 1250.5, quantity: 40 },
  { market_hash_name: '★ Karambit | Doppler (Factory New)', suggested_price: 99000, min_price: 97000, quantity: 3 },
  { market_hash_name: 'AWP | Rare Thing (Factory New)', suggested_price: 5_000_000, min_price: null, quantity: 0 }, // нет лотов
  { market_hash_name: 'Sticker | Something', suggested_price: 50, min_price: 40, quantity: 100 }, // нет метаданных
];
const META = [
  { market_hash_name: 'AK-47 | Redline (Field-Tested)', weapon: { name: 'AK-47' }, rarity: { color: '#D32CE6' }, image: 'https://img/ak.png' },
  { market_hash_name: '★ Karambit | Doppler (Factory New)', weapon: { name: 'Karambit' }, rarity: { color: '#eb4b4b' }, image: 'https://img/k.png' },
  { market_hash_name: 'AWP | Rare Thing (Factory New)', weapon: { name: 'AWP' }, rarity: { color: '#eb4b4b' }, image: null },
];

test('синхронизация: консервативная цена, только ликвидные скины, ножи — «редкое»', async () => {
  const r = await syncCatalog({ fetchImpl: fakeFetch({ skinport: SKINPORT, meta: META }), forceMeta: true });
  assert.equal(r.updated, 2);
  const db = await getDb();
  const ak = await db.one(`select * from items where hash_name = 'AK-47 | Redline (Field-Tested)'`);
  assert.equal(ak.price, 125050, 'меньшая из рекомендованной и минимальной цены');
  assert.equal(ak.rarity, 'classified');
  assert.equal(ak.name, 'AK-47 | Redline');
  assert.equal(ak.wear, 'Field-Tested');
  const knife = await db.one(`select rarity from items where hash_name like '★ Karambit%'`);
  assert.equal(knife.rarity, 'gold');
  assert.equal(await db.one(`select 1 from items where hash_name like 'AWP | Rare%'`), null, 'без лотов не попадает в каталог');
});

test('скины, пропавшие из продажи, скрываются из каталога', async () => {
  const fetchImpl = fakeFetch({ skinport: SKINPORT, meta: META });
  await syncCatalog({ fetchImpl, forceMeta: true });
  const before = (await listItems({ q: 'Redline (Field' })).items.map((i) => i.hashName);
  assert.ok(before.includes('AK-47 | Redline (Field-Tested)'));
  await syncCatalog({ fetchImpl: fakeFetch({ skinport: SKINPORT.slice(1), meta: META }) });
  const after = (await listItems({ q: 'Redline (Field' })).items.map((i) => i.hashName);
  assert.ok(!after.includes('AK-47 | Redline (Field-Tested)'));
});

test('разбор названия', () => {
  assert.deepEqual(splitHashName('AWP | Asiimov (Battle-Scarred)'), { name: 'AWP | Asiimov', wear: 'Battle-Scarred' });
  assert.deepEqual(splitHashName('★ Karambit'), { name: '★ Karambit', wear: null });
});
