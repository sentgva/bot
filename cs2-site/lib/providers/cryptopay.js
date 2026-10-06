// Crypto Pay API (@CryptoBot): счета на пополнение и чеки на вывод в USDT / TON.
// Документация: https://help.crypt.bot/crypto-pay-api
//
// Пополнение: создаём счёт в рублях (currency_type=fiat), игрок платит USDT или TON,
//             Crypto Pay присылает вебхук invoice_paid → зачисляем рубли на баланс.
// Вывод:      создаём чек (createCheck) на сумму в USDT/TON. Игрок открывает ссылку в @CryptoBot,
//             забирает монеты и может вывести их на любой внешний кошелёк.

import crypto from 'node:crypto';
import { config } from '../config.js';

export const ASSETS = ['USDT', 'TON'];
export const isConfigured = () => Boolean(config.cryptoPayToken);

const base = () => (config.cryptoPayTestnet ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api');

async function call(method, params = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${base()}/${method}`, {
    method: 'POST',
    headers: { 'Crypto-Pay-API-Token': config.cryptoPayToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Crypto Pay ${method}: ${data.error?.name || data.error?.code || res.status}`);
  return data.result;
}

export async function createInvoice({ amountKop, payload, fetchImpl }) {
  const inv = await call('createInvoice', {
    currency_type: 'fiat',
    fiat: 'RUB',
    accepted_assets: ASSETS.join(','),
    amount: (amountKop / 100).toFixed(2),
    description: 'Пополнение баланса LuxeDrop',
    payload,
    paid_btn_name: 'callback',
    paid_btn_url: `${config.siteUrl}/profile/#wallet`,
    expires_in: 3600,
  }, fetchImpl);
  return { invoiceId: String(inv.invoice_id), url: inv.bot_invoice_url || inv.pay_url };
}

// Курс актива в рублях (сколько рублей стоит 1 USDT/TON)
export async function rateRub(asset, fetchImpl) {
  const rates = await call('getExchangeRates', {}, fetchImpl);
  const r = rates.find((x) => x.source === asset && x.target === 'RUB' && x.is_valid);
  if (!r) throw new Error(`Нет курса ${asset}/RUB`);
  return Number(r.rate);
}

export async function createCheck({ asset, amountKop, fetchImpl }) {
  const rate = await rateRub(asset, fetchImpl);
  // Округляем вниз, чтобы не выдать больше, чем списали
  const digits = asset === 'TON' ? 4 : 2;
  const amount = Math.floor((amountKop / 100 / rate) * 10 ** digits) / 10 ** digits;
  if (amount <= 0) throw new Error('Слишком маленькая сумма');
  const check = await call('createCheck', { asset, amount: amount.toFixed(digits) }, fetchImpl);
  return { checkId: String(check.check_id), url: check.bot_check_url, amount, asset, rate };
}

// Подпись вебхука: HMAC-SHA256(тело, SHA256(token)) в hex
export function verifyWebhook(rawBody, signature) {
  if (!config.cryptoPayToken || typeof signature !== 'string') return false;
  const secret = crypto.createHash('sha256').update(config.cryptoPayToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
