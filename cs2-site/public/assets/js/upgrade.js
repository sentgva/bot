// Апгрейдер: выбор ставки (скины + баланс), выбор цели, расчёт шанса, бросок с анимацией стрелки.
import {
  $, $$, api, dateTime, emptyState, esc, icon, loginUrl, pct, prefersReducedMotion, lc, session, setBalance,
  skeletonCards, skinCard, skinImage, toastError, withLoading,
} from './core.js';

const C = 2 * Math.PI * 94; // длина окружности дуги шанса
const TICKS = 60;            // делений по краю колеса
const SPIN_MS = 5600;        // длительность прокрутки
const PAGE = 24;

const state = {
  user: null,
  cfg: { houseEdge: 0.05, maxChance: 0.8, minChance: 0.01, maxItems: 6, minValue: 1000 },
  owned: [],
  selected: new Set(),
  stake: 0, // копейки с баланса
  target: null,
  targets: [],
  offset: 0,
  total: 0,
  q: '',
  mult: 0,
  spinning: false,
  angle: 0,
  result: null, // { won, roll, chance } — показываем в центре колеса до следующего действия
};

const el = {
  inputBody: $('[data-input-body]'), inputTotal: $('[data-input-total]'),
  balanceBox: $('[data-balance-box]'), stake: $('#stake'), range: $('[data-stake-range]'), balanceLeft: $('[data-balance-left]'),
  sumIn: $('[data-sum-in]'), sumTarget: $('[data-sum-target]'),
  wheel: $('[data-wheel]'), ticks: $('[data-ticks]'), roll: $('[data-roll]'),
  ringWin: $('[data-ring-win]'), pointer: $('[data-pointer]'), chance: $('[data-chance]'), multLabel: $('[data-mult]'),
  go: $('[data-go]'), goMini: $('[data-go-mini]'), chanceMini: $('[data-chance-mini]'), why: $('[data-why]'), result: $('[data-result]'),
  targets: $('[data-targets]'), more: $('[data-targets-more]'), q: $('#target-q'), multFilter: $('[data-mult-filter]'),
  feed: $('[data-feed]'),
};

// ── Расчёт ─────────────────────────────────────────────────

const inputValue = () => state.owned.filter((i) => state.selected.has(i.id)).reduce((s, i) => s + i.price, 0) + state.stake;

function calc() {
  const value = inputValue();
  if (!value || !state.target) return { value, chance: 0, ok: false, reason: state.user ? 'Выбери ставку и скин, который хочешь получить' : 'Войди через Telegram, чтобы сделать ставку' };
  const raw = (value / state.target.price) * (1 - state.cfg.houseEdge);
  if (value < state.cfg.minValue) return { value, chance: raw, ok: false, reason: `Минимальная ставка — ${lc(state.cfg.minValue)}` };
  if (raw > state.cfg.maxChance) return { value, chance: raw, ok: false, reason: `Шанс выше ${Math.round(state.cfg.maxChance * 100)}% — выбери цель дороже` };
  if (raw < state.cfg.minChance || raw * 1_000_000 < 1) return { value, chance: raw, ok: false, reason: `Шанс меньше ${fmtChance(Math.max(1, Math.round(state.cfg.minChance * 1_000_000)))} — выбери цель дешевле или добавь ставку` };
  return { value, chance: raw, ok: true, reason: '' };
}

function render() {
  const { value, chance, ok, reason } = calc();
  const shown = Math.min(chance, state.cfg.maxChance);
  el.inputTotal.textContent = lc(value);
  el.sumIn.textContent = lc(value);
  el.sumTarget.textContent = state.target ? lc(state.target.price) : '—';
  // После броска колесо держит зону того апгрейда, чтобы было видно, куда попала стрелка
  const res = state.result;
  const arc = res ? res.chance / 1e6 : shown;
  el.ringWin.setAttribute('stroke-dasharray', `${(arc * C).toFixed(2)} ${C.toFixed(2)}`);
  el.ringWin.style.opacity = arc > 0 ? '1' : '0';
  $$('.tick', el.ticks).forEach((t, i) => t.classList.toggle('on', i < Math.round(arc * TICKS)));
  const chanceText = fmtChance(Math.floor(shown * 1e6));
  $('[data-switch-in]').textContent = lc(value);
  $('[data-switch-target]').textContent = state.target ? lc(state.target.price) : 'не выбрана';
  el.chanceMini.textContent = chanceText;
  if (res && !state.spinning) {
    el.chance.textContent = res.won ? 'ПОБЕДА' : 'МИМО';
    el.multLabel.textContent = `шанс был ${fmtChance(res.chance)}`;
    el.roll.textContent = `бросок ${res.roll.toLocaleString('ru-RU')}`;
  } else if (!state.spinning) {
    el.chance.textContent = chanceText;
    el.multLabel.textContent = state.target && value ? `шанс · ×${(state.target.price / value).toFixed(2).replace('.', ',')}` : 'выбери ставку и цель';
    el.roll.textContent = '';
  }
  const can = ok && !state.spinning && Boolean(state.user);
  el.go.disabled = !can;
  el.goMini.disabled = !can;
  el.why.textContent = state.spinning ? '' : reason;
}

// Шанс: крупные — с одним знаком (47,5%), маленькие — точнее (0,0095%), чтобы не показывать «0,0%»
function fmtChance(ppm) {
  const digits = ppm >= 10_000 ? 1 : ppm >= 1_000 ? 2 : 4;
  return `${(ppm / 10_000).toFixed(digits).replace(/\.?0+$/, '').replace('.', ',')}%`;
}

// На телефоне ставка и цель — вкладки под колесом
function setPane(name) {
  $('[data-upg]').dataset.activePane = name;
  $$('[data-pane]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === name)));
}
$$('[data-pane]').forEach((b) => b.addEventListener('click', () => setPane(b.dataset.pane)));

// ── Ставка ─────────────────────────────────────────────────

function renderInput() {
  if (!state.user) {
    el.inputBody.innerHTML = emptyState({
      iconName: 'i-user', title: 'Войди, чтобы сделать ставку', text: 'Вход через Telegram — без паролей и регистрации.',
      action: `<a class="btn btn-primary" href="${esc(loginUrl())}">${icon('b-telegram')}<span>Войти через Telegram</span></a>`,
    });
    el.balanceBox.hidden = true;
    return;
  }
  const owned = state.owned.filter((i) => i.status === 'owned');
  el.inputBody.innerHTML = owned.length
    ? `<div class="upg-scroll"><div class="skin-grid" role="group" aria-label="Твои скины">${owned.map((i) => skinCard(i, {
      mode: 'select', selected: state.selected.has(i.id),
      disabled: !state.selected.has(i.id) && state.selected.size >= state.cfg.maxItems,
      attrs: `data-owned="${i.id}"`,
    })).join('')}</div></div>`
    : emptyState({
      iconName: 'i-package', title: 'Пока нет скинов на сайте',
      text: 'Купи скин в маркете или поставь сумму с баланса ниже.',
      action: '<a class="btn btn-secondary btn-sm" href="/cases/">Открыть кейсы</a>',
    });
  el.balanceBox.hidden = false;
  const max = Math.floor(state.user.balance / 100);
  el.range.max = String(max);
  el.stake.max = String(max);
  el.balanceLeft.textContent = lc(state.user.balance);
}

el.inputBody.addEventListener('click', (e) => {
  const card = e.target.closest('[data-owned]');
  if (!card || card.getAttribute('aria-disabled') === 'true' || state.spinning) return;
  const id = Number(card.dataset.owned);
  clearResult();
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  renderInput();
  render();
  loadTargets(true);
  // Фокус остаётся на той же карточке после перерисовки
  $(`[data-owned="${id}"]`)?.focus();
});

function setStake(rubles) {
  const max = Math.floor((state.user?.balance || 0) / 100);
  const v = Math.max(0, Math.min(max, Math.floor(Number(rubles) || 0)));
  state.stake = v * 100;
  el.stake.value = String(v);
  el.range.value = String(v);
  render();
}
el.stake.addEventListener('input', () => { clearResult(); setStake(el.stake.value); });
el.range.addEventListener('input', () => { clearResult(); setStake(el.range.value); });
let stakeTimer;
[el.stake, el.range].forEach((x) => x.addEventListener('change', () => { clearTimeout(stakeTimer); stakeTimer = setTimeout(() => loadTargets(true), 200); }));

// ── Цели ───────────────────────────────────────────────────

function targetRange() {
  const value = inputValue();
  const { houseEdge, maxChance, minChance } = state.cfg;
  if (!value) return { min: 0, max: 0 };
  let min = Math.ceil((value * (1 - houseEdge)) / maxChance);
  const max = minChance > 0 ? Math.floor((value * (1 - houseEdge)) / minChance) : 0; // 0 — без верхней границы цены
  if (state.mult) min = Math.max(min, Math.ceil(value * state.mult));
  return { min, max };
}

let loadSeq = 0;
async function loadTargets(reset = false) {
  const seq = ++loadSeq;
  if (reset) { state.offset = 0; state.targets = []; el.targets.innerHTML = skeletonCards(6); }
  const { min, max } = targetRange();
  const p = new URLSearchParams({ q: state.q, sort: state.sortDesc ? 'price_desc' : inputValue() ? 'price_asc' : 'popular', offset: String(state.offset), limit: String(PAGE) });
  if (min) p.set('min', String(min));
  if (max) p.set('max', String(max));
  try {
    const data = await api(`/api/items?${p}`);
    if (seq !== loadSeq) return; // пришёл ответ на устаревший запрос
    state.targets.push(...data.items);
    state.total = data.total;
    state.offset += data.items.length;
    renderTargets();
  } catch (err) {
    if (seq === loadSeq) el.targets.innerHTML = emptyState({ iconName: 'i-circle-alert', title: 'Не удалось загрузить скины', text: esc(err.message) });
  }
}

function renderTargets() {
  el.targets.innerHTML = state.targets.length
    ? state.targets.map((i) => skinCard(i, { mode: 'select', selected: state.target?.hashName === i.hashName, attrs: `data-target="${esc(i.hashName)}"` })).join('')
    : emptyState({ iconName: 'i-search', title: 'Ничего не нашлось', text: 'Попробуй другой запрос или множитель.' });
  el.more.hidden = state.offset >= state.total;
}

el.targets.addEventListener('click', (e) => {
  const card = e.target.closest('[data-target]');
  if (!card || state.spinning) return;
  const item = state.targets.find((i) => i.hashName === card.dataset.target);
  clearResult();
  state.target = state.target?.hashName === item.hashName ? null : item;
  $$('[data-target]', el.targets).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.target === state.target?.hashName)));
  el.result.innerHTML = '';
  render();
});
el.more.querySelector('button').addEventListener('click', () => loadTargets(false));

let qTimer;
el.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = el.q.value.trim(); loadTargets(true); }, 300); });

$('[data-sort-desc]').addEventListener('click', (e) => {
  state.sortDesc = !state.sortDesc;
  e.currentTarget.setAttribute('aria-pressed', String(state.sortDesc));
  loadTargets(true);
});
el.multFilter.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-mult-value]');
  if (!chip) return;
  state.mult = Number(chip.dataset.multValue);
  $$('[data-mult-value]', el.multFilter).forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
  loadTargets(true);
});

// ── Бросок ─────────────────────────────────────────────────

// Деления по краю колеса: загораются в зоне выигрыша
function buildTicks() {
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < TICKS; i++) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'tick');
    line.setAttribute('x1', '120'); line.setAttribute('x2', '120');
    line.setAttribute('y1', i % 5 === 0 ? '5' : '8'); line.setAttribute('y2', '13');
    line.setAttribute('transform', `rotate(${(i + 0.5) * (360 / TICKS)} 120 120)`);
    el.ticks.append(line);
  }
}

function clearResult() {
  if (!state.result) return;
  state.result = null;
  el.wheel.classList.remove('is-win', 'is-lose');
}

const setPointer = (deg) => el.pointer.setAttribute('transform', `rotate(${deg % 360} 120 120)`);

// Стрелка делает 6 оборотов с мягким торможением и останавливается на броске;
// в центре бегут числа и замедляются вместе со стрелкой
function spinTo(roll) {
  const from = state.angle;
  const to = from - (from % 360) + 360 * 6 + (roll / 1e6) * 360;
  state.angle = to % 360;
  if (prefersReducedMotion()) { setPointer(to); return Promise.resolve(); }
  el.wheel.classList.add('is-spinning');
  el.multLabel.textContent = 'крутим…';
  const t0 = performance.now();
  let lastNum = 0;
  return new Promise((resolve) => {
    const frame = (t) => {
      const k = Math.min(1, (t - t0) / SPIN_MS);
      const eased = 1 - (1 - k) ** 4; // быстро разгоняется, долго и плавно тормозит
      setPointer(from + (to - from) * eased);
      // Числа меняются всё реже, а к концу совпадают с броском
      if (k < 0.92 && t - lastNum > 40 + 260 * k) { el.roll.textContent = Math.floor(Math.random() * 1e6).toLocaleString('ru-RU'); lastNum = t; }
      if (k >= 0.92) el.roll.textContent = roll.toLocaleString('ru-RU');
      if (k < 1) requestAnimationFrame(frame);
      else { el.wheel.classList.remove('is-spinning'); resolve(); }
    };
    requestAnimationFrame(frame);
  });
}

async function go() {
  const { ok } = calc();
  if (!ok || state.spinning) return;
  const body = { itemIds: [...state.selected], balance: state.stake, target: state.target.hashName };
  clearResult();
  state.spinning = true;
  el.result.innerHTML = '';
  render();
  // На телефоне колесо могло уйти за экран, пока игрок листал цели — показываем бросок
  const box = el.wheel.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight) el.wheel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  try {
    const r = await withLoading(el.go, () => api('/api/upgrade', { method: 'POST', body }));
    await spinTo(r.roll);
    state.user.balance = r.balance;
    setBalance(r.balance);
    showResult(r);
    state.selected.clear();
    setStake(0);
    state.result = { won: r.won, roll: r.roll, chance: r.chance };
    el.wheel.classList.add(r.won ? 'is-win' : 'is-lose');
    await loadOwned();
    loadTargets(true);
  } catch (err) {
    toastError(err);
    if (err.status === 409) await loadOwned();
  } finally {
    state.spinning = false;
    renderInput();
    render();
  }
}

function showResult(r) {
  const verdict = r.won
    ? `<p class="ring-result win">Победа! ${esc(r.target.name)} твой</p>`
    : '<p class="ring-result lose">В этот раз мимо</p>';
  const actions = r.won
    ? `<div class="row mt-3"><a class="btn btn-secondary btn-sm" href="/profile/#inventory">Вывести в Steam</a><button class="btn btn-ghost btn-sm" type="button" data-again>Апгрейдить дальше</button></div>`
    : `<div class="row mt-3"><button class="btn btn-secondary btn-sm" type="button" data-again>Попробовать ещё</button></div>`;
  el.result.innerHTML = `
    ${verdict}
    <p class="small muted mt-2">Бросок ${r.roll.toLocaleString('ru-RU')} из 1 000 000, нужно было меньше ${r.chance.toLocaleString('ru-RU')} (шанс ${fmtChance(r.chance)}).</p>
    ${actions}`;
  el.result.querySelector('[data-again]')?.addEventListener('click', () => {
    el.result.innerHTML = '';
    clearResult();
    // «Апгрейдить дальше»: выигранный скин сразу становится ставкой
    if (r.won && state.owned.some((i) => i.id === r.resultItemId)) state.selected.add(r.resultItemId);
    renderInput();
    render();
    loadTargets(true);
    el.inputBody.querySelector('[data-owned]')?.focus();
  });
  state.target = null;
}

el.go.addEventListener('click', go);
el.goMini.addEventListener('click', go);

// ── Лента ──────────────────────────────────────────────────

async function loadFeed() {
  try {
    const list = await api('/api/upgrades/recent');
    el.feed.innerHTML = list.length
      ? list.map((w) => `
        <div class="feed-item" data-rarity="${esc(w.item.rarity || '')}">
          ${skinImage(w.item, '')}
          <div class="grow"><p class="name">${esc(w.item.name)}</p><p class="tiny muted">шанс ${fmtChance(w.chance)} · ${dateTime(w.at)}</p></div>
          <span class="num"><b>${lc(w.item.price)}</b></span>
        </div>`).join('')
      : '<p class="muted">Здесь появятся последние выигрыши. Стань первым!</p>';
  } catch {
    el.feed.innerHTML = '<p class="muted">Лента временно недоступна.</p>';
  }
}

async function loadOwned() {
  if (!state.user) return;
  state.owned = await api('/api/inventory').catch(() => []);
  // Скины, которых больше нет, убираем из выбора
  const ids = new Set(state.owned.filter((i) => i.status === 'owned').map((i) => i.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}

// ── Старт ──────────────────────────────────────────────────

buildTicks();
const s = await session();
state.user = s.user;
if (s.config) {
  state.cfg = s.config.upgrade;
}
await loadOwned();
renderInput();
render();
loadTargets(true);
loadFeed();
