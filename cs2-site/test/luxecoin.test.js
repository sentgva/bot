import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, balanceOf } from './helpers.js';
import { config } from '../lib/config.js';
import { getDb } from '../lib/db.js';
import { floorLc, fmtLc, starsToLc } from '../lib/lc.js';
import { buyPrice, sellPrice } from '../lib/inventory.js';
import { DEFAULTS } from '../lib/settings.js';
import { createStarsInvoice, handlePreCheckout, handleStarsPaid, requestWithdraw } from '../lib/payments.js';
import { runUpgrade } from '../lib/upgrade.js';

beforeEach(freshDb);

// Подмена Telegram Bot API: запоминаем вызовы
function fakeTelegram() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ method, body: JSON.parse(init.body) });
    const result = method === 'createInvoiceLink' ? 'https://t.me/$TestInvoice' : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return { calls, fetchImpl };
}

test('LuxeCoin: всё округляется вниз до целых LC', () => {
  assert.equal(floorLc(125099), 125000);
  assert.equal(fmtLc(125099).replace(/\s/g, ' '), '1 250 LC');
  assert.equal(starsToLc(77, 1.3), 10000, '77 ⭐ × 1,3 = 100,1 → 100 LC');
  assert.equal(starsToLc(76, 1.3), 9800, '76 ⭐ × 1,3 = 98,8 → 98 LC');
  assert.equal(buyPrice(125000, DEFAULTS), 131200, '1250 LC + 5% = 1312,5 → 1312 LC');
  assert.equal(sellPrice(125000, DEFAULTS), 118700, '1250 LC × 95% = 1187,5 → 1187 LC');
});

test('ставка и вывод — только целые LC', async () => {
  const u = await makeUser(100_000);
  await assert.rejects(runUpgrade(u.id, { balance: 20_050, target: 'AWP | Asiimov (Field-Tested)' }), /целое число LC/);
  await assert.rejects(requestWithdraw(u.id, { method: 'sbp', amount: 60_050, phone: '+79991234567', bank: 'Т-Банк' }), /целое число LC/);
});

test('звёзды: счёт → проверка перед оплатой → зачисление ровно один раз', async () => {
  config.tgBotToken = '123:stars-test';
  try {
    const u = await makeUser(0);
    const tg = fakeTelegram();
    await assert.rejects(createStarsInvoice(u.id, 10, tg.fetchImpl), /от 50/);
    const inv = await createStarsInvoice(u.id, 77, tg.fetchImpl);
    assert.equal(inv.url, 'https://t.me/$TestInvoice');
    assert.equal(inv.amount, 10_000, '77 ⭐ → 100 LC');
    const link = tg.calls.find((c) => c.method === 'createInvoiceLink').body;
    assert.equal(link.currency, 'XTR');
    assert.deepEqual(link.prices, [{ label: '100 LC', amount: 77 }]);
    assert.equal(link.payload, `stars:${inv.id}`);

    // Перед оплатой: верная сумма — ок, подменённая — отказ
    assert.equal(await handlePreCheckout({ id: 'q1', currency: 'XTR', total_amount: 77, invoice_payload: link.payload }, tg.fetchImpl), true);
    assert.equal(await handlePreCheckout({ id: 'q2', currency: 'XTR', total_amount: 1, invoice_payload: link.payload }, tg.fetchImpl), false);
    assert.equal(tg.calls.filter((c) => c.method === 'answerPreCheckoutQuery').at(-1).body.ok, false);

    const paid = { chat: { id: 5 }, from: { id: 5 }, successful_payment: { currency: 'XTR', total_amount: 77, invoice_payload: link.payload, telegram_payment_charge_id: 'ch_1' } };
    assert.equal((await handleStarsPaid(paid, tg.fetchImpl)).ok, true);
    assert.equal((await handleStarsPaid(paid, tg.fetchImpl)).duplicate, true, 'повтор от Telegram не начисляет второй раз');
    const b = await balanceOf(u.id);
    assert.equal(b.balance, 10_000);
    assert.equal(b.ledger, 10_000);
    assert.match(tg.calls.find((c) => c.method === 'sendMessage').body.text, /Зачислено 100 LC за 77 ⭐/);

    // Оплаченный счёт больше не принимается
    assert.equal(await handlePreCheckout({ id: 'q3', currency: 'XTR', total_amount: 77, invoice_payload: link.payload }, tg.fetchImpl), false);
    const p = await (await getDb()).one('select status, provider_id from payments where id = $1', [inv.id]);
    assert.deepEqual(p, { status: 'paid', provider_id: 'ch_1' });
  } finally {
    config.tgBotToken = '';
  }
});

test('акция на пополнение: +N% к оплате звёздами, пока идёт; после окончания — без бонуса', async () => {
  const { updateSettings, depositBonusNow } = await import('../lib/settings.js');
  config.tgBotToken = '123:stars-test';
  try {
    const u = await makeUser(0);
    const start = (await balanceOf(u.id)).balance;
    const tg = fakeTelegram();
    const pay = async (charge) => {
      const inv = await createStarsInvoice(u.id, 77, tg.fetchImpl);
      return handleStarsPaid({ chat: { id: 5 }, from: { id: 5 }, successful_payment: { currency: 'XTR', total_amount: 77, invoice_payload: `stars:${inv.id}`, telegram_payment_charge_id: charge } }, tg.fetchImpl);
    };
    await updateSettings({ depositBonus: 0.5, depositBonusUntil: Date.now() + 3600_000 });
    const r = await pay('ch_a');
    assert.equal(r.promoBonus, 5_000, '100 LC + 50% = +50 LC');
    assert.match(tg.calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, /Акция \+50%: \+50 LC/);
    // Акция закончилась по времени
    await updateSettings({ depositBonusUntil: Date.now() - 1000 });
    assert.equal(depositBonusNow({ depositBonus: 0.5, depositBonusUntil: Date.now() - 1000 }), null);
    assert.equal((await pay('ch_b')).promoBonus, 0);
    const b = await balanceOf(u.id);
    assert.equal(b.balance, start + 10_000 + 5_000 + 10_000);
    assert.equal(b.ledger, b.balance);
  } finally {
    config.tgBotToken = '';
    const { updateSettings } = await import('../lib/settings.js');
    await updateSettings({ depositBonus: 0, depositBonusUntil: 0 });
  }
});

test('пополнение звёздами: уведомление приходит всем админам в бота', async () => {
  config.tgBotToken = '123:stars-test';
  const owner = await makeUser(0);
  const helper = await makeUser(0);
  await (await getDb()).query('update users set is_admin = true where id = $1', [helper.id]);
  config.adminTgIds = [String(owner.telegram_id)];
  try {
    const u = await makeUser(0);
    const tg = fakeTelegram();
    const inv = await createStarsInvoice(u.id, 77, tg.fetchImpl);
    await handleStarsPaid({ chat: { id: 5 }, from: { id: 5 }, successful_payment: { currency: 'XTR', total_amount: 77, invoice_payload: `stars:${inv.id}`, telegram_payment_charge_id: 'ch_n' } }, tg.fetchImpl);
    const toAdmins = tg.calls.filter((c) => c.method === 'sendMessage' && /Пополнение: 77 ⭐ → 100 LC/.test(c.body.text));
    assert.deepEqual(toAdmins.map((c) => String(c.body.chat_id)).sort(), [String(owner.telegram_id), String(helper.telegram_id)].sort());
    assert.match(toAdmins[0].body.text, new RegExp(`ID ${u.id}`));
  } finally {
    config.tgBotToken = '';
    config.adminTgIds = [];
  }
});
