import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { getDb } from '../lib/db.js';
import {
  activeMines, cashoutCrash, cashoutMines, crashMultAt, crashPoint, minePositions, minesMultiplier, openMine, playDice, startCrash, startMines, waitCrash,
} from '../lib/casino.js';
import { computeRoll } from '../lib/fair.js';

beforeEach(freshDb);

const LC = 100;
const noSleep = { sleep: async () => {} };
// Баланс игрока; заодно сверяем с журналом (сумма движений = баланс)
async function bal(id) {
  const b = await balanceOf(id);
  assert.equal(Number(b.ledger), b.balance, 'журнал сходится с балансом');
  return b.balance;
}

test('казино: математика — средний возврат 95% во всех играх', () => {
  // Ракетка: P(точка взрыва ≥ M) = 0,95 ÷ M
  const n = 200_000;
  let ge2 = 0;
  let ge10 = 0;
  for (let i = 0; i < n; i++) {
    const c = crashPoint(Math.floor((i / n) * 1_000_000), 0.05);
    if (c >= 2) ge2++;
    if (c >= 10) ge10++;
  }
  assert.ok(Math.abs(ge2 / n - 0.475) < 0.002, `P(≥2) ${ge2 / n}`);
  assert.ok(Math.abs(ge10 / n - 0.095) < 0.002, `P(≥10) ${ge10 / n}`);
  assert.equal(crashPoint(0, 0.05), 1);
  assert.equal(crashPoint(999_999, 0.05), 1000);
  // Мины: множитель × вероятность дойти = 0,95
  for (const mines of [1, 3, 10, 24]) {
    for (let k = 1; k <= 25 - mines; k++) {
      let p = 1;
      for (let i = 0; i < k; i++) p *= (25 - mines - i) / (25 - i);
      assert.ok(Math.abs(minesMultiplier(k, mines, 0.05) * p - 0.95) < 1e-9);
    }
  }
  // Ракетка растёт со временем
  assert.equal(crashMultAt(0), 1);
  assert.ok(crashMultAt(6_932) >= 1.99 && crashMultAt(6_932) <= 2.01);
});

test('мины: позиции детерминированы сидом, разные и без повторов', () => {
  const a = minePositions('seed', 'client', 5, 5);
  assert.deepEqual(a, minePositions('seed', 'client', 5, 5));
  assert.equal(new Set(a).size, 5);
  assert.ok(a.every((c) => c >= 0 && c < 25));
  assert.notDeepEqual(a, minePositions('seed', 'client', 6, 5));
  assert.equal(minePositions('s', 'c', 1, 24).length, 24);
});

test('кости: ставка списывается, выигрыш = ставка × 0,95 ÷ шанс, бросок честный', async () => {
  const u = await makeUser(10_000 * LC);
  const start = await bal(u.id);
  const db = await getDb();
  const { server_seed: seed, client_seed: cs, nonce } = await db.one('select * from users where id = $1', [u.id]);
  const r = await playDice(u.id, { bet: 100 * LC, chance: 500_000, over: false });
  assert.equal(r.roll, computeRoll(seed, cs, nonce));
  assert.equal(r.won, r.roll < 500_000);
  assert.equal(r.multiplier, 1.9);
  assert.equal(r.payout, r.won ? 190 * LC : 0);
  assert.equal(await bal(u.id), start - 100 * LC + r.payout);
  const r2 = await playDice(u.id, { bet: 100 * LC, chance: 500_000, over: true });
  assert.equal(r2.won, r2.roll >= 500_000);
  await assert.rejects(playDice(u.id, { bet: 100 * LC, chance: 990_000 }), /от 1 до 95%/);
  await assert.rejects(playDice(u.id, { bet: 50 }), /целое число LC/);
  await assert.rejects(playDice(u.id, { bet: 60_000 * LC, chance: 500_000 }), /Максимальная ставка/);
  const poor = await makeUser(0);
  await (await getDb()).query('update users set balance = 0 where id = $1', [poor.id]);
  await assert.rejects(playDice(poor.id, { bet: 10 * LC, chance: 500_000 }), /Недостаточно/);
});

test('мины: мины скрыты до конца, безопасная клетка растит множитель, забрать — выплата, мина — проигрыш', async () => {
  const u = await makeUser(1_000 * LC);
  const start = await bal(u.id);
  const db = await getDb();
  const g = await startMines(u.id, { bet: 100 * LC, mines: 3 });
  assert.equal(g.minePositions, undefined, 'позиции мин не отдаются');
  assert.equal(await bal(u.id), start - 100 * LC);
  await assert.rejects(startMines(u.id, { bet: 100 * LC, mines: 3 }), /закончи текущую/);
  const { state } = await db.one('select state from casino_games where id = $1', [g.id]);
  const safe = [...Array(25).keys()].filter((c) => !state.positions.includes(c));
  const o1 = await openMine(u.id, g.id, safe[0]);
  assert.equal(o1.status, 'active');
  const o2 = await openMine(u.id, g.id, safe[1]);
  assert.equal(o2.multiplier, Math.floor(minesMultiplier(2, 3, 0.05) * 100) / 100);
  assert.equal((await activeMines(u.id)).opened.length, 2);
  const c = await cashoutMines(u.id, g.id);
  assert.equal(c.status, 'won');
  assert.equal(c.payout, Math.floor(100 * minesMultiplier(2, 3, 0.05)) * LC);
  assert.deepEqual(c.minePositions, state.positions);
  assert.equal(await bal(u.id), start - 100 * LC + c.payout);

  const g2 = await startMines(u.id, { bet: 100 * LC, mines: 5 });
  const st2 = (await db.one('select state from casino_games where id = $1', [g2.id])).state;
  const boom = await openMine(u.id, g2.id, st2.positions[0]);
  assert.equal(boom.status, 'lost');
  assert.equal(boom.boom, st2.positions[0]);
  await assert.rejects(cashoutMines(u.id, g2.id), /уже закончена/);
});

test('ракетка: точка взрыва скрыта, забрать до взрыва — выигрыш, после — проигрыш, автовывод', async () => {
  const u = await makeUser(1_000 * LC);
  const start = await bal(u.id);
  const db = await getDb();
  const setState = (id, patch) => db.query(`update casino_games set state = state || $2::jsonb where id = $1`, [id, JSON.stringify(patch)]);

  const g = await startCrash(u.id, { bet: 100 * LC });
  assert.equal(g.crash, null, 'точку взрыва заранее не видно');
  await assert.rejects(startCrash(u.id, { bet: 100 * LC }), /ещё летит/);
  // Летим 6,93 с (×2), взрыв на ×5 → забираем ×2
  await setState(g.id, { crash: 5, startAt: Date.now() - 6_932 });
  const c = await cashoutCrash(u.id, g.id);
  assert.equal(c.status, 'won');
  assert.ok(c.multiplier >= 1.99 && c.multiplier <= 2.01, String(c.multiplier));
  assert.equal(c.crash, null, 'ракетка ещё летит — точка взрыва всё ещё скрыта');

  // Нажал «Забрать» уже после взрыва → проигрыш
  const g2 = await startCrash(u.id, { bet: 100 * LC });
  await setState(g2.id, { crash: 1.5, startAt: Date.now() - 10_000 });
  const c2 = await cashoutCrash(u.id, g2.id);
  assert.equal(c2.status, 'lost');
  assert.equal(c2.crash, 1.5);

  // Автовывод ×1,5, взрыв на ×3 — игрок закрыл вкладку, игра досчитывается сама
  const g3 = await startCrash(u.id, { bet: 100 * LC, auto: 1.5 });
  await setState(g3.id, { crash: 3, startAt: Date.now() - 20_000 });
  const w = await waitCrash(u.id, g3.id, noSleep);
  assert.equal(w.status, 'won');
  assert.equal(w.payout, 150 * LC);
  assert.equal(w.crash, 3);

  // Автовывод выше точки взрыва — проигрыш
  const g4 = await startCrash(u.id, { bet: 100 * LC, auto: 4 });
  await setState(g4.id, { crash: 2, startAt: Date.now() - 20_000 });
  const w4 = await waitCrash(u.id, g4.id, noSleep);
  assert.equal(w4.status, 'lost');
  assert.equal(await bal(u.id), start - 400 * LC + c.payout + 150 * LC);
});

test('казино: выигрыш больше миллиона LC не обрезается (лимит — 1 млрд LC)', async () => {
  const u = await makeUser(0);
  const db = await getDb();
  await db.query('update users set balance = 5000000 where id = $1', [u.id]); // 50 000 LC
  await db.query(`update ledger set amount = 5000000, balance_after = 5000000 where user_id = $1`, [u.id]);
  await db.query(`delete from ledger where user_id = $1 and id not in (select min(id) from ledger where user_id = $1)`, [u.id]);
  const g = await startMines(u.id, { bet: 50_000 * LC, mines: 24 });
  const { state } = await db.one('select state from casino_games where id = $1', [g.id]);
  const safe = [...Array(25).keys()].find((c) => !state.positions.includes(c));
  const r = await openMine(u.id, g.id, safe); // единственная чистая клетка — забирается сама, ×23,75
  assert.equal(r.status, 'won');
  assert.equal(r.payout, 1_187_500 * LC, '50 000 × 23,75 = 1 187 500 LC — больше старого потолка в 1 млн');
  assert.equal((await balanceOf(u.id)).balance, 1_187_500 * LC);
});
