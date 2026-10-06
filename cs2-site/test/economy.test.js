import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { getDb } from '../lib/db.js';
import { buyItem, buyPrice, listOwned, sellItems, sellPrice, withdrawItem, finishSkinWithdrawal } from '../lib/inventory.js';
import { runUpgrade } from '../lib/upgrade.js';
import { computeRoll } from '../lib/fair.js';
import { DEFAULTS } from '../lib/settings.js';
import { rotateSeed } from '../lib/users.js';

const AK = 'AK-47 | Redline (Field-Tested)'; // 1 250 ₽ в демо-каталоге
const AWP = 'AWP | Asiimov (Field-Tested)'; // 9 800 ₽

beforeEach(freshDb);

const priceOf = async (hash) => (await (await getDb()).one('select price from items where hash_name = $1', [hash])).price;

test('покупка списывает цену с наценкой и кладёт скин в инвентарь', async () => {
  const u = await makeUser(500_000);
  const price = buyPrice(await priceOf(AK), DEFAULTS);
  const r = await buyItem(u.id, AK, price);
  assert.equal(r.balance, 500_000 - price);
  const inv = await listOwned(u.id);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].hashName, AK);
  const b = await balanceOf(u.id);
  assert.equal(b.balance, b.ledger, 'баланс совпадает с журналом');
});

test('покупка: не хватает денег, изменилась цена', async () => {
  const u = await makeUser(1000);
  const price = buyPrice(await priceOf(AK), DEFAULTS);
  await assert.rejects(buyItem(u.id, AK, price), /Недостаточно средств/);
  await assert.rejects(buyItem(u.id, AK, price - 1), (e) => e.status === 409 && e.extra.price === price);
  assert.equal((await listOwned(u.id)).length, 0, 'при ошибке скин не появляется');
});

test('продажа скина возвращает долю рыночной цены и не проходит дважды', async () => {
  const u = await makeUser(500_000);
  const { itemId } = await buyItem(u.id, AK, buyPrice(await priceOf(AK), DEFAULTS));
  const before = (await balanceOf(u.id)).balance;
  const r = await sellItems(u.id, [itemId]);
  assert.equal(r.total, sellPrice(await priceOf(AK), DEFAULTS));
  assert.equal(r.balance, before + r.total);
  await assert.rejects(sellItems(u.id, [itemId]), /уже недоступна/);
});

test('чужой скин продать нельзя', async () => {
  const a = await makeUser(500_000);
  const b = await makeUser(0);
  const { itemId } = await buyItem(a.id, AK, buyPrice(await priceOf(AK), DEFAULTS));
  await assert.rejects(sellItems(b.id, [itemId]), /уже недоступна/);
});

test('апгрейд: результат совпадает с provably fair броском, скины сгорают, победа даёт цель', async () => {
  const u = await makeUser(5_000_000);
  let wins = 0;
  for (let i = 0; i < 30; i++) {
    const { itemId } = await buyItem(u.id, AK, buyPrice(await priceOf(AK), DEFAULTS));
    const db = await getDb();
    const user = await db.one('select * from users where id = $1', [u.id]);
    const r = await runUpgrade(u.id, { itemIds: [itemId], target: AWP });
    // Шанс: 1250 / 9800 × 0.95
    assert.equal(r.chance, Math.floor((125000 / 980000) * 0.95 * 1e6));
    assert.equal(r.roll, computeRoll(user.server_seed, user.client_seed, user.nonce));
    assert.equal(r.won, r.roll < r.chance);
    assert.equal(r.fair.nonce, user.nonce);
    const inv = await listOwned(u.id);
    assert.ok(!inv.some((x) => x.id === itemId), 'поставленный скин сгорел');
    if (r.won) { wins++; assert.ok(inv.some((x) => x.id === r.resultItemId && x.hashName === AWP)); }
  }
  const b = await balanceOf(u.id);
  assert.equal(b.balance, b.ledger);
  assert.ok(wins < 30);
});

test('апгрейд с баланса и ограничения шанса', async () => {
  const u = await makeUser(100_000);
  // 50 000 коп. против цели 9 800 ₽ → 4.8% — нормально
  const r = await runUpgrade(u.id, { balance: 50_000, target: AWP });
  assert.equal((await balanceOf(u.id)).balance, 50_000);
  assert.ok(r.chance > 0);
  // Цель дешевле ставки → шанс больше максимума
  await assert.rejects(runUpgrade(u.id, { balance: 40_000, target: 'P250 | Sand Dune (Field-Tested)' }), /Шанс больше/);
  // Меньше минимальной ставки
  await assert.rejects(runUpgrade(u.id, { balance: 500, target: AWP }), /Минимальная ставка/);
  // Денег не хватает — бросок не засчитан, nonce не сдвинулся
  const db = await getDb();
  const nonce = (await db.one('select nonce from users where id = $1', [u.id])).nonce;
  await assert.rejects(runUpgrade(u.id, { balance: 60_000, target: AWP }), /Недостаточно средств/);
  assert.equal((await db.one('select nonce from users where id = $1', [u.id])).nonce, nonce);
});

test('один скин нельзя поставить в два апгрейда одновременно', async () => {
  const u = await makeUser(500_000);
  const { itemId } = await buyItem(u.id, AK, buyPrice(await priceOf(AK), DEFAULTS));
  const results = await Promise.allSettled([
    runUpgrade(u.id, { itemIds: [itemId], target: AWP }),
    runUpgrade(u.id, { itemIds: [itemId], target: AWP }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
});

test('смена сида раскрывает старый и сбрасывает nonce', async () => {
  const u = await makeUser(100_000);
  await runUpgrade(u.id, { balance: 20_000, target: AWP });
  const db = await getDb();
  const before = await db.one('select * from users where id = $1', [u.id]);
  const r = await rotateSeed(u.id);
  assert.equal(r.revealed.serverSeed, before.server_seed);
  assert.equal(r.revealed.lastNonce, 1);
  const after = await db.one('select * from users where id = $1', [u.id]);
  assert.notEqual(after.server_seed, before.server_seed);
  assert.equal(after.nonce, 0);
});

test('вывод скина без трейд-ссылки запрещён, с ней — уходит на проверку и возвращается при отказе', async () => {
  const u = await makeUser(500_000);
  const { itemId } = await buyItem(u.id, AK, buyPrice(await priceOf(AK), DEFAULTS));
  await assert.rejects(withdrawItem(u.id, itemId), /трейд-ссылку/);
  const db = await getDb();
  await db.query('update users set trade_url = $2 where id = $1', [u.id, 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCd_123']);
  const w = await withdrawItem(u.id, itemId);
  assert.equal(w.status, 'review');
  assert.equal((await listOwned(u.id))[0].status, 'withdrawing');
  await assert.rejects(sellItems(u.id, [itemId]), /уже недоступна/, 'выводимый скин нельзя продать');
  await finishSkinWithdrawal(w.id, 'refunded');
  assert.equal((await listOwned(u.id))[0].status, 'owned');
});
