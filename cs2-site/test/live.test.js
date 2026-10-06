import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { getLive, resetLiveCache } from '../lib/live.js';
import { runUpgrade } from '../lib/upgrade.js';
import { getDb } from '../lib/db.js';

beforeEach(async () => { await freshDb(); resetLiveCache(); });

test('онлайн считает разных посетителей за последние 2 минуты, а не выдумывает', async () => {
  assert.equal((await getLive('g:a')).online, 1);
  assert.equal((await getLive('g:a')).online, 1, 'тот же посетитель не считается дважды');
  assert.equal((await getLive('u:1')).online, 2);
  const db = await getDb();
  await db.query("update presence set seen_at = now() - interval '5 minutes' where key = 'g:a'");
  assert.equal((await getLive('u:1')).online, 1, 'ушедший посетитель пропадает из онлайна');
});

test('лучший дроп: пока выигрышей нет — «главный приз» из маркета, потом — реальный выигрыш', async () => {
  const before = await getLive('g:x');
  assert.equal(before.best.type, 'top');
  // Самый дорогой нож/перчатки не дороже 150 000 ₽ (Dragon Lore за 780 000 ₽ и Butterfly за 210 000 ₽ не подходят)
  assert.equal(before.best.item.hashName, '★ Karambit | Doppler (Factory New)');
  assert.ok(before.best.item.price <= 15_000_000);
  assert.ok(before.best.minStake > 0);
  assert.deepEqual(before.drops, []);
  // Пустую ленту добирают реальные скины каталога (подписаны на сайте как «Можно выбить»), а не выдуманные выигрыши
  assert.ok(before.targets.length > 0);
  assert.ok(before.targets.every((t) => t.price >= 30000 && t.price <= 15_000_000 && !('user' in t)));

  // Выигрываем: ставка почти на максимальный шанс, пока не повезёт
  const u = await makeUser(10_000_000);
  let won = null;
  for (let i = 0; i < 40 && !won; i++) {
    const r = await runUpgrade(u.id, { balance: 20_000, target: 'Desert Eagle | Mecha Industries (Field-Tested)' });
    if (r.won) won = r;
  }
  assert.ok(won, 'за 40 бросков с шансом ~46% выигрыш должен случиться');
  resetLiveCache();
  const after = await getLive('g:x');
  assert.equal(after.best.type, 'win');
  assert.equal(after.best.item.hashName, 'Desert Eagle | Mecha Industries (Field-Tested)');
  assert.ok(after.drops.length >= 1);
});
