// Steam: вход через OpenID 2.0, профиль игрока, публичный инвентарь CS2.
// Пароль игрок вводит только на steamcommunity.com — к нам приходит лишь подтверждённый Steam ID.

import { config } from './config.js';

const OPENID = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const CLAIMED = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export const STEAM_IMAGE = (icon) => `https://community.akamai.steamstatic.com/economy/image/${icon}/256fx256f`;

export function loginUrl(returnTo) {
  const p = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': config.siteUrl,
    'openid.identity': `${NS}/identifier_select`,
    'openid.claimed_id': `${NS}/identifier_select`,
  });
  return `${OPENID}?${p}`;
}

// Проверяем ответ Steam: подпись подтверждает сам Steam (check_authentication).
// Возвращает Steam ID или null.
export async function verifyLogin(query, expectedReturnTo, fetchImpl = fetch) {
  if (query.get('openid.mode') !== 'id_res') return null;
  if (query.get('openid.op_endpoint') !== OPENID) return null;
  // return_to должен указывать на наш сайт, иначе ответ могли перехватить с чужого
  const returnTo = query.get('openid.return_to') || '';
  if (!returnTo.startsWith(expectedReturnTo)) return null;
  const m = (query.get('openid.claimed_id') || '').match(CLAIMED);
  if (!m || query.get('openid.identity') !== query.get('openid.claimed_id')) return null;

  const body = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith('openid.')) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return /is_valid\s*:\s*true/.test(text) ? m[1] : null;
}

// Имя и аватар. Без STEAM_API_KEY вернём заглушку — вход всё равно работает.
export async function getProfile(steamId, fetchImpl = fetch) {
  const fallback = { name: `Игрок ${steamId.slice(-5)}`, avatar: null };
  if (!config.steamApiKey) return fallback;
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${config.steamApiKey}&steamids=${steamId}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    const p = (await res.json())?.response?.players?.[0];
    return p ? { name: String(p.personaname || fallback.name).slice(0, 64), avatar: p.avatarfull || null } : fallback;
  } catch {
    return fallback;
  }
}

// Публичный инвентарь CS2 (appid 730, context 2). Steam ограничивает частоту — результат кэшируем в базе.
export async function fetchInventory(steamId, fetchImpl = fetch) {
  const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 403) throw Object.assign(new Error('private'), { code: 'private' });
  if (res.status === 429) throw Object.assign(new Error('rate'), { code: 'rate' });
  if (!res.ok) throw Object.assign(new Error(`steam ${res.status}`), { code: 'steam' });
  const data = await res.json();
  if (!data || data.success !== 1) return [];
  const descr = new Map((data.descriptions || []).map((d) => [`${d.classid}_${d.instanceid}`, d]));
  return (data.assets || [])
    .map((a) => {
      const d = descr.get(`${a.classid}_${a.instanceid}`);
      if (!d) return null;
      return {
        assetId: String(a.assetid),
        hashName: d.market_hash_name,
        name: d.name,
        image: d.icon_url ? STEAM_IMAGE(d.icon_url) : null,
        tradable: d.tradable === 1,
        marketable: d.marketable === 1,
      };
    })
    .filter(Boolean);
}

// Админ — по Steam ID (ADMIN_STEAM_IDS) или по Telegram ID (ADMIN_TG_IDS)
export const isAdmin = (u) => Boolean(u) && ((u.steam_id && config.adminSteamIds.includes(String(u.steam_id)))
  || (u.telegram_id && config.adminTgIds.includes(String(u.telegram_id))));
