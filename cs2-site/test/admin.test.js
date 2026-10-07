import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { updateUser } from '../lib/admin.js';
import { getDb } from '../lib/db.js';
import { upsertTelegramUser } from '../lib/users.js';
import { updateSettings } from '../lib/settings.js';

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

test('стартовый бонус: начисляется один раз при первом входе, 0 — выключен', async () => {
  await updateSettings({ signupBonus: 5_000_000 });
  const first = await upsertTelegramUser({ id: 555001, first_name: 'Новичок' });
  assert.equal(first.balance, 5_000_000);
  assert.equal('inserted' in first, false);
  const again = await upsertTelegramUser({ id: 555001, first_name: 'Новичок' });
  assert.equal(again.balance, 5_000_000, 'повторный вход бонус не даёт');
  const db = await getDb();
  const rows = await db.query("select amount::bigint as amount from ledger where user_id = $1 and kind = 'bonus'", [first.id]);
  assert.deepEqual(rows.map((r) => Number(r.amount)), [5_000_000]);

  await updateSettings({ signupBonus: 0 });
  assert.equal((await upsertTelegramUser({ id: 555002, first_name: 'Без бонуса' })).balance, 0);
});
