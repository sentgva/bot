// Собирает db/cs-cases.json — состав настоящих кейсов CS2 (названия, картинки, скины по редкостям)
// из открытого ByMykel/CSGO-API. Запуск вручную, когда хочется обновить список: node scripts/build-cs-cases.js
import fs from 'node:fs';

const API_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json';
// slug, название кейса в API, цвет подсветки на сайте
const PICK = [
  ['fever', 'Fever Case', '#ff6b3d'],
  ['gallery', 'Gallery Case', '#f4c430'],
  ['kilowatt', 'Kilowatt Case', '#3ec7ff'],
  ['revolution', 'Revolution Case', '#e2483d'],
  ['recoil', 'Recoil Case', '#7cc242'],
  ['dreams', 'Dreams & Nightmares Case', '#a875ff'],
  ['snakebite', 'Snakebite Case', '#57d68d'],
  ['fracture', 'Fracture Case', '#ff9f43'],
  ['prisma2', 'Prisma 2 Case', '#ff5fd2'],
  ['clutch', 'Clutch Case', '#5b8cff'],
];
const TIER = { rarity_rare_weapon: 'milspec', rarity_mythical_weapon: 'restricted', rarity_legendary_weapon: 'classified', rarity_ancient_weapon: 'covert' };

const list = await (await fetch(API_URL, { signal: AbortSignal.timeout(60000) })).json();
const out = PICK.map(([slug, apiName, color]) => {
  const c = list.find((x) => x.name === apiName);
  if (!c) throw new Error(`Нет кейса ${apiName}`);
  return {
    slug, name: apiName.replace(/ Case$/, ''), color, image: c.image,
    skins: c.contains.map((s) => ({ name: s.name, tier: TIER[s.rarity?.id] })).filter((s) => s.tier),
    rare: [...new Set((c.contains_rare || []).map((s) => s.name))],
  };
});
fs.writeFileSync(new URL('../db/cs-cases.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.map((c) => `${c.name}: ${c.skins.length} скинов, ${c.rare.length} редких`).join('\n'));
