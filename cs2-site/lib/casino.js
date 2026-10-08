// Казино: ракетка (crash), мины и кости — в стилистике CS.
//
// Честность — тот же provably fair, что в апгрейдере и кейсах (lib/fair.js): каждая игра берёт следующий nonce игрока,
// бросок — HMAC-SHA256(server_seed, `${client_seed}:${nonce}`). Минам нужно несколько чисел — к nonce добавляется
// номер шага: `${client_seed}:${nonce}:${i}`. Всё решается в момент ставки и хранится на сервере, игрок видит только хэш сида.
//
// Край у всех игр один — casinoEdge (по умолчанию 5%): средний возврат = ставка × (1 − casinoEdge).
//   • Ракетка: точка взрыва = (1 − край) ÷ (1 − бросок), не ниже ×1,00. P(долетит до ×M) = (1 − край) ÷ M.
//     Множитель растёт как e^(K·t). Забрать можно в любой момент до взрыва (по времени сервера) или заранее задать автовывод.
//   • Мины: поле 5×5, от 1 до 24 «бомб C4». Множитель после k открытых клеток = (1 − край) × Π (25 − i) ÷ (25 − мин − i).
//   • Кости: число 0,00–99,99, ставка «меньше» или «больше» с шансом 1–95%. Выплата = (1 − край) ÷ шанс.
// Выплата — вниз до целого LC и не больше casinoMaxWin.

import { getDb } from './db.js';
import { fail } from './http.js';
import { getSettings } from './settings.js';
import { changeBalance, lockUser } from './users.js';
import { ROLL_MAX, computeRoll, hashSeed } from './fair.js';
import { fmtLc, floorLc, isWholeLc } from './lc.js';
import { addXp } from './vip.js';
import { FS_MULT, LINES, payScale, playRound } from './slots.js';

export const CRASH_K = 0.1;           // скорость ракетки: ×2 за ~6,9 с, ×10 за ~23 с, ×100 за ~46 с
export const CRASH_MAX = 1000;        // потолок множителя ракетки
export const MINES_CELLS = 25;
const NAMES = { crash: 'Ракетка', mines: 'Мины', dice: 'Кости', slots: 'Слоты' };

const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
export const crashMultAt = (ms) => floor2(Math.exp((CRASH_K * Math.max(0, ms)) / 1000));
const crashTimeOf = (mult) => (Math.log(mult) / CRASH_K) * 1000;

export function crashPoint(roll, edge) {
  const r = roll / ROLL_MAX;
  return Math.min(CRASH_MAX, Math.max(1, floor2((1 - edge) / (1 - r))));
}

export function minesMultiplier(opened, mines, edge) {
  let m = 1 - edge;
  for (let i = 0; i < opened; i++) m *= (MINES_CELLS - i) / (MINES_CELLS - mines - i);
  return m;
}

// Позиции мин: перемешивание Фишера — Йейтса на бросках `${nonce}:${i}`
export function minePositions(serverSeed, clientSeed, nonce, mines) {
  const cells = Array.from({ length: MINES_CELLS }, (_, i) => i);
  for (let i = 0; i < MINES_CELLS - 1; i++) {
    const j = i + Math.floor((computeRoll(serverSeed, clientSeed, `${nonce}:${i}`) / ROLL_MAX) * (MINES_CELLS - i));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mines).sort((a, b) => a - b);
}

const payoutOf = (bet, mult, s) => Math.min(floorLc(Math.floor(bet * mult)), s.casinoMaxWin);

function checkBet(bet, s) {
  if (!isWholeLc(bet) || bet <= 0) fail(400, 'Ставка — целое число LC');
  if (bet < s.casinoMinBet) fail(400, `Минимальная ставка — ${fmtLc(s.casinoMinBet)}`);
  if (bet > s.casinoMaxBet) fail(400, `Максимальная ставка — ${fmtLc(s.casinoMaxBet)}`);
}

// Списать ставку и завести игру (в транзакции, игрок уже заблокирован)
async function placeBet(q, u, game, bet, state, roll = null) {
  const nonce = u.nonce;
  await q.query('update users set nonce = nonce + 1 where id = $1', [u.id]);
  const g = await q.one(
    `insert into casino_games (user_id, game, bet, state, roll, server_seed_hash, client_seed, nonce)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [u.id, game, bet, JSON.stringify(state), roll, hashSeed(u.server_seed), u.client_seed, nonce],
  );
  const balance = await changeBalance(q, u.id, -bet, 'casino', { ref: `casino:${g.id}`, note: `${NAMES[game]}: ставка` });
  await addXp(q, u.id, bet, 'casino');
  return { g, balance };
}

// Закрыть игру: выигрыш (payout > 0) зачисляется на баланс
async function finish(q, g, { won, mult, state }) {
  const s = await getSettings();
  const payout = won ? payoutOf(g.bet, mult, s) : 0;
  const row = await q.one(
    `update casino_games set status = $2, payout = $3, multiplier = $4, state = $5, finished_at = now()
     where id = $1 and status = 'active' returning *`,
    [g.id, won ? 'won' : 'lost', payout, won ? mult : 0, JSON.stringify(state ?? g.state)],
  );
  if (!row) return { game: g, balance: null };
  const balance = payout > 0
    ? await changeBalance(q, g.user_id, payout, 'casino', { ref: `casino:${g.id}`, note: `${NAMES[g.game]}: выигрыш ×${String(floor2(mult)).replace('.', ',')}` })
    : null;
  return { game: row, balance };
}

async function lockGame(q, userId, id, game) {
  const g = await q.one('select * from casino_games where id = $1 and user_id = $2 and game = $3 for update', [id, userId, game]);
  if (!g) fail(404, 'Игра не найдена');
  return g;
}
const balanceOf = async (q, userId) => (await q.one('select balance from users where id = $1', [userId])).balance;
const fairOf = (g) => ({ serverSeedHash: g.server_seed_hash, clientSeed: g.client_seed, nonce: g.nonce });

// ── Кости ──────────────────────────────────────────────────

export async function playDice(userId, { bet, chance, over }) {
  const s = await getSettings();
  checkBet(bet, s);
  // chance — шанс в миллионных долях, 1%…95%
  if (!Number.isSafeInteger(chance) || chance < 10_000 || chance > 950_000) fail(400, 'Шанс — от 1 до 95%');
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const roll = computeRoll(u.server_seed, u.client_seed, u.nonce);
    const won = over ? roll >= ROLL_MAX - chance : roll < chance;
    const mult = (1 - s.casinoEdge) / (chance / ROLL_MAX);
    const { g, balance } = await placeBet(q, u, 'dice', bet, { chance, over: Boolean(over) }, roll);
    const done = await finish(q, g, { won, mult });
    return {
      id: g.id, won, roll, chance, over: Boolean(over), multiplier: floor2(mult), payout: done.game.payout,
      balance: done.balance ?? balance, fair: fairOf(g),
    };
  });
}

// ── Слоты ──────────────────────────────────────────────────

export async function playSlots(userId, { bet }) {
  const s = await getSettings();
  checkBet(bet, s);
  const k = payScale(s.casinoEdge);
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const round = playRound(u.server_seed, u.client_seed, u.nonce);
    const mult = round.total * k;
    const { g, balance } = await placeBet(q, u, 'slots', bet, { scatters: round.base.scatters, freeSpins: round.free.length });
    const done = await finish(q, g, { won: payoutOf(bet, mult, s) > 0, mult });
    // Для экрана: выигрыш каждой линии — во сколько раз ставки (с коэффициентом выплат)
    const view = (spin, fsMult = 1) => ({
      grid: spin.grid, scatters: spin.scatters, win: floor2(spin.win * k),
      lines: spin.lines.map((l) => ({ line: l.line, symbol: l.symbol, count: l.count, mult: l.mult, x: floor2((l.pay * k * fsMult) / LINES.length) })),
    });
    return {
      id: g.id, base: view(round.base), free: round.free.map((f) => view(f, FS_MULT)),
      multiplier: done.game.payout ? floor2(done.game.payout / bet) : 0, payout: done.game.payout,
      balance: done.balance ?? balance, fair: fairOf(g),
    };
  });
}

// ── Мины ───────────────────────────────────────────────────

const minesView = (g, s, reveal = false) => {
  const st = g.state;
  const k = st.opened.length;
  return {
    id: g.id, status: g.status, bet: g.bet, mines: st.mines, opened: st.opened,
    multiplier: floor2(minesMultiplier(k, st.mines, s.casinoEdge)),
    next: k < MINES_CELLS - st.mines ? floor2(minesMultiplier(k + 1, st.mines, s.casinoEdge)) : null,
    payout: g.payout, minePositions: reveal || g.status !== 'active' ? st.positions : undefined, fair: fairOf(g),
  };
};

export async function activeMines(userId) {
  const s = await getSettings();
  const g = await (await getDb()).one(`select * from casino_games where user_id = $1 and game = 'mines' and status = 'active' order by id desc limit 1`, [userId]);
  return g ? minesView(g, s) : null;
}

export async function startMines(userId, { bet, mines }) {
  const s = await getSettings();
  checkBet(bet, s);
  if (!Number.isSafeInteger(mines) || mines < 1 || mines > 24) fail(400, 'Мин — от 1 до 24');
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    const busy = await q.one(`select id from casino_games where user_id = $1 and game = 'mines' and status = 'active' limit 1`, [userId]);
    if (busy) fail(409, 'Сначала закончи текущую игру в мины');
    const positions = minePositions(u.server_seed, u.client_seed, u.nonce, mines);
    const { g, balance } = await placeBet(q, u, 'mines', bet, { mines, positions, opened: [] });
    return { ...minesView(g, s), balance };
  });
}

export async function openMine(userId, id, cell) {
  if (!Number.isSafeInteger(cell) || cell < 0 || cell >= MINES_CELLS) fail(400, 'Нет такой клетки');
  const s = await getSettings();
  const db = await getDb();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const g = await lockGame(q, userId, id, 'mines');
    if (g.status !== 'active') fail(409, 'Игра уже закончена');
    const st = g.state;
    if (st.opened.includes(cell)) return { ...minesView(g, s), balance: await balanceOf(q, userId) };
    if (st.positions.includes(cell)) {
      const done = await finish(q, g, { won: false, state: { ...st, boom: cell } });
      return { ...minesView(done.game, s), boom: cell, balance: await balanceOf(q, userId) };
    }
    const state = { ...st, opened: [...st.opened, cell] };
    // Открыл все безопасные клетки — забираем автоматически
    if (state.opened.length === MINES_CELLS - st.mines) {
      const done = await finish(q, g, { won: true, mult: minesMultiplier(state.opened.length, st.mines, s.casinoEdge), state });
      return { ...minesView(done.game, s), balance: done.balance };
    }
    const row = await q.one('update casino_games set state = $2 where id = $1 returning *', [g.id, JSON.stringify(state)]);
    return { ...minesView(row, s), balance: await balanceOf(q, userId) };
  });
}

export async function cashoutMines(userId, id) {
  const s = await getSettings();
  const db = await getDb();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const g = await lockGame(q, userId, id, 'mines');
    if (g.status !== 'active') fail(409, 'Игра уже закончена');
    if (!g.state.opened.length) fail(400, 'Открой хотя бы одну клетку');
    const done = await finish(q, g, { won: true, mult: minesMultiplier(g.state.opened.length, g.state.mines, s.casinoEdge) });
    return { ...minesView(done.game, s), balance: done.balance };
  });
}

// ── Ракетка ────────────────────────────────────────────────

// Состояние ракетки на момент now: взорвалась ли, сработал ли автовывод
function crashOutcome(st, now) {
  const elapsed = now - st.startAt;
  const crashAt = crashTimeOf(st.crash);
  if (st.auto && st.auto < st.crash && elapsed >= crashTimeOf(st.auto)) return { won: true, mult: st.auto };
  if (elapsed >= crashAt) return { won: false };
  return null;
}

const crashView = (g, now = Date.now()) => {
  const st = g.state;
  const over = g.status !== 'active';
  // Точку взрыва показываем, только когда ракетка уже взорвалась (даже если игрок успел забрать)
  const exploded = now - st.startAt >= crashTimeOf(st.crash);
  return {
    id: g.id, status: g.status, bet: g.bet, auto: st.auto || null, startAt: st.startAt, serverNow: now,
    multiplier: over ? g.multiplier : null, payout: g.payout, crash: exploded ? st.crash : null,
    crashAt: exploded ? st.startAt + crashTimeOf(st.crash) : null, fair: fairOf(g),
  };
};

// Досчитать зависшие игры (игрок закрыл вкладку): взрыв или автовывод уже в прошлом
async function settleCrash(q, g, now = Date.now()) {
  if (g.status !== 'active') return { game: g, balance: null };
  const out = crashOutcome(g.state, now);
  return out ? finish(q, g, out) : { game: g, balance: null };
}

export async function startCrash(userId, { bet, auto = null }) {
  const s = await getSettings();
  checkBet(bet, s);
  if (auto != null && !(Number.isFinite(auto) && auto >= 1.01 && auto <= CRASH_MAX)) fail(400, `Автовывод — от ×1,01 до ×${CRASH_MAX}`);
  const db = await getDb();
  return db.tx(async (q) => {
    const u = await lockUser(q, userId);
    for (const old of await q.query(`select * from casino_games where user_id = $1 and game = 'crash' and status = 'active' for update`, [userId])) {
      const done = await settleCrash(q, old);
      if (done.game.status === 'active') fail(409, 'Ракетка ещё летит — дождись конца раунда');
    }
    const roll = computeRoll(u.server_seed, u.client_seed, u.nonce);
    const state = { crash: crashPoint(roll, s.casinoEdge), auto: auto ? floor2(auto) : null, startAt: Date.now() + 600 };
    const { g, balance } = await placeBet(q, u, 'crash', bet, state, roll);
    return { ...crashView(g), balance };
  });
}

export async function cashoutCrash(userId, id) {
  const db = await getDb();
  const now = Date.now();
  return db.tx(async (q) => {
    await lockUser(q, userId);
    const g = await lockGame(q, userId, id, 'crash');
    if (g.status !== 'active') return { ...crashView(g, now), balance: await balanceOf(q, userId) };
    const st = g.state;
    const out = crashOutcome(st, now);
    // Взорвалась или сработал автовывод раньше нажатия — засчитываем это; иначе забираем текущий множитель
    const mult = crashMultAt(now - st.startAt);
    const done = await finish(q, g, out ?? (mult >= st.crash ? { won: false } : { won: true, mult: Math.max(1, mult) }));
    return { ...crashView(done.game, now), balance: done.balance ?? await balanceOf(q, userId) };
  });
}

// Long-poll: ждём до взрыва (или автовывода), но не дольше maxWait. Раньше времени точку взрыва не отдаём.
export async function waitCrash(userId, id, { maxWait = 25_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const db = await getDb();
  const g0 = await db.one(`select * from casino_games where id = $1 and user_id = $2 and game = 'crash'`, [id, userId]);
  if (!g0) fail(404, 'Игра не найдена');
  const st = g0.state;
  const crashAt = st.startAt + crashTimeOf(st.crash);
  const autoAt = st.auto && st.auto < st.crash ? st.startAt + crashTimeOf(st.auto) : Infinity;
  const until = g0.status === 'active' ? Math.min(crashAt, autoAt) : crashAt;
  const wait = Math.min(Math.max(0, until - Date.now()), maxWait);
  if (wait > 0) await sleep(wait + 30);
  return db.tx(async (q) => {
    const g = await lockGame(q, userId, id, 'crash');
    const done = await settleCrash(q, g);
    return { ...crashView(done.game), balance: done.balance ?? await balanceOf(q, userId) };
  });
}

// История игр игрока (последние 20) — для вкладки казино
export async function myCasinoGames(userId, game) {
  const rows = await (await getDb()).query(
    `select id, game, bet, status, payout, multiplier, created_at from casino_games
     where user_id = $1 and status <> 'active' and ($2::text is null or game = $2) order by id desc limit 20`,
    [userId, game || null],
  );
  return rows;
}
