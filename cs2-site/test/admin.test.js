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

test('шанс апгрейда настраивается от 0 до 100%, карточка игрока со сводкой', async () => {
  const { updateSettings, getSettings } = await import('../lib/settings.js');
  const { userDetail } = await import('../lib/admin.js');
  const r = await updateSettings({ maxChance: 1, minChance: 0 });
  assert.deepEqual(r.errors, {});
  const s = await getSettings();
  assert.equal(s.maxChance, 1);
  assert.equal(s.minChance, 0);
  assert.ok((await updateSettings({ maxChance: 1.5 })).errors.maxChance, "больше 100% нельзя");
  assert.ok((await updateSettings({ maxChance: 0.05, houseEdge: 0.5 })).errors.houseEdge, "комиссия 50% — опечатка, не сохраняем");

  const u = await makeUser(0);
  await updateUser(u.id, { action: 'adjust', amount: 1_000_000, note: 'Бонус' });
  const d = await userDetail(u.id);
  assert.equal(d.user.balance, 1_000_000);
  assert.equal(Number(d.stats.granted), 1_000_000);
  assert.equal(d.ledger[0].note, 'Бонус');
  await assert.rejects(userDetail(999_999), /не найден/);
});

test('апгрейд на любой скин: 10 LC на самый дорогой скин каталога — шанс крошечный, но бросок проходит', async () => {
  const { runUpgrade } = await import('../lib/upgrade.js');
  const db = await getDb();
  const top = await db.one('select hash_name, price from items where quantity > 0 order by price desc limit 1');
  const u = await makeUser(1_000);
  const r = await runUpgrade(u.id, { balance: 1_000, target: top.hash_name });
  assert.ok(r.chance >= 1 && r.chance < 1000, `шанс ${r.chance} ppm`);
  assert.equal(r.balance, 0);
});

test('админка: владелец выдаёт и снимает права, выданный админ не может раздавать их дальше', async () => {
  const { config } = await import('../lib/config.js');
  const { isAdmin, isOwner } = await import('../lib/users.js');
  const owner = await makeUser(0);
  config.adminTgIds = [String(owner.telegram_id)];
  try {
    const helper = await makeUser(0);
    const other = await makeUser(0);
    assert.ok(isOwner(owner) && !isAdmin(helper));
    await updateUser(helper.id, { action: 'make_admin' }, owner);
    const db = await getDb();
    const h = await db.one('select * from users where id = $1', [helper.id]);
    assert.ok(isAdmin(h) && !isOwner(h));
    await assert.rejects(updateUser(other.id, { action: 'make_admin' }, h), /только владелец/);
    await assert.rejects(updateUser(owner.id, { action: 'remove_admin' }, owner), /Владельца нельзя/);
    await assert.rejects(updateUser(owner.id, { action: 'ban' }, h), /Владельца забанить нельзя/);
    await updateUser(helper.id, { action: 'remove_admin' }, owner);
    assert.ok(!isAdmin(await db.one('select * from users where id = $1', [helper.id])));
  } finally {
    config.adminTgIds = [];
  }
});

test('бан: срок 1/7/30 дней или навсегда, с причиной; истёкший бан не действует; действия забаненного заблокированы', async () => {
  const { activeBan } = await import('../lib/users.js');
  const { openCase, listCases } = await import('../lib/cases.js');
  const db = await getDb();
  const u = await makeUser(1_000_000);
  await assert.rejects(updateUser(u.id, { action: 'ban', days: 7 }), /причину/);
  await assert.rejects(updateUser(u.id, { action: 'ban', days: 3, note: 'x' }), /1, 7, 30/);
  await updateUser(u.id, { action: 'ban', days: 7, note: 'Мультиаккаунт' });
  let row = await db.one('select * from users where id = $1', [u.id]);
  const ban = activeBan(row);
  assert.equal(ban.reason, 'Мультиаккаунт');
  assert.ok(new Date(ban.until) - Date.now() > 6.9 * 86_400_000);
  const [c] = await listCases();
  await assert.rejects(openCase(u.id, c.slug), /заблокирован.*Мультиаккаунт/);
  // Срок вышел — бан не действует
  await db.query("update users set banned_until = now() - interval '1 minute' where id = $1", [u.id]);
  assert.equal(activeBan(await db.one('select * from users where id = $1', [u.id])), null);
  // Навсегда
  await updateUser(u.id, { action: 'ban', days: null, note: 'Мошенничество' });
  row = await db.one('select * from users where id = $1', [u.id]);
  assert.deepEqual(activeBan(row), { reason: 'Мошенничество', until: null });
  await updateUser(u.id, { action: 'unban' });
  assert.equal(activeBan(await db.one('select * from users where id = $1', [u.id])), null);
});

test('изъятие скинов: пропадают из инвентаря, журнал с причиной, выводимые и чужие не трогаются', async () => {
  const { confiscateItems, userDetail } = await import('../lib/admin.js');
  const { listOwned } = await import('../lib/inventory.js');
  const db = await getDb();
  const adminUser = await makeUser(0);
  const u = await makeUser(0);
  const other = await makeUser(0);
  const { hash_name: hash, price } = await db.one('select hash_name, price from items where quantity > 0 order by price desc limit 1');
  const give = async (owner, status = 'owned') => (await db.one(
    `insert into user_items (user_id, hash_name, price, source, status) values ($1, $2, $3, 'case', $4) returning id`, [owner, hash, price, status],
  )).id;
  const a = await give(u.id);
  const b = await give(u.id);
  const w = await give(u.id, 'withdrawing');
  const foreign = await give(other.id);

  await assert.rejects(confiscateItems(u.id, [a], '', adminUser), /причину/);
  await assert.rejects(confiscateItems(u.id, [a, foreign], 'Абуз бонусов', adminUser), /недоступна/, 'чужой скин — нельзя');
  await assert.rejects(confiscateItems(u.id, [w], 'Абуз бонусов', adminUser), /недоступна/, 'выводимый — нельзя');
  const r = await confiscateItems(u.id, [a, b], 'Абуз бонусов', adminUser);
  assert.equal(r.count, 2);
  assert.equal(r.total, price * 2);
  const left = (await listOwned(u.id)).map((i) => i.id);
  assert.deepEqual(left, [w], 'в инвентаре остался только выводимый');
  await assert.rejects(confiscateItems(u.id, [a], 'Повтор', adminUser), /недоступна/, 'второй раз не изъять');
  const d = await userDetail(u.id);
  assert.equal(d.confiscated.length, 2);
  assert.equal(d.confiscated[0].reason, 'Абуз бонусов');
  assert.equal((await db.one('select status from user_items where id = $1', [foreign])).status, 'owned');
});
