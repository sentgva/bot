import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { getDb } from '../lib/db.js';
import { config } from '../lib/config.js';
import { finishWithdraw, handleCryptoWebhook, listPayments, requestWithdraw } from '../lib/payments.js';
import { listWithdrawals } from '../lib/admin.js';
import { normalizeCard, normalizePhone, normalizeTelegram, parseTradeUrl, rublesToKop } from '../lib/validate.js';

beforeEach(freshDb);

const CARD = '4111 1111 1111 1111';

test('вывод на карту: списание с комиссией, номер зашифрован, админ видит полный номер', async () => {
  const u = await makeUser(200_000);
  const r = await requestWithdraw(u.id, { method: 'card', amount: 100_000, card: CARD });
  assert.equal(r.status, 'review');
  assert.equal((await balanceOf(u.id)).balance, 100_000);
  const db = await getDb();
  const p = await db.one('select * from payments where id = $1', [r.id]);
  assert.equal(p.fee, 3000);
  assert.ok(!JSON.stringify(p.details).includes('4111111111111111'), 'в базе нет открытого номера');
  const [mine] = await listPayments(u.id);
  assert.equal(mine.details.card, '4111 •••• •••• 1111');
  assert.equal(mine.details.cardEnc, undefined);
  const [adm] = await listWithdrawals('open');
  assert.equal(adm.details.cardFull, '4111111111111111');
});

test('отказ в выводе возвращает деньги и удаляет номер карты', async () => {
  const u = await makeUser(200_000);
  const r = await requestWithdraw(u.id, { method: 'card', amount: 100_000, card: CARD });
  await finishWithdraw(r.id, 'reject', 'тест');
  const b = await balanceOf(u.id);
  assert.equal(b.balance, 200_000);
  assert.equal(b.ledger, 200_000);
  const p = await (await getDb()).one('select details, status from payments where id = $1', [r.id]);
  assert.equal(p.status, 'rejected');
  assert.equal(p.details.cardEnc, undefined);
  await assert.rejects(finishWithdraw(r.id, 'paid'), /уже обработана/);
});

test('вывод: проверки суммы и реквизитов', async () => {
  const u = await makeUser(60_000);
  await assert.rejects(requestWithdraw(u.id, { method: 'card', amount: 10_000, card: CARD }), /Минимальный вывод/);
  await assert.rejects(requestWithdraw(u.id, { method: 'card', amount: 50_000, card: '4111 1111 1111 1112' }), /номер карты/);
  await assert.rejects(requestWithdraw(u.id, { method: 'sbp', amount: 50_000, phone: '123', bank: 'Сбербанк' }), /телефона/);
  await assert.rejects(requestWithdraw(u.id, { method: 'card', amount: 70_000, card: CARD }), /Недостаточно средств/);
  await assert.rejects(requestWithdraw(u.id, { method: 'crypto', amount: 50_000, asset: 'USDT' }), /недоступен/, 'без токена Crypto Pay крипта выключена');
  const ok = await requestWithdraw(u.id, { method: 'sbp', amount: 50_000, phone: '8 (999) 123-45-67', bank: 'Т-Банк' });
  assert.equal(ok.status, 'review');
  assert.equal((await balanceOf(u.id)).balance, 10_000);
});

test('вебхук Crypto Pay: подпись, зачисление ровно один раз', async () => {
  config.cryptoPayToken = 'test-token';
  try {
    const u = await makeUser(0);
    const db = await getDb();
    const p = await db.one(`insert into payments (user_id, direction, method, amount, status, provider_id) values ($1, 'in', 'crypto', 150000, 'pending', '777') returning id`, [u.id]);
    const body = JSON.stringify({ update_type: 'invoice_paid', payload: { invoice_id: 777, fiat: 'RUB', amount: '1500.00', payload: `dep:${p.id}`, paid_asset: 'USDT' } });
    const sign = (b) => crypto.createHmac('sha256', crypto.createHash('sha256').update('test-token').digest()).update(b).digest('hex');
    await assert.rejects(handleCryptoWebhook(body, 'deadbeef'), (e) => e.status === 401);
    await handleCryptoWebhook(body, sign(body));
    await handleCryptoWebhook(body, sign(body));
    assert.equal((await balanceOf(u.id)).balance, 150_000);
  } finally {
    config.cryptoPayToken = '';
  }
});

test('валидация', () => {
  assert.ok(parseTradeUrl('https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCd_123'));
  assert.equal(parseTradeUrl('https://steamcommunity.com/tradeoffer/new/?partner=12345'), null);
  assert.equal(normalizePhone('8 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizePhone('+7 999 123 45 6'), null);
  assert.equal(normalizeTelegram('https://t.me/luxe_player'), '@luxe_player');
  assert.equal(normalizeTelegram('@ab'), null);
  assert.equal(normalizeCard(CARD), '4111111111111111');
  assert.equal(normalizeCard('1234 5678 9012 3456'), null);
  assert.equal(rublesToKop('1 500,50'), 150050);
  assert.ok(Number.isNaN(rublesToKop('-5')));
});
