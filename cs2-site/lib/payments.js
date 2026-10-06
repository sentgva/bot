// Деньги: пополнение (крипта, демо) и вывод (карта, СБП, крипта).
//
// Вывод: сумма сразу списывается с баланса (замораживается) и создаётся выплата.
//   • Крипта до cryptoAutoLimit — автоматически: создаём чек в @CryptoBot, игрок забирает его по ссылке.
//   • Карта / СБП и крупная крипта — в админку и Telegram, админ платит и жмёт «Выплачено».
//   • Отказ — деньги возвращаются на баланс.

import { config } from './config.js';
import { getDb } from './db.js';
import { fail } from './http.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { maskCard, normalizeCard, normalizePhone } from './validate.js';
import { canEncrypt, decrypt, encrypt } from './crypto-box.js';
import { notifyAdmin, rub } from './notify.js';
import * as cryptopay from './providers/cryptopay.js';

export const BANKS = ['Сбербанк', 'Т-Банк', 'Альфа-Банк', 'ВТБ', 'Газпромбанк', 'Райффайзенбанк', 'Озон Банк', 'Яндекс Банк', 'Другой банк'];

export function methodsInfo(s) {
  return {
    card: { enabled: canEncrypt(), fee: s.cardFee },
    sbp: { enabled: true, fee: s.cardFee },
    crypto: { enabled: cryptopay.isConfigured(), fee: s.cryptoFee, assets: cryptopay.ASSETS },
    deposit: { crypto: cryptopay.isConfigured(), demo: config.demoTopup },
    minWithdraw: s.minWithdraw,
    maxWithdraw: s.maxWithdraw,
    minDeposit: s.minDeposit,
    banks: BANKS,
  };
}

// ── Пополнение ─────────────────────────────────────────────

export async function createCryptoDeposit(userId, amount) {
  const s = await getSettings();
  if (!cryptopay.isConfigured()) fail(503, 'Пополнение криптой временно недоступно');
  if (!Number.isSafeInteger(amount) || amount < s.minDeposit) fail(400, `Минимальное пополнение — ${rub(s.minDeposit)}`);
  if (amount > 100_000_000) fail(400, 'Слишком большая сумма за раз');
  const db = await getDb();
  const p = await db.one(
    `insert into payments (user_id, direction, method, amount, status) values ($1, 'in', 'crypto', $2, 'pending') returning id`,
    [userId, amount],
  );
  try {
    const inv = await cryptopay.createInvoice({ amountKop: amount, payload: `dep:${p.id}` });
    await db.query(`update payments set provider_id = $2, details = $3 where id = $1`, [p.id, inv.invoiceId, JSON.stringify({ url: inv.url })]);
    return { id: p.id, url: inv.url };
  } catch (err) {
    await db.query(`update payments set status = 'failed', details = $2 where id = $1`, [p.id, JSON.stringify({ error: err.message })]);
    fail(502, 'Не получилось создать счёт. Попробуй ещё раз через минуту');
  }
}

// Вебхук Crypto Pay. Повторная доставка того же счёта ничего не зачислит второй раз.
export async function handleCryptoWebhook(rawBody, signature) {
  if (!cryptopay.verifyWebhook(rawBody, signature)) fail(401, 'bad signature');
  const update = JSON.parse(rawBody);
  if (update.update_type !== 'invoice_paid') return { ok: true, skipped: true };
  const inv = update.payload || {};
  const m = String(inv.payload || '').match(/^dep:(\d+)$/);
  if (!m) return { ok: true, skipped: true };
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await q.one(`select * from payments where id = $1 and direction = 'in' and method = 'crypto' for update`, [Number(m[1])]);
    if (!p || p.status === 'paid') return { ok: true, duplicate: true };
    if (String(inv.invoice_id) !== p.provider_id || inv.fiat !== 'RUB' || Math.round(Number(inv.amount) * 100) !== p.amount) {
      await q.query(`update payments set status = 'review', details = details || $2 where id = $1`, [p.id, JSON.stringify({ mismatch: inv })]);
      await notifyAdmin([`⚠️ Пополнение #${p.id}: данные счёта не совпали, проверь вручную`]);
      return { ok: true, review: true };
    }
    await q.query(
      `update payments set status = 'paid', paid_at = now(), updated_at = now(), details = details || $2 where id = $1`,
      [p.id, JSON.stringify({ paidAsset: inv.paid_asset, paidAmount: inv.paid_amount })],
    );
    await changeBalance(q, p.user_id, p.amount, 'deposit', { ref: `payment:${p.id}`, note: `крипта ${inv.paid_asset || ''}`.trim() });
    return { ok: true };
  });
}

// Тестовое пополнение для стенда (DEMO_TOPUP=1)
export async function demoTopup(userId) {
  if (!config.demoTopup) fail(404, 'Недоступно');
  const amount = 500_000;
  const db = await getDb();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const p = await q.one(
      `insert into payments (user_id, direction, method, amount, status, paid_at) values ($1, 'in', 'demo', $2, 'paid', now()) returning id`,
      [userId, amount],
    );
    const balance = await changeBalance(q, userId, amount, 'demo', { ref: `payment:${p.id}`, note: 'тестовое пополнение' });
    return { balance };
  });
}

// ── Вывод ──────────────────────────────────────────────────

export async function requestWithdraw(userId, input) {
  const s = await getSettings();
  const info = methodsInfo(s);
  const { method, amount } = input;
  if (!['card', 'sbp', 'crypto'].includes(method) || !info[method].enabled) fail(400, 'Этот способ вывода сейчас недоступен');
  if (!Number.isSafeInteger(amount) || amount < s.minWithdraw) fail(400, `Минимальный вывод — ${rub(s.minWithdraw)}`);
  if (amount > s.maxWithdraw) fail(400, `Максимум за раз — ${rub(s.maxWithdraw)}`);

  const details = {};
  if (method === 'card') {
    const card = normalizeCard(input.card);
    if (!card) fail(400, 'Проверь номер карты', { field: 'card' });
    Object.assign(details, { card: maskCard(card), cardEnc: encrypt(card) });
  } else if (method === 'sbp') {
    const phone = normalizePhone(input.phone);
    if (!phone) fail(400, 'Проверь номер телефона', { field: 'phone' });
    if (!BANKS.includes(input.bank)) fail(400, 'Выбери банк', { field: 'bank' });
    Object.assign(details, { phone, bank: input.bank });
  } else {
    if (!cryptopay.ASSETS.includes(input.asset)) fail(400, 'Выбери монету', { field: 'asset' });
    details.asset = input.asset;
  }

  const fee = Math.ceil(amount * (method === 'crypto' ? s.cryptoFee : s.cardFee));
  const auto = method === 'crypto' && amount <= s.cryptoAutoLimit;
  const db = await getDb();
  const p = await db.tx(async (q) => {
    await lockUser(q, userId);
    const row = await q.one(
      `insert into payments (user_id, direction, method, amount, fee, status, details) values ($1, 'out', $2, $3, $4, $5, $6) returning *`,
      [userId, method, amount, fee, auto ? 'processing' : 'review', JSON.stringify(details)],
    );
    await changeBalance(q, userId, -amount, 'withdraw', { ref: `payment:${row.id}`, note: method });
    return row;
  });

  if (auto) {
    const done = await sendCryptoCheck(p.id).catch(() => null);
    if (done) return { id: p.id, status: 'paid', checkUrl: done.url };
  }
  const what = method === 'card' ? `карта ${details.card}` : method === 'sbp' ? `СБП ${details.phone}, ${details.bank}` : `крипта ${details.asset}`;
  await notifyAdmin(['💸 Новая заявка на вывод', `#${p.id}: ${rub(amount - fee)} (комиссия ${rub(fee)})`, what]);
  return { id: p.id, status: 'review' };
}

// Создать чек @CryptoBot по выплате (авто или по кнопке админа)
export async function sendCryptoCheck(paymentId) {
  const db = await getDb();
  // Атомарно «захватываем» выплату, чтобы два параллельных запроса не создали два чека
  const p = await db.one(
    `update payments set status = 'sending', updated_at = now()
     where id = $1 and direction = 'out' and method = 'crypto' and status in ('processing', 'review') returning *`,
    [paymentId],
  );
  if (!p) fail(409, 'Выплата уже обработана');
  try {
    const check = await cryptopay.createCheck({ asset: p.details.asset, amountKop: p.amount - p.fee });
    await db.query(
      `update payments set status = 'paid', paid_at = now(), updated_at = now(), provider_id = $2, details = details || $3 where id = $1`,
      [p.id, check.checkId, JSON.stringify({ checkUrl: check.url, cryptoAmount: check.amount, rate: check.rate })],
    );
    return check;
  } catch (err) {
    await db.query(`update payments set status = 'review', updated_at = now(), details = details || $2 where id = $1`, [p.id, JSON.stringify({ error: err.message })]);
    await notifyAdmin([`⚠️ Авто-вывод #${p.id} не прошёл: ${err.message}`, 'Заявка на ручной проверке']);
    throw err;
  }
}

// Админ: выплачено вручную или отказ с возвратом денег
export async function finishWithdraw(paymentId, action, note = '') {
  const db = await getDb();
  return db.tx(async (q) => {
    const p = await q.one(`select * from payments where id = $1 and direction = 'out' and status in ('review', 'processing', 'sending') for update`, [paymentId]);
    if (!p) fail(409, 'Выплата уже обработана');
    const details = { ...p.details, adminNote: note || undefined };
    delete details.cardEnc; // номер карты больше не нужен
    if (action === 'paid') {
      await q.query(`update payments set status = 'paid', paid_at = now(), updated_at = now(), details = $2 where id = $1`, [p.id, JSON.stringify(details)]);
    } else if (action === 'reject') {
      await q.query(`update payments set status = 'rejected', updated_at = now(), details = $2 where id = $1`, [p.id, JSON.stringify(details)]);
      await changeBalance(q, p.user_id, p.amount, 'refund', { ref: `payment:${p.id}`, note: note || 'вывод отклонён' });
    } else {
      fail(400, 'Неизвестное действие');
    }
    return { id: p.id, status: action === 'paid' ? 'paid' : 'rejected' };
  });
}

export const revealCard = (details) => (details?.cardEnc ? decrypt(details.cardEnc) : null);

// Для игрока: без зашифрованных данных и служебных ошибок
export async function listPayments(userId) {
  const db = await getDb();
  const rows = await db.query(
    `select id, direction, method, amount, fee, status, details, created_at, paid_at from payments
     where user_id = $1 and status <> 'failed' order by id desc limit 50`,
    [userId],
  );
  return rows.map((r) => {
    const { card, phone, bank, asset, checkUrl, cryptoAmount, url } = r.details || {};
    const own = r.status === 'pending' ? { url } : {};
    return { ...r, details: { card, phone, bank, asset, checkUrl, cryptoAmount, ...own } };
  });
}
