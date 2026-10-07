// Живые данные для ленты над сайтом и главной: онлайн, последние выигрыши, лучший дроп.
// Всё считается по базе — ничего не выдумываем.
//   • онлайн — сколько разных посетителей (игрок или IP) открывали сайт за последние 2 минуты;
//   • лучший дроп — самый дорогой реальный выигрыш за 7 дней (не дороже bestDropMaxPrice); если таких нет —
//     самый дорогой скин маркета до этого порога как «главный приз» (так и подписан на сайте);
//   • цели — пока настоящих выигрышей мало, лента добирается реальными скинами каталога с подписью
//     «Можно выбить». Это витрина, а не выигрыши: на сайте они отделены и подписаны.

import { getDb } from './db.js';
import { publicItem } from './catalog.js';
import { recentWins } from './upgrade.js';
import { recentCaseDrops } from './cases.js';
import { getSettings } from './settings.js';

const ONLINE_WINDOW = "interval '2 minutes'";
const FEED_SIZE = 16; // сколько карточек держим в ленте
let cache = { at: 0, value: null };

async function dropsAndBest() {
  if (cache.value && Date.now() - cache.at < 10_000) return cache.value;
  const db = await getDb();
  const s = await getSettings();
  // Настоящие выигрыши: апгрейды и заносы из кейсов, вперемешку по времени
  const drops = [...await recentWins(20), ...await recentCaseDrops(20)]
    .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
  const win = await db.one(
    `select up.id, up.chance_ppm, up.input_value, up.created_at, i.*
     from upgrades up join items i on i.hash_name = up.target_hash_name
     where up.won and up.created_at > now() - interval '7 days' and up.target_price <= $1
     order by up.target_price desc, up.id desc limit 1`,
    [s.bestDropMaxPrice],
  );
  let best;
  if (win) {
    best = { type: 'win', item: publicItem(win), chance: win.chance_ppm, inputValue: win.input_value, at: win.created_at };
  } else {
    // Самый дорогой скин не дороже порога; ножи и перчатки — в приоритете, они эффектнее
    const top = await db.one(
      `select * from items where quantity > 0 and price <= $1 order by (rarity = 'gold') desc, price desc limit 1`,
      [s.bestDropMaxPrice],
    );
    // Минимальная ставка, с которой этот скин можно выбить (шанс не меньше минимального)
    best = top ? { type: 'top', item: publicItem(top), minStake: Math.max(s.minUpgradeValue, Math.ceil((top.price * s.minChance) / (1 - s.houseEdge) / 100) * 100) } : null;
  }
  // Подборка меняется раз в сутки (порядок по md5 от имени и даты), чтобы лента не прыгала при каждом опросе
  const targets = drops.length >= FEED_SIZE ? [] : (await db.query(
    `select * from items where quantity > 0 and image is not null and price between 30000 and $1
       and rarity in ('gold', 'covert', 'classified')
     order by md5(hash_name || current_date::text) limit $2`,
    [s.bestDropMaxPrice, FEED_SIZE - drops.length],
  )).map(publicItem);
  cache = { at: Date.now(), value: { drops, best, targets } };
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
