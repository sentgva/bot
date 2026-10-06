// Живые данные для ленты над сайтом и главной: онлайн, последние выигрыши, лучший дроп.
// Всё считается по базе — ничего не выдумываем.
//   • онлайн — сколько разных посетителей (игрок или IP) открывали сайт за последние 2 минуты;
//   • лучший дроп — самый дорогой реальный выигрыш за 7 дней; если выигрышей ещё не было —
//     самый дорогой скин маркета как «главный приз» (так и подписан на сайте).

import { getDb } from './db.js';
import { publicItem } from './catalog.js';
import { recentWins } from './upgrade.js';
import { getSettings } from './settings.js';

const ONLINE_WINDOW = "interval '2 minutes'";
let cache = { at: 0, value: null };

async function dropsAndBest() {
  if (cache.value && Date.now() - cache.at < 10_000) return cache.value;
  const db = await getDb();
  const s = await getSettings();
  const drops = await recentWins(20);
  const win = await db.one(
    `select up.id, up.chance_ppm, up.input_value, up.created_at, us.name as user_name, i.*
     from upgrades up join users us on us.id = up.user_id join items i on i.hash_name = up.target_hash_name
     where up.won and up.created_at > now() - interval '7 days' order by up.target_price desc, up.id desc limit 1`,
  );
  let best;
  if (win) {
    best = { type: 'win', item: publicItem(win), user: win.user_name, chance: win.chance_ppm, inputValue: win.input_value, at: win.created_at };
  } else {
    const top = await db.one('select * from items where quantity > 0 order by price desc limit 1');
    // Минимальная ставка, с которой этот скин можно выбить (шанс не меньше минимального)
    best = top ? { type: 'top', item: publicItem(top), minStake: Math.ceil((top.price * s.minChance) / (1 - s.houseEdge)) } : null;
  }
  cache = { at: Date.now(), value: { drops, best } };
  return cache.value;
}

export async function getLive(visitorKey) {
  const db = await getDb();
  await db.query(
    'insert into presence (key, seen_at) values ($1, now()) on conflict (key) do update set seen_at = now()',
    [visitorKey],
  );
  if (Math.random() < 0.02) await db.query("delete from presence where seen_at < now() - interval '1 hour'").catch(() => {});
  const { count } = await db.one(`select count(*)::int as count from presence where seen_at > now() - ${ONLINE_WINDOW}`);
  return { online: count, ...(await dropsAndBest()) };
}

export function resetLiveCache() { cache = { at: 0, value: null }; }
