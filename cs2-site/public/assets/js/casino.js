// Казино: слоты, ракетка, мины и кости. Вся логика и броски — на сервере (lib/casino.js), здесь только интерфейс.
import {
  $, $$, api, dateTime, esc, loginUrl, lc, prefersReducedMotion, session, setBalance, sized, toast, toastError, withLoading,
} from './core.js';

const LC = 100;
const state = {
  user: null,
  cfg: { edge: 0.05, minBet: 100, maxBet: 5_000_000, maxWin: 100_000_000_000, crashK: 0.1, crashMax: 1000 },
  game: 'slots',
};
const fmtMult = (m) => `×${(Math.floor(m * 100 + 1e-9) / 100).toFixed(2).replace('.', ',')}`;
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
// Выплата как на сервере: вниз до целого LC и не больше максимального выигрыша за игру
const payout = (bet, mult) => Math.min(Math.floor((bet * mult) / LC) * LC, state.cfg.maxWin);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const updateBalance = (b) => { if (typeof b === 'number') { state.user.balance = b; setBalance(b); } };

// ── Ставка (общая для всех игр) ────────────────────────────

function betField(game) {
  const box = $(`[data-panel="${game}"] [data-bet-field]`);
  box.innerHTML = `
    <label class="legend" for="bet-${game}">Ставка</label>
    <div class="input-group">
      <input class="input num" id="bet-${game}" type="number" inputmode="numeric" min="1" step="1" data-bet>
      <span class="suffix" aria-hidden="true">LC</span>
    </div>
    <div class="row cas-chips">
      <button type="button" class="chip" data-bet-op="half">½</button>
      <button type="button" class="chip" data-bet-op="double">×2</button>
      <button type="button" class="chip" data-bet-op="min">Мин</button>
      <button type="button" class="chip" data-bet-op="max">Макс</button>
    </div>`;
  const input = $('[data-bet]', box);
  input.value = store.get(`ld-bet-${game}`) || '10';
  input.addEventListener('input', () => { store.set(`ld-bet-${game}`, input.value); onBetChange(game); });
  box.addEventListener('click', (e) => {
    const op = e.target.closest('[data-bet-op]')?.dataset.betOp;
    if (!op || input.disabled) return;
    const cur = Math.max(1, Math.floor(Number(input.value) || 0));
    const max = Math.floor(Math.min(state.cfg.maxBet, state.user?.balance ?? state.cfg.maxBet) / LC);
    const v = { half: Math.floor(cur / 2), double: cur * 2, min: state.cfg.minBet / LC, max }[op];
    input.value = String(Math.max(state.cfg.minBet / LC, Math.min(v, state.cfg.maxBet / LC)));
    store.set(`ld-bet-${game}`, input.value);
    onBetChange(game);
  });
}
const betOf = (game) => Math.floor(Number($(`[data-panel="${game}"] [data-bet]`).value) || 0) * LC;
const lockBet = (game, locked) => $$(`[data-panel="${game}"] [data-bet], [data-panel="${game}"] [data-bet-op]`).forEach((el) => { el.disabled = locked; });
function onBetChange(game) {
  if (game === 'dice') renderDice();
  if (game === 'mines') renderMinesControls();
}
// Проверка перед ставкой; null — можно играть
function betProblem(bet) {
  if (!state.user) return 'login';
  if (bet < state.cfg.minBet) return `Минимальная ставка — ${lc(state.cfg.minBet)}`;
  if (bet > state.cfg.maxBet) return `Максимальная ставка — ${lc(state.cfg.maxBet)}`;
  if (bet > state.user.balance) return 'Недостаточно LC на балансе';
  return null;
}
function guard(game, why) {
  const p = betProblem(betOf(game));
  if (p === 'login') { location.href = loginUrl('/casino/#' + game); return false; }
  if (p) { why.textContent = p; return false; }
  why.textContent = '';
  return true;
}

// ── Вкладки игр ────────────────────────────────────────────

function showGame(game, push = true) {
  if (!['slots', 'crash', 'mines', 'dice'].includes(game)) game = 'slots';
  state.game = game;
  $$('[data-game]').forEach((t) => {
    const on = t.dataset.game === game;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== game; });
  if (push) history.replaceState(null, '', `#${game}`);
  if (game === 'crash') resizeCanvas();
  loadHistory();
}
$('.cas-tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-game]'); if (t) showGame(t.dataset.game); });
$('.cas-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = $$('[data-game]');
  const i = tabs.findIndex((t) => t.dataset.game === state.game);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  showGame(next.dataset.game);
  next.focus();
});

// ── История ────────────────────────────────────────────────

const GAME_NAME = { slots: '🎰 Слоты', crash: '🚀 Ракетка', mines: '💣 Мины', dice: '🎲 Кости' };
async function loadHistory() {
  const box = $('[data-cas-history]');
  if (!state.user) { box.innerHTML = '<p class="muted small">Войди, чтобы играть — здесь появятся твои игры.</p>'; return; }
  const list = await api(`/api/casino/history?game=${state.game}`).catch(() => []);
  box.innerHTML = list.length
    ? list.map((g) => `<div class="list-item">
        <div class="grow"><p><b>${GAME_NAME[g.game]}</b> · <span class="muted">ставка ${lc(g.bet)}</span></p><p class="small muted">${dateTime(g.created_at)}</p></div>
        ${g.status === 'won'
          ? `<span class="badge badge-success">${fmtMult(g.multiplier)}</span><span class="amount plus">+${lc(g.payout)}</span>`
          : `<span class="badge">Проигрыш</span><span class="amount">−${lc(g.bet)}</span>`}
      </div>`).join('')
    : '<p class="muted small">Пока пусто — сыграй первую игру.</p>';
}

// ── Ракетка ────────────────────────────────────────────────

const crash = {
  canvas: $('[data-crash-canvas]'), go: $('[data-crash-go]'), why: $('[data-crash-why]'),
  multEl: $('[data-crash-mult]'), statusEl: $('[data-crash-status]'), stage: $('[data-crash-stage]'),
  round: null, // { id, bet, startAt, offset, auto, crash, crashAt, cashed, status }
  recent: [],
  raf: 0,
};
const serverNow = () => Date.now() + (crash.round?.offset || 0);
const multAt = (ms) => floor2(Math.exp((state.cfg.crashK * Math.max(0, ms)) / 1000));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function resizeCanvas() {
  const c = crash.canvas;
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  drawCrash();
}
addEventListener('resize', () => { if (state.game === 'crash') resizeCanvas(); });

function drawCrash() {
  const c = crash.canvas;
  const ctx = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const dpr = W / Math.max(1, c.getBoundingClientRect().width);
  ctx.clearRect(0, 0, W, H);
  const rd = crash.round;
  const now = serverNow();
  const exploded = rd?.crashAt != null && now >= rd.crashAt;
  const tMs = rd ? Math.max(0, (exploded ? rd.crashAt : now) - rd.startAt) : 0;
  const m = rd ? (exploded ? rd.crash : multAt(tMs)) : 1;
  const tSec = tMs / 1000;
  // Оси подстраиваются под полёт
  const xMax = Math.max(8, tSec * 1.15);
  const yMax = Math.max(2, m * 1.2);
  const pad = 28 * dpr;
  const X = (t) => pad + (t / xMax) * (W - pad * 2);
  const Y = (v) => H - pad - ((v - 1) / (yMax - 1)) * (H - pad * 2);
  ctx.strokeStyle = cssVar('--border') || '#2f2716';
  ctx.lineWidth = 1 * dpr;
  ctx.fillStyle = cssVar('--muted') || '#b5a88b';
  ctx.font = `${11 * dpr}px Inter, sans-serif`;
  for (let i = 0; i <= 4; i++) {
    const v = 1 + ((yMax - 1) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad, Y(v)); ctx.lineTo(W - pad, Y(v)); ctx.stroke();
    ctx.fillText(`×${v.toFixed(v < 10 ? 1 : 0)}`, 4 * dpr, Y(v) - 4 * dpr);
  }
  if (!rd || tMs <= 0) return;
  const color = exploded && !rd.cashed ? (cssVar('--danger') || '#e5484d') : (cssVar('--accent') || '#e2b13c');
  const pts = [];
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const t = (tSec * i) / steps;
    pts.push([X(t), Y(Math.min(m, Math.exp(state.cfg.crashK * t)))]);
  }
  ctx.beginPath(); ctx.moveTo(pts[0][0], H - pad);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], H - pad); ctx.closePath();
  ctx.globalAlpha = 0.16; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color; ctx.lineWidth = 4 * dpr; ctx.lineCap = 'round'; ctx.stroke();
  // Ракета (или взрыв) на кончике
  const [x1, y1] = pts[pts.length - 1];
  const [x0, y0] = pts[Math.max(0, pts.length - 6)];
  ctx.save();
  ctx.translate(x1, y1);
  ctx.font = `${30 * dpr}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (exploded) ctx.fillText('💥', 0, 0);
  else { ctx.rotate(Math.atan2(y1 - y0, x1 - x0) + Math.PI / 4); ctx.fillText('🚀', 0, 0); }
  ctx.restore();
}

function renderCrash() {
  const rd = crash.round;
  const now = serverNow();
  const exploded = rd?.crashAt != null && now >= rd.crashAt;
  const flying = rd && !exploded;
  const m = rd ? (exploded ? rd.crash : multAt(now - rd.startAt)) : 1;
  crash.multEl.textContent = fmtMult(m);
  crash.stage.classList.toggle('is-boom', Boolean(exploded && !rd.cashed));
  crash.stage.classList.toggle('is-won', Boolean(rd?.cashed));
  const label = $('span', crash.go);
  if (!rd) {
    crash.statusEl.textContent = 'Сделай ставку и жми «Запустить»';
  } else if (exploded) {
    crash.statusEl.textContent = rd.cashed ? `Забрал ${fmtMult(rd.cashed)} · +${lc(rd.payout)} · взрыв на ${fmtMult(rd.crash)}` : `💥 Взрыв на ${fmtMult(rd.crash)}`;
  } else if (now < rd.startAt) {
    crash.statusEl.textContent = 'Взлёт…';
  } else {
    crash.statusEl.textContent = rd.cashed ? `Забрал ${fmtMult(rd.cashed)} · +${lc(rd.payout)}` : rd.auto ? `Автовывод на ${fmtMult(rd.auto)}` : 'Летим! Забери до взрыва';
  }
  if (!state.user) { label.textContent = 'Войти, чтобы играть'; crash.go.disabled = false; return; }
  if (flying && !rd.cashed && rd.status === 'active') {
    label.textContent = `Забрать ${fmtMult(Math.max(1, m))} · ${lc(payout(rd.bet, Math.max(1, m)))}`;
    crash.go.classList.add('btn-cashout');
    crash.go.disabled = now < rd.startAt;
  } else {
    label.textContent = flying ? 'Ждём конца раунда…' : 'Запустить';
    crash.go.classList.remove('btn-cashout');
    crash.go.disabled = Boolean(flying);
  }
  lockBet('crash', Boolean(flying));
  $('[data-crash-auto]').disabled = Boolean(flying);
}

function loop() {
  drawCrash();
  renderCrash();
  const rd = crash.round;
  if (rd && !(rd.crashAt != null && serverNow() >= rd.crashAt)) crash.raf = requestAnimationFrame(loop);
  else { crash.raf = 0; if (rd?.crash != null) finishRound(); }
}
function finishRound() {
  const rd = crash.round;
  if (rd.finished) return;
  rd.finished = true;
  crash.recent.unshift(rd.crash);
  crash.recent = crash.recent.slice(0, 12);
  $('[data-crash-hist]').innerHTML = crash.recent.map((c) => `<span class="badge ${c >= 2 ? 'badge-success' : ''}">${fmtMult(c)}</span>`).join('');
  if (!rd.cashed) toast(`💥 Взрыв на ${fmtMult(rd.crash)} — ставка сгорела`, 'error', { timeout: 2500 });
  loadHistory();
}

// Ответ сервера по раунду → состояние на экране
function applyCrash(r) {
  const rd = crash.round;
  if (!rd || rd.id !== r.id) return;
  rd.status = r.status;
  if (r.status === 'won' && !rd.cashed) {
    rd.cashed = r.multiplier;
    rd.payout = r.payout;
    toast(`Забрал ${fmtMult(r.multiplier)} — +${lc(r.payout)}`, 'success', { timeout: 2500 });
  }
  if (r.crash != null) { rd.crash = r.crash; rd.crashAt = r.crashAt; }
  updateBalance(r.balance);
  if (!crash.raf) loop();
}

// Long-poll: сервер отвечает в момент взрыва (или автовывода)
async function waitRound(id) {
  for (let fails = 0; fails < 5;) {
    try {
      const r = await api(`/api/casino/crash/${id}/wait`);
      applyCrash(r);
      if (r.crash != null || crash.round?.id !== id) return;
    } catch { fails++; await new Promise((res) => setTimeout(res, 1000)); }
  }
}

crash.go.addEventListener('click', async () => {
  if (!state.user) { location.href = loginUrl('/casino/#crash'); return; }
  const rd = crash.round;
  const flying = rd && !(rd.crashAt != null && serverNow() >= rd.crashAt);
  if (flying && rd.status === 'active' && !rd.cashed) {
    try { applyCrash(await api('/api/casino/crash/cashout', { method: 'POST', body: { id: rd.id } })); } catch (err) { toastError(err); }
    if (crash.round?.status === 'lost') toast('Не успел — ракетка уже взорвалась', 'error', { timeout: 2500 });
    return;
  }
  if (flying || !guard('crash', crash.why)) return;
  const autoRaw = $('[data-crash-auto]').value.trim().replace(',', '.');
  const auto = autoRaw ? Number(autoRaw) : null;
  if (auto != null && !(auto >= 1.01 && auto <= state.cfg.crashMax)) { crash.why.textContent = `Автовывод — от ×1,01 до ×${state.cfg.crashMax}`; return; }
  await withLoading(crash.go, async () => {
    try {
      const r = await api('/api/casino/crash/start', { method: 'POST', body: { bet: betOf('crash'), auto } });
      crash.round = { id: r.id, bet: r.bet, startAt: r.startAt, offset: r.serverNow - Date.now(), auto: r.auto, crash: null, crashAt: null, cashed: null, status: 'active' };
      updateBalance(r.balance);
      waitRound(r.id);
    } catch (err) { toastError(err); }
  });
  if (crash.round && !crash.raf) loop();
});

// ── Мины ───────────────────────────────────────────────────

const mines = { game: null, count: 3, busy: false, grid: $('[data-mines-grid]'), go: $('[data-mines-go]'), why: $('[data-mines-why]') };
const cellSvg = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

function renderMinesGrid() {
  const g = mines.game;
  const over = g && g.status !== 'active';
  const minesAt = new Set(g?.minePositions || []);
  mines.grid.innerHTML = Array.from({ length: 25 }, (_, i) => {
    const opened = g?.opened.includes(i);
    const mine = minesAt.has(i);
    const cls = ['mine-cell', opened && 'is-open', over && mine && 'is-mine', g?.boom === i && 'is-boom', over && !opened && !mine && 'is-rest'].filter(Boolean).join(' ');
    const content = opened || (over && !mine) ? cellSvg('g-gem') : over && mine ? cellSvg('g-c4') : '';
    const label = opened ? 'Открыто: чисто' : over && mine ? 'C4' : `Клетка ${i + 1}`;
    return `<button type="button" class="${cls}" role="gridcell" data-cell="${i}" aria-label="${label}" ${!g || over || opened ? 'disabled' : ''}>${content}</button>`;
  }).join('');
}

function renderMinesControls() {
  const g = mines.game;
  const active = g?.status === 'active';
  $('[data-mines-mult]').textContent = !g ? '×1,00' : g.status === 'lost' ? '💥 C4' : fmtMult(g.multiplier);
  $('[data-mines-next]').textContent = active && g.next ? fmtMult(g.next) : '—';
  $$('[data-mines]').forEach((b) => { b.setAttribute('aria-checked', String(Number(b.dataset.mines) === (active ? g.mines : mines.count))); b.disabled = active; });
  lockBet('mines', active);
  const label = $('span', mines.go);
  mines.go.classList.toggle('btn-cashout', Boolean(active));
  if (!state.user) { label.textContent = 'Войти, чтобы играть'; mines.go.disabled = false; return; }
  if (active) {
    const pay = payout(g.bet, g.multiplier);
    label.textContent = g.opened.length ? `Забрать ${fmtMult(g.multiplier)} · ${lc(pay)}` : 'Открой клетку';
    mines.go.disabled = !g.opened.length || mines.busy;
  } else {
    label.textContent = g ? 'Играть ещё' : 'Начать';
    mines.go.disabled = mines.busy;
  }
}
const renderMines = () => { renderMinesGrid(); renderMinesControls(); };

$('[data-mines-count]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mines]');
  if (!b || mines.game?.status === 'active') return;
  mines.count = Number(b.dataset.mines);
  store.set('ld-mines', String(mines.count));
  renderMinesControls();
});

mines.go.addEventListener('click', async () => {
  if (!state.user) { location.href = loginUrl('/casino/#mines'); return; }
  const g = mines.game;
  if (g?.status === 'active') {
    await withLoading(mines.go, async () => {
      try {
        mines.game = await api('/api/casino/mines/cashout', { method: 'POST', body: { id: g.id } });
        updateBalance(mines.game.balance);
        toast(`Забрал ${fmtMult(mines.game.multiplier)} — +${lc(mines.game.payout)}`, 'success', { timeout: 2500 });
        loadHistory();
      } catch (err) { toastError(err); }
    });
    renderMines();
    return;
  }
  if (!guard('mines', mines.why)) return;
  await withLoading(mines.go, async () => {
    try {
      mines.game = await api('/api/casino/mines/start', { method: 'POST', body: { bet: betOf('mines'), mines: mines.count } });
      updateBalance(mines.game.balance);
      mines.why.textContent = 'Открывай клетки. Нашёл C4 — ставка сгорела.';
    } catch (err) { toastError(err); }
  });
  renderMines();
});

mines.grid.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cell]');
  const g = mines.game;
  if (!b || b.disabled || mines.busy || g?.status !== 'active') return;
  mines.busy = true;
  b.classList.add('is-loading');
  try {
    mines.game = await api('/api/casino/mines/open', { method: 'POST', body: { id: g.id, cell: Number(b.dataset.cell) } });
    updateBalance(mines.game.balance);
    if (mines.game.status === 'lost') { toast('💥 C4! Ставка сгорела', 'error', { timeout: 2500 }); loadHistory(); }
    if (mines.game.status === 'won') { toast(`Все клетки открыты! +${lc(mines.game.payout)}`, 'success'); loadHistory(); }
  } catch (err) { toastError(err); }
  mines.busy = false;
  renderMines();
});

// ── Кости ──────────────────────────────────────────────────

const dice = { dir: 'under', busy: false, go: $('[data-dice-go]'), why: $('[data-dice-why]') };
const diceChance = () => Number($('[data-dice-chance]').value);
const diceMult = () => floor2((1 - state.cfg.edge) / (diceChance() / 100));
const fmtNum = (v) => v.toFixed(2).replace('.', ',');

function renderDice() {
  const ch = diceChance();
  $('[data-dice-chance-label]').textContent = `${ch}%`;
  $('[data-dice-mult]').textContent = fmtMult(diceMult());
  const bet = betOf('dice');
  $('[data-dice-win]').textContent = bet > 0 ? lc(payout(bet, diceMult())) : '—';
  $('[data-dice-target]').textContent = dice.dir === 'under'
    ? `Выигрыш, если выпадет меньше ${fmtNum(ch)}`
    : `Выигрыш, если выпадет ${fmtNum(100 - ch)} или больше`;
  const zone = $('[data-dice-zone]');
  zone.style.setProperty('--from', `${dice.dir === 'under' ? 0 : 100 - ch}%`);
  zone.style.setProperty('--to', `${dice.dir === 'under' ? ch : 100}%`);
  $$('[data-dice-dir]').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.diceDir === dice.dir)); b.disabled = dice.busy; });
  const label = $('span', dice.go);
  label.textContent = state.user ? 'Бросить' : 'Войти, чтобы играть';
  dice.go.disabled = dice.busy;
}
$('[data-dice-chance]').addEventListener('input', renderDice);
$('[data-panel="dice"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dice-dir]');
  if (!b || dice.busy) return;
  dice.dir = b.dataset.diceDir;
  renderDice();
});

function animateDice(final) {
  const el = $('[data-dice-num]');
  const marker = $('[data-dice-marker]');
  const ms = prefersReducedMotion() ? 0 : 650;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (t) => {
      const k = ms ? Math.min(1, (t - t0) / ms) : 1;
      const v = k < 1 ? Math.random() * 100 : final;
      el.textContent = fmtNum(v);
      marker.hidden = false;
      marker.style.setProperty('--pos', `${v}%`);
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

dice.go.addEventListener('click', async () => {
  if (!state.user) { location.href = loginUrl('/casino/#dice'); return; }
  if (dice.busy || !guard('dice', dice.why)) return;
  dice.busy = true;
  renderDice();
  const stage = $('.cas-dice');
  stage.classList.remove('is-won', 'is-lost');
  try {
    const r = await api('/api/casino/dice', { method: 'POST', body: { bet: betOf('dice'), chance: diceChance() * 10_000, over: dice.dir === 'over' } });
    await animateDice(r.roll / 10_000);
    stage.classList.add(r.won ? 'is-won' : 'is-lost');
    updateBalance(r.balance);
    dice.why.textContent = r.won ? `Выпало ${fmtNum(r.roll / 10_000)} — выигрыш ${lc(r.payout)}` : `Выпало ${fmtNum(r.roll / 10_000)} — мимо`;
    loadHistory();
  } catch (err) { toastError(err); }
  dice.busy = false;
  renderDice();
});


// ── Слоты ──────────────────────────────────────────────────

const slots = {
  go: $('[data-slots-go]'), why: $('[data-slots-why]'), reels: $('[data-slots-reels]'), linesEl: $('[data-slots-lines]'),
  banner: $('[data-slots-banner]'), busy: false, info: null,
};
const STRIP = 22; // символов в ленте барабана при прокрутке
const sym = (i) => slots.info.symbols[i];
const symImg = (i) => {
  const s = sym(i);
  const badge = s.wild ? `<span class="slot-badge">WILD ×${s.wild}</span>` : s.scatter ? '<span class="slot-badge is-scatter">БОНУС</span>' : '';
  return `<div class="slot-cell${s.wild ? ' is-wild' : ''}${s.scatter ? ' is-scatter' : ''}" title="${esc(s.name)}"><img src="${esc(sized(s.img))}" alt="${esc(s.name)}" loading="lazy" decoding="async" draggable="false">${badge}</div>`;
};
const randSym = () => {
  // Для ленты — случайные символы примерно с теми же частотами (кроме кейса — пореже, чтобы не дразнить)
  const pool = [0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 10];
  return pool[Math.floor(Math.random() * pool.length)];
};

function renderReels(grid) {
  slots.reels.innerHTML = grid.map((col, r) => `<div class="slot-reel" data-reel="${r}"><div class="slot-strip">${col.map(symImg).join('')}</div></div>`).join('');
}

function spinReels(grid, fast) {
  const ms = prefersReducedMotion() ? 0 : fast ? 450 : 1100;
  slots.reels.innerHTML = grid.map((col, r) => {
    const filler = Array.from({ length: ms ? STRIP : 0 }, randSym);
    return `<div class="slot-reel" data-reel="${r}"><div class="slot-strip">${[...col, ...filler].map(symImg).join('')}</div></div>`;
  }).join('');
  if (!ms) return Promise.resolve();
  const strips = $$('.slot-strip', slots.reels);
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      strips.forEach((st, r) => {
        const cell = st.firstElementChild.getBoundingClientRect().height;
        // Лента начинается со сдвигом вверх и съезжает к итоговым трём символам
        st.style.setProperty('--from', `${-cell * STRIP}px`);
        st.style.setProperty('--dur', `${ms + r * (fast ? 90 : 220)}ms`);
        st.classList.add('is-spinning');
      });
      setTimeout(resolve, ms + 4 * (fast ? 90 : 220) + 80);
    });
  });
}

function highlight(spin) {
  const cells = new Set();
  for (const l of spin.lines) for (let r = 0; r < l.count; r++) cells.add(`${r}:${slots.info.lines[l.line][r]}`);
  $$('.slot-reel', slots.reels).forEach((reel, r) => {
    [...$('.slot-strip', reel).children].slice(0, 3).forEach((c, row) => {
      c.classList.toggle('is-hit', cells.has(`${r}:${row}`));
      if (sym(spin.grid[r][row]).scatter && spin.scatters >= 3) c.classList.add('is-hit');
    });
  });
  const name = (id) => slots.info.symbols.find((s) => s.id === id)?.name.replace(/ \|.*/, '') || id;
  slots.linesEl.innerHTML = spin.lines.length
    ? spin.lines.slice(0, 6).map((l) => `<span class="badge badge-success">${esc(name(l.symbol))} ×${l.count}${l.mult > 1 ? ` · wild ×${l.mult}` : ''} → ${fmtMult(l.x)}</span>`).join(' ')
      + (spin.lines.length > 6 ? ` <span class="muted">и ещё ${spin.lines.length - 6}</span>` : '')
    : '';
}

const showBanner = (html, ms = 1400) => new Promise((resolve) => {
  slots.banner.innerHTML = html;
  slots.banner.hidden = false;
  setTimeout(() => { slots.banner.hidden = true; resolve(); }, prefersReducedMotion() ? 300 : ms);
});

function renderSlotsControls() {
  const label = $('span', slots.go);
  label.textContent = state.user ? (slots.busy ? 'Крутим…' : 'Крутить') : 'Войти, чтобы играть';
  slots.go.disabled = slots.busy;
  lockBet('slots', slots.busy);
}

slots.go.addEventListener('click', async () => {
  if (!state.user) { location.href = loginUrl('/casino/#slots'); return; }
  if (slots.busy || !guard('slots', slots.why)) return;
  slots.busy = true;
  renderSlotsControls();
  $('[data-slots-win]').textContent = '—';
  $('[data-slots-fs]').textContent = '—';
  slots.linesEl.textContent = '';
  const fast = $('[data-slots-fast]').checked;
  const bet = betOf('slots');
  try {
    const r = await api('/api/casino/slots', { method: 'POST', body: { bet } });
    // Баланс после ставки показываем сразу, выигрыш — в конце анимации
    setBalance(state.user.balance - bet);
    await spinReels(r.base.grid, fast);
    highlight(r.base);
    let shown = Math.floor((bet * r.base.win) / 100) * 100;
    $('[data-slots-win]').textContent = shown ? lc(shown) : '—';
    if (r.free.length) {
      await showBanner(`<b>🎁 БОНУС!</b><span>${r.free.length} фриспинов · выигрыши ×${slots.info.fsMult}</span>`, 1800);
      for (const [i, f] of r.free.entries()) {
        $('[data-slots-fs]').textContent = `${i + 1} / ${r.free.length}`;
        await spinReels(f.grid, true);
        highlight(f);
        shown += Math.floor((bet * f.win) / 100) * 100;
        $('[data-slots-win]').textContent = shown ? lc(Math.min(shown, r.payout || shown)) : '—';
        await new Promise((res) => setTimeout(res, f.lines.length ? 650 : 250));
      }
    }
    $('[data-slots-win]').textContent = r.payout ? lc(r.payout) : '—';
    updateBalance(r.balance);
    if (r.multiplier >= 20) await showBanner(`<b>💥 БОЛЬШОЙ ВЫИГРЫШ</b><span>${lc(r.payout)} · ${fmtMult(r.multiplier)}</span>`, 2200);
    slots.why.textContent = r.payout ? `Выигрыш ${lc(r.payout)} (${fmtMult(r.multiplier)})` : 'Мимо — крути ещё';
    loadHistory();
  } catch (err) { toastError(err); updateBalance(state.user.balance); }
  slots.busy = false;
  renderSlotsControls();
});

function renderPaytable() {
  const rows = slots.info.symbols.filter((s) => s.pays).reverse();
  $('[data-slots-pay]').innerHTML = rows.map((s) => `
    <div class="slots-pay-row"><img src="${esc(sized(s.img))}" alt="" loading="lazy"><span class="small">${esc(s.name)}</span>
      <span class="num small">${s.pays.map((p, i) => `<b>${i + 3}</b> ${fmtMult(p)}`).join(' · ')}</span></div>`).join('')
    + slots.info.symbols.filter((s) => s.wild).slice(0, 1).map((s) => `<div class="slots-pay-row"><img src="${esc(sized(s.img))}" alt="" loading="lazy"><span class="small"><b>WILD</b> — перчатки ×2 / ×3</span><span class="small muted">заменяют любой скин</span></div>`).join('')
    + slots.info.symbols.filter((s) => s.scatter).map((s) => `<div class="slots-pay-row"><img src="${esc(sized(s.img))}" alt="" loading="lazy"><span class="small"><b>БОНУС</b> — кейс</span><span class="small muted">3 / 4 / 5 → 8 / 12 / 20 фриспинов ×2</span></div>`).join('');
}

// ── Старт ──────────────────────────────────────────────────

const s = await session();
state.user = s.user;
if (s.config?.casino) state.cfg = s.config.casino;
$$('[data-rtp]').forEach((el) => { el.textContent = `${Math.round((1 - state.cfg.edge) * 100)}%`; });
for (const g of ['slots', 'crash', 'mines', 'dice']) betField(g);
slots.info = state.cfg.slots;
if (slots.info) {
  // Стартовое поле — просто красивое: по символу каждого вида
  renderReels(Array.from({ length: 5 }, (_, r) => [(r + 0) % 8, (r + 3) % 8, (r + 5) % 8]));
  renderPaytable();
}
renderSlotsControls();
mines.count = [1, 3, 5, 10, 20, 24].includes(Number(store.get('ld-mines'))) ? Number(store.get('ld-mines')) : 3;
if (state.user) mines.game = (await api('/api/casino/mines').catch(() => ({}))).game || null;
renderMines();
renderDice();
renderCrash();
showGame(location.hash.slice(1) || 'slots', false);
