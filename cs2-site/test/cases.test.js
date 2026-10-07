import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { listCases, openCase, resetCasesCache, solveOdds } from '../lib/cases.js';
import { getLive, resetLiveCache } from '../lib/live.js';
import { getDb } from '../lib/db.js';

beforeEach(async () => { await freshDb(); resetCasesCache(); resetLiveCache(); });

const ev = (prices, ppm) => prices.reduce((s, p, i) => s + (p * ppm[i]) / 1_000_000, 0);

test('шансы: сумма ровно 100%, средний дроп = цена × (1 − край), дешёвое выпадает чаще', () => {
  const prices = [500, 900, 2_000, 8_000, 40_000, 300_000];
  const ppm = solveOdds(prices, 2_700);
  assert.equal(ppm.reduce((a, b) => a + b, 0), 1_000_000);
  assert.ok(Math.abs(ev(prices, ppm) - 2_700) < 3, `EV ${ev(prices, ppm)}`);
  for (let i = 1; i < ppm.length; i++) assert.ok(ppm[i] <= ppm[i - 1]);
  assert.ok(ppm.every((p) => p >= 1));
  assert.equal(solveOdds([500, 900], 600), null, 'меньше трёх скинов — кейса нет');
  assert.equal(solveOdds([500, 900, 1000], 400), null, 'цель дешевле самого дешёвого скина — подобрать нельзя');
});

test('кейсы из каталога: шансы открыты, средний дроп — 90% цены', async () => {
  const list = await listCases();
  assert.ok(list.length >= 5);
  for (const c of list) {
    assert.ok(c.items.length >= 3);
    assert.equal(c.items.reduce((s, i) => s + i.ppm, 0), 1_000_000);
    const ratio = ev(c.items.map((i) => i.price), c.items.map((i) => i.ppm)) / c.price;
    assert.ok(Math.abs(ratio - 0.9) < 0.005, `${c.slug}: ${ratio}`);
  }
});

test('открытие: списывает цену, кладёт скин в инвентарь, двигает nonce и пишет журнал', async () => {
  const [c] = await listCases();
  const u = await makeUser(c.price * 3);
  const r = await openCase(u.id, c.slug);
  assert.equal(r.balance, c.price * 2);
  assert.ok(c.items.some((i) => i.hashName === r.item.hashName));
  const db = await getDb();
  const ui = await db.one('select * from user_items where id = $1', [r.userItemId]);
  assert.equal(ui.source, 'case');
  assert.equal(ui.status, 'owned');
  assert.equal((await db.one('select nonce from users where id = $1', [u.id])).nonce, 1);
  const b = await balanceOf(u.id);
  assert.equal(Number(b.balance), Number(b.ledger));
  assert.equal((await db.one("select count(*)::int as n from ledger where user_id = $1 and kind = 'case'", [u.id])).n, 1);

  await openCase(u.id, c.slug);
  await openCase(u.id, c.slug);
  await assert.rejects(openCase(u.id, c.slug), /Недостаточно/);
  await assert.rejects(openCase(u.id, 'nope'), /не найден/);
});

test('занос из кейса (дроп дороже кейса) попадает в живую ленту', async () => {
  const [c] = await listCases();
  const u = await makeUser(c.price * 60);
  let hit = null;
  for (let i = 0; i < 60 && !hit; i++) {
    const r = await openCase(u.id, c.slug);
    if (r.item.price > c.price) hit = r;
  }
  assert.ok(hit, 'за 60 открытий хоть раз должен выпасть скин дороже кейса');
  const live = await getLive('g:z');
  assert.ok(live.drops.some((d) => d.id === `c${hit.id}`));
});

test('открытие 5 кейсов за раз: одна оплата, пять бросков с разными nonce', async () => {
  const [c] = await listCases();
  const u = await makeUser(c.price * 5);
  const r = await openCase(u.id, c.slug, 5);
  assert.equal(r.drops.length, 5);
  assert.equal(r.balance, 0);
  const db = await getDb();
  const nonces = (await db.query('select nonce from case_opens where user_id = $1 order by id', [u.id])).map((x) => x.nonce);
  assert.deepEqual(nonces, [0, 1, 2, 3, 4]);
  assert.equal((await db.one('select nonce from users where id = $1', [u.id])).nonce, 5);
  assert.equal((await db.one("select count(*)::int as n from user_items where user_id = $1 and source = 'case'", [u.id])).n, 5);
  await assert.rejects(openCase(u.id, c.slug, 6), /от 1 до 5/);
  const poor = await makeUser(c.price * 2);
  await assert.rejects(openCase(poor.id, c.slug, 3), /Недостаточно/);
  assert.equal((await balanceOf(poor.id)).balance, c.price * 2, 'при нехватке ничего не списано');
});
