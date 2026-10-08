// Слоты «Dust Slots» в духе The Dog House, но по CS: 5 барабанов × 3 ряда, 20 линий.
//
//   • Символы — настоящие скины (картинки из Steam): от Glock-18 до Karambit.
//   • Wild — перчатки, только на барабанах 2–4, заменяют любой символ кроме кейса. Бывают ×2 и ×3 —
//     множители wild-ов на выигрышной линии перемножаются (как у «собак»).
//   • Scatter — кейс: 3 / 4 / 5+ где угодно → 8 / 12 / 20 фриспинов, все выигрыши во фриспинах ×2.
//   • Каждая клетка — отдельный честный бросок: HMAC-SHA256(server_seed, `${client_seed}:${nonce}:${спин}:${клетка}`).
//
// Возврат считается ТОЧНО (перебор всех комбинаций линии + распределение кейсов), а выплаты масштабируются
// коэффициентом k так, чтобы средний возврат был ровно 1 − casinoEdge — как у ракетки, мин и костей.

import { ROLL_MAX, computeRoll } from './fair.js';

export const REELS = 5;
export const ROWS = 3;

// Символы: id, название, картинка (Steam CDN), выплаты за 3 / 4 / 5 подряд в ставках на линию
const IMG = 'https://community.akamai.steamstatic.com/economy/image/';
export const SYMBOLS = [
  { id: 'glock', name: 'Glock-18 | Fade', pays: [5, 10, 25], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL2kpnj9h1a7s2oaaBoH_yaCW-Ej-8u5bZvHnq1w0Vz62TUzNj4eCiVblMmXMAkROJeskLpkdXjMrzksVTAy9US8PY25So' },
  { id: 'usp', name: 'USP-S | Kill Confirmed', pays: [5, 10, 25], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLkjYbf7itX6vytbbZSI-WsG3SA_uV_vO1WTCa9kxQ1vjiBpYPwJiPTcFB2Xpp5TO5cskG9lYCxZu_jsVCL3o4Xnij23ClO5ik9tegFA_It8qHJz1aWe-uc160' },
  { id: 'p250', name: 'P250 | Asiimov', pays: [5, 15, 40], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLhzMOwwiFO0OL8PfRSIeOaB2qf19F6ueZhW2fixx53tWqEm4ugeXuebQN0CZJyRrMJuxm4loCyPr_i51TfjtgXzi79kGoXuUXmUJzm' },
  { id: 'deagle', name: 'Desert Eagle | Blaze', pays: [10, 25, 75], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL1m5fn8Sdk7vORbqhsLfWAMWuZxuZi_uI_TX6wxxkjsGXXnImsJ37COlUoWcByEOMOtxa5kdXmNu3htVPZjN1bjXKpkHLRfQU' },
  { id: 'm4a1s', name: 'M4A1-S | Hyper Beast', pays: [10, 30, 100], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8ypexwjFS4_ega6F_H_OGMWrEwL9JuPh5SjuMlxgmoCm6lob-KT-JbwF1WZEjR-YJskK9k9XiYePltAeNjYlAxSn5j34dvCZstb4LB6Ut-7qX0V8Xkv5_2A' },
  { id: 'ak', name: 'AK-47 | Fire Serpent', pays: [15, 40, 150], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwlcK3wiFO0PSneqF-JeKDC2mE_u995LZWTTuygxIYvzSCkpu3cnvFPQB2DpUkROFY4Rntw93lP7i241DbiI1BxSuviHlKunk_6-sHU71lpPMTRLyP4Q' },
  { id: 'awp', name: 'AWP | Dragon Lore', pays: [25, 75, 250], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwiYbf_jdk4veqYaF7IfysCnWRxuF4j-B-Xxa_nBovp3Pdwtj9cC_GaAd0DZdwQu9fuhS4kNy0NePntVTbjYpCyyT_3CgY5i9j_a9cBkcCWUKV' },
  { id: 'karambit', name: '★ Karambit | Fade', pays: [50, 150, 750], img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL6kJ_m-B1Q7uCvZaZkNM-SD1iWwOpzj-1gSCGn20tztm_UyIn_JHKUbgYlWMcmQ-ZcskSwldS0MOnntAfd3YlMzH35jntXrnE8SOGRGG8' },
  { id: 'wild2', name: '★ Sport Gloves | Pandora\'s Box', wild: 2, img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Tk5UvzWCL2kpn2-DFk_OKherB0H-CGHHecxNF6ueZhW2exk01w4j7cmYn4eHPCbAMhApdwTOIN5BPsx9yyYu605FTeid0Uy3j3kGoXueKyz5wo' },
  { id: 'wild3', name: '★ Sport Gloves | Pandora\'s Box', wild: 3, img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Tk5UvzWCL2kpn2-DFk_OKherB0H-CGHHecxNF6ueZhW2exk01w4j7cmYn4eHPCbAMhApdwTOIN5BPsx9yyYu605FTeid0Uy3j3kGoXueKyz5wo' },
  { id: 'case', name: 'Kilowatt Case', scatter: true, img: 'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XsnXwtmkJjSU91dh8bj35VTqVBP4io_frnEVvqf_a6VoIfGSXz7Hlbwg57QwSS_mxhl15jiGyN37c3_GZw91W8BwRflK7EfKsa2sfw' },
].map((s, i) => ({ ...s, index: i, img: IMG + s.img }));
const BY_ID = Object.fromEntries(SYMBOLS.map((s) => [s.id, s.index]));

// Веса символов на барабанах (чем больше — тем чаще). Wild-перчатки — только на 2–4 барабанах.
const BASE = { glock: 26, usp: 26, p250: 22, deagle: 16, m4a1s: 13, ak: 9, awp: 6, karambit: 3, case: 4 };
const WILDS = { wild2: 3, wild3: 1 };
export const REEL_WEIGHTS = Array.from({ length: REELS }, (_, r) => {
  const w = { ...BASE, ...(r >= 1 && r <= 3 ? WILDS : {}) };
  return SYMBOLS.map((s) => w[s.id] || 0);
});

// 20 линий: номер ряда (0 — верх) на каждом барабане
export const LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
  [1, 0, 1, 2, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 0, 2, 0],
];
export const FREE_SPINS = { 3: 8, 4: 12, 5: 20 }; // кейсов → фриспинов (5 и больше — 20)
export const FS_MULT = 2;

// Выигрыш линии по символам на ней (в ставках на линию). Первый символ — не wild (их нет на 1-м барабане).
export function lineWin(syms) {
  const first = SYMBOLS[syms[0]];
  if (first.scatter || first.wild) return null;
  let count = 1;
  let mult = 1;
  for (let r = 1; r < REELS; r++) {
    const s = SYMBOLS[syms[r]];
    if (syms[r] === first.index) count++;
    else if (s.wild) { count++; mult *= s.wild; } else break;
  }
  if (count < 3) return null;
  return { symbol: first.id, count, mult, pay: first.pays[count - 3] * mult };
}

// ── Точный возврат (RTP) при k = 1 ─────────────────────────

function probs() {
  return REEL_WEIGHTS.map((w) => { const t = w.reduce((a, b) => a + b, 0); return w.map((x) => x / t); });
}

// Средний выигрыш одной линии (в ставках на линию): полный перебор 5 барабанов
function lineEv() {
  const P = probs();
  let ev = 0;
  const syms = [0, 0, 0, 0, 0];
  const rec = (r, p) => {
    if (r === REELS) { const w = lineWin(syms); if (w) ev += p * w.pay; return; }
    for (let i = 0; i < SYMBOLS.length; i++) {
      if (!P[r][i]) continue;
      syms[r] = i;
      rec(r + 1, p * P[r][i]);
    }
  };
  rec(0, 1);
  return ev;
}

// Распределение числа кейсов на поле 5×3
function scatterDist() {
  const P = probs();
  let dist = [1];
  for (let r = 0; r < REELS; r++) {
    const p = P[r][BY_ID.case];
    for (let j = 0; j < ROWS; j++) {
      const next = new Array(dist.length + 1).fill(0);
      dist.forEach((v, k) => { next[k] += v * (1 - p); next[k + 1] += v * p; });
      dist = next;
    }
  }
  return dist;
}

const fsFor = (n) => (n >= 5 ? FREE_SPINS[5] : FREE_SPINS[n] || 0);

export function rawStats() {
  const spinEv = lineEv(); // 20 линий × ставка/20 = средний выигрыш спина в ставках
  const dist = scatterDist();
  const fsAvg = dist.reduce((a, p, n) => a + p * fsFor(n), 0);
  const trigger = dist.reduce((a, p, n) => a + (fsFor(n) ? p : 0), 0);
  return { spinEv, fsAvg, trigger, rtp: spinEv + fsAvg * FS_MULT * spinEv };
}
const RAW = rawStats();
// Коэффициент выплат под нужный край казино
export const payScale = (edge) => (1 - edge) / RAW.rtp;

// ── Игра ───────────────────────────────────────────────────

function pick(weights, u) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = u * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x < 0) return i; }
  return weights.length - 1;
}

// Поле спина: grid[барабан][ряд] — индекс символа
export function spinGrid(serverSeed, clientSeed, nonce, spin) {
  return Array.from({ length: REELS }, (_, r) => Array.from({ length: ROWS }, (_, j) => {
    const roll = computeRoll(serverSeed, clientSeed, `${nonce}:${spin}:${r * ROWS + j}`);
    return pick(REEL_WEIGHTS[r], roll / ROLL_MAX);
  }));
}

// Выигрыши поля: линии и число кейсов. win — в ставках (сумма линий ÷ 20)
export function evaluate(grid) {
  const lines = [];
  LINES.forEach((rows, i) => {
    const w = lineWin(rows.map((row, r) => grid[r][row]));
    if (w) lines.push({ line: i, ...w });
  });
  const scatters = grid.flat().filter((s) => s === BY_ID.case).length;
  return { lines, scatters, win: lines.reduce((a, l) => a + l.pay, 0) / LINES.length };
}

// Полный раунд: основной спин + фриспины (если выпали). total — множитель к ставке при k = 1.
export function playRound(serverSeed, clientSeed, nonce) {
  const base = { grid: spinGrid(serverSeed, clientSeed, nonce, 0), ...{} };
  Object.assign(base, evaluate(base.grid));
  const free = [];
  const n = fsFor(base.scatters);
  for (let s = 1; s <= n; s++) {
    const grid = spinGrid(serverSeed, clientSeed, nonce, s);
    const e = evaluate(grid);
    free.push({ grid, lines: e.lines, scatters: e.scatters, win: e.win * FS_MULT });
  }
  const total = base.win + free.reduce((a, f) => a + f.win, 0);
  return { base, free, total };
}

export const slotsInfo = (edge) => {
  const k = payScale(edge);
  return {
    symbols: SYMBOLS.map((s) => ({ id: s.id, name: s.name, img: s.img, wild: s.wild || null, scatter: Boolean(s.scatter),
      // выплата за 3/4/5 в ставках (с учётом коэффициента)
      pays: s.pays ? s.pays.map((p) => Math.floor((p * k * 100) / LINES.length) / 100) : null })),
    lines: LINES, freeSpins: FREE_SPINS, fsMult: FS_MULT, rtp: 1 - edge,
  };
};
