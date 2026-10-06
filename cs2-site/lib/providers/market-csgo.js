// Выдача скинов через market.csgo.com: сайт покупает скин на маркете и маркет сам отправляет его
// игроку на трейд-ссылку. Свой Steam-бот для этого не нужен.
// Документация: https://market.csgo.com/ru/api  (раздел «Покупка для другого пользователя», buy-for)
//
// ВАЖНО: перед запуском сверьте с документацией единицы цены (PRICE_UNITS) и статусы (STAGE_*):
// маркет иногда меняет API. Если ключ MARKET_API_KEY не задан, вывод уходит админу на ручную обработку.

import { config } from '../config.js';

const BASE = 'https://market.csgo.com/api/v2';
const PRICE_UNITS = 100;          // цена в запросе: рубли × 100 (копейки) — проверьте в документации
const MAX_OVERPAY = 0.1;          // готовы переплатить до 10% от нашей цены
const STAGE_SENT = new Set(['2']); // предмет передан покупателю
const STAGE_FAILED = new Set(['5']); // сделка отменена

export const isConfigured = () => Boolean(config.marketApiKey);

export async function buyFor({ hashName, price, partner, token, customId }, fetchImpl = fetch) {
  const p = new URLSearchParams({
    key: config.marketApiKey,
    hash_name: hashName,
    price: String(Math.ceil((price * (1 + MAX_OVERPAY)) / 100 * PRICE_UNITS)),
    partner,
    token,
    custom_id: customId,
  });
  const res = await fetchImpl(`${BASE}/buy-for?${p}`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(data.error || `market.csgo ответил ${res.status}`);
  return { providerId: String(data.id ?? customId) };
}

// 'sent' | 'failed' | 'processing'
export async function checkStatus(customId, fetchImpl = fetch) {
  const p = new URLSearchParams({ key: config.marketApiKey, custom_id: customId });
  const res = await fetchImpl(`${BASE}/get-buy-info-by-custom-id?${p}`, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => ({}));
  const stage = String(data?.data?.stage ?? '');
  if (STAGE_SENT.has(stage)) return 'sent';
  if (STAGE_FAILED.has(stage)) return 'failed';
  return 'processing';
}
