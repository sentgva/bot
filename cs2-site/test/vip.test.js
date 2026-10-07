import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { TIERS, XP_WEIGHT, tierFor, vipInfo, addXp } from '../lib/vip.js';
import { listCases, openCase } from '../lib/cases.js';
import { getDb } from '../lib/db.js';

beforeEach(freshDb);

test('уровни: пороги по очкам, прогресс к следующему, последний — Obsidian', () => {
  assert.equal(tierFor(0).key, 'newbie');
  assert.equal(tierFor(499_99).key, 'newbie');
  assert.equal(tierFor(500_00).key, 'vip');
  assert.equal(tierFor(200_000_00).key, 'obsidian');
  assert.equal(TIERS.at(-1).name, 'Obsidian');
  const v = vipInfo({ xp: 1_750_00 }); // между VIP (500) и Gold (3000)
  assert.equal(v.name, 'VIP');
  assert.equal(v.next.name, 'Gold');
  assert.equal(v.next.left, 1_250);
  assert.ok(Math.abs(v.progress - 0.5) < 1e-9);
  assert.equal(vipInfo({ xp: 999_999_00 }).next, null);
  // Пополнение даёт больше всего опыта
  assert.ok(XP_WEIGHT.deposit > XP_WEIGHT.case && XP_WEIGHT.case > XP_WEIGHT.contract);
});

test('уровни: опыт за кейсы растёт от цены, кэшбэк по уровню возвращается на баланс', async () => {
  const [c] = await listCases();
  const u = await makeUser(c.price * 2);
  const db = await getDb();
  const r1 = await openCase(u.id, c.slug);
  assert.equal(r1.cashback, 0, 'у новичка кэшбэка нет');
  assert.equal(Number((await db.one('select xp from users where id = $1', [u.id])).xp), Math.floor(c.price * XP_WEIGHT.case));
  // Gold: кэшбэк 1%
  await db.query('update users set xp = $2 where id = $1', [u.id, 3_000_00]);
  const r2 = await openCase(u.id, c.slug);
  assert.equal(r2.cashback, Math.floor(c.price * 0.01 / 100) * 100);
  const { before, after } = await addXp(db, u.id, 1_000_000_00, 'deposit');
  assert.equal(before.key, 'gold');
  assert.equal(after.key, 'obsidian');
});

test('уровни: даже на Obsidian сайт не уходит в минус (апгрейд и кейсы < 100% возврата)', async () => {
  const { DEFAULTS } = await import('../lib/settings.js');
  for (const t of TIERS) {
    assert.ok((1 - DEFAULTS.houseEdge) * (1 + t.upgrade) < 1, `${t.name}: апгрейд`);
    assert.ok((1 - DEFAULTS.caseEdge) + t.cashback < 1, `${t.name}: кейсы`);
  }
  const d = TIERS.find((t) => t.key === 'diamond');
  const o = TIERS.find((t) => t.key === 'obsidian');
  assert.ok(o.deposit > d.deposit && o.upgrade > d.upgrade && o.cashback > d.cashback);
});
