import { discordInvite } from './content.js';

// Живые цифры сервера из публичного инвайта. Discord легко отдаёт 429,
// поэтому кэшируем в хранилище на 10 минут, а при ошибке показываем последнее известное.

async function fetchCounts() {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(discordInvite)}?with_counts=true`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    const data = await res.json();
    return { members: data.approximate_member_count ?? null, online: data.approximate_presence_count ?? null };
  } catch (err) {
    console.warn('Не удалось обновить статистику Discord:', err.message);
    return null;
  }
}

let memo = null;

export async function discordStats(db) {
  if (memo && Date.now() - memo.at < 60_000) return memo.value;
  let value = await db.cacheGet('discord');
  if (!value && !(await db.cacheGet('discord:wait'))) {
    value = await fetchCounts();
    if (value) await Promise.all([db.cacheSet('discord', value, 600), db.cacheSet('discord:last', value, 30 * 86400)]);
    else await db.cacheSet('discord:wait', 1, 120);
  }
  value ||= (await db.cacheGet('discord:last')) || { members: null, online: null };
  memo = { at: Date.now(), value };
  return value;
}
