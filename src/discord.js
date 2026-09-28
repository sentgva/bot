import { discordInvite } from './content.js';

// Живые цифры сервера из публичного инвайта. Discord легко отдаёт 429,
// поэтому держим кэш и при ошибке показываем последнее известное значение.

const TTL = 10 * 60 * 1000;
const RETRY = 2 * 60 * 1000;

let cache = { members: null, online: null };
let nextFetchAt = 0;
let inflight = null;

async function refresh() {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(discordInvite)}?with_counts=true`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    const data = await res.json();
    cache = {
      members: data.approximate_member_count ?? cache.members,
      online: data.approximate_presence_count ?? cache.online,
    };
    nextFetchAt = Date.now() + TTL;
  } catch (err) {
    nextFetchAt = Date.now() + RETRY;
    console.warn('Не удалось обновить статистику Discord:', err.message);
  } finally {
    inflight = null;
  }
}

export async function discordStats() {
  if (Date.now() >= nextFetchAt && !inflight) inflight = refresh();
  // Первый раз ждём ответа, дальше отдаём кэш сразу и обновляем в фоне
  if (cache.members === null && inflight) await inflight;
  return cache;
}
