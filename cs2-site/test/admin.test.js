import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { updateUser } from '../lib/admin.js';
import { getDb } from '../lib/db.js';

beforeEach(freshDb);

test('админ начисляет и списывает целые LC, каждая операция — в журнале с причиной', async () => {
  const u = await makeUser(0);
  assert.equal((await updateUser(u.id, { action: 'adjust', amount: 500_000, note: 'Бонус' })).balance, 500_000);
  assert.equal((await updateUser(u.id, { action: 'adjust', amount: -20_000, note: 'Корректировка' })).balance, 480_000);
  await assert.rejects(updateUser(u.id, { action: 'adjust', amount: 150, note: 'x' }), /целое число LC/);
  await assert.rejects(updateUser(u.id, { action: 'adjust', amount: 10_000 }), /причину/);
  const db = await getDb();
  const rows = await db.query("select amount::bigint as amount, note from ledger where user_id = $1 and kind = 'admin' order by id", [u.id]);
  assert.deepEqual(rows.map((r) => [Number(r.amount), r.note]), [[500_000, 'Бонус'], [-20_000, 'Корректировка']]);
});
