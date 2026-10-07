import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { createPromo, redeemPromo, setPromoActive } from '../lib/promo.js';
import { refCode, refUserId, referralStats, rewardReferrer } from '../lib/referrals.js';
import { upsertTelegramUser } from '../lib/users.js';
import { updateSettings, DEFAULTS } from '../lib/settings.js';
import { getDb } from '../lib/db.js';

beforeEach(freshDb);

test('промокод: начисляет сумму один раз на игрока, лимит активаций, выключение', async () => {
  await createPromo({ code: 'luxe-test', amount: 10_000, maxUses: 2, days: 7 });
  await assert.rejects(createPromo({ code: 'LUXE-TEST', amount: 10_000, maxUses: 1 }), /уже есть/);
  await assert.rejects(createPromo({ code: 'x', amount: 10_000, maxUses: 1 }), /3–32/);
  await assert.rejects(createPromo({ code: 'FRAC', amount: 150, maxUses: 1 }), /целое число LC/);

  const [a, b, c] = [await makeUser(0), await makeUser(0), await makeUser(0)];
  assert.equal((await redeemPromo(a.id, ' luxe-test ')).balance, 10_000);
  await assert.rejects(redeemPromo(a.id, 'LUXE-TEST'), /уже активировал/);
  await redeemPromo(b.id, 'LUXE-TEST');
  await assert.rejects(redeemPromo(c.id, 'LUXE-TEST'), /максимальное число/);
  await assert.rejects(redeemPromo(c.id, 'NOPE-123'), /нет или он выключен/);

  await createPromo({ code: 'OFF1', amount: 10_000, maxUses: 5 });
  await setPromoActive('off1', false);
  await assert.rejects(redeemPromo(c.id, 'OFF1'), /выключен/);
  const bal = await balanceOf(a.id);
  assert.equal(Number(bal.balance), Number(bal.ledger));
});

test('рефералы: код ↔ игрок, закрепление при первом входе, процент с пополнений', async () => {
  const inviter = await makeUser(0);
  assert.equal(refUserId(refCode(inviter.id)), inviter.id);
  assert.equal(refUserId('!!'), null);

  await updateSettings({ refPercent: 0.1, refInviteeBonus: 20_000 });
  const friend = await upsertTelegramUser({ id: 7770001, first_name: 'Друг' }, { ref: refCode(inviter.id) });
  assert.equal(friend.referred_by, inviter.id);
  assert.equal(friend.balance, 20_000, 'бонус новичку по ссылке');
  // Повторный вход с чужим кодом не меняет пригласившего
  const other = await makeUser(0);
  const again = await upsertTelegramUser({ id: 7770001, first_name: 'Друг' }, { ref: refCode(other.id) });
  assert.equal(again.referred_by, inviter.id);
  // Сам себя пригласить нельзя: код ещё не существующего игрока — пусто
  const self = await upsertTelegramUser({ id: 7770002, first_name: 'Хитрый' }, { ref: refCode(999_999) });
  assert.equal(self.referred_by, null);

  const db = await getDb();
  await db.tx((q) => rewardReferrer(q, friend.id, 100_000, 'payment:1'));
  assert.equal((await balanceOf(inviter.id)).balance, 10_000);
  const st = await referralStats(inviter.id);
  assert.equal(st.invited, 1);
  assert.equal(Number(st.earned), 10_000);
  assert.ok(st.site.endsWith(`?ref=${refCode(inviter.id)}`));
});

test('стартовый бонус по умолчанию — 1 000 LC', () => {
  assert.equal(DEFAULTS.signupBonus, 100_000);
});
