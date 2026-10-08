import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { getDb } from '../lib/db.js';
import { claimDaily, getDaily, mskDay, rewardFor } from '../lib/daily.js';
import { playDice } from '../lib/casino.js';
import { DEFAULTS } from '../lib/settings.js';

beforeEach(freshDb);
const LC = 100;
const daysAgo = (n) => mskDay(Date.now() - n * 24 * 3600_000);

test('ежедневная награда: 40 LC, растёт на 10 LC за день подряд, потолок 200 LC', () => {
  assert.equal(rewardFor(1, DEFAULTS), 40 * LC);
  assert.equal(rewardFor(2, DEFAULTS), 50 * LC);
  assert.equal(rewardFor(7, DEFAULTS), 100 * LC);
  assert.equal(rewardFor(100, DEFAULTS), 200 * LC);
});

test('ежедневная награда: нужно поставить 199 LC за день, забрать можно один раз', async () => {
  const u = await makeUser(1_000 * LC);
  let d = await getDaily(u.id);
  assert.equal(d.ready, false);
  assert.equal(d.wagered, 0);
  assert.equal(d.reward, 40 * LC);
  await assert.rejects(claimDaily(u.id), /Поставь ещё 199 LC/);
  await playDice(u.id, { bet: 150 * LC, chance: 500_000 });
  await assert.rejects(claimDaily(u.id), /Поставь ещё 49 LC/);
  await playDice(u.id, { bet: 49 * LC, chance: 500_000 });
  d = await getDaily(u.id);
  assert.equal(d.ready, true);
  const before = (await balanceOf(u.id)).balance;
  const r = await claimDaily(u.id);
  assert.equal(r.streak, 1);
  assert.equal(r.balance, before + 40 * LC);
  await assert.rejects(claimDaily(u.id), /уже получена/);
  assert.equal((await getDaily(u.id)).claimed, true);
});

test('ежедневная награда: серия растёт, если не пропускать дни, и сбрасывается после пропуска', async () => {
  const db = await getDb();
  const a = await makeUser(1_000 * LC);
  const b = await makeUser(1_000 * LC);
  await db.query('insert into daily_rewards (user_id, day, streak, amount) values ($1, $2, 3, 6000)', [a.id, daysAgo(1)]);
  await db.query('insert into daily_rewards (user_id, day, streak, amount) values ($1, $2, 5, 8000)', [b.id, daysAgo(2)]);
  const da = await getDaily(a.id);
  assert.equal(da.streak, 4);
  assert.equal(da.reward, 70 * LC);
  assert.deepEqual(da.upcoming.slice(0, 3), [70 * LC, 80 * LC, 90 * LC]);
  const dbb = await getDaily(b.id);
  assert.equal(dbb.streak, 1, 'пропустил день — серия заново');
  assert.equal(dbb.reward, 40 * LC);
});
