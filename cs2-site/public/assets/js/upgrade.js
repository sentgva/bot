// Апгрейдер: выбор ставки (скины + баланс), выбор цели, расчёт шанса, бросок с анимацией стрелки.
import {
  $, $$, api, dateTime, emptyState, esc, icon, loginUrl, pct, prefersReducedMotion, rub, session, setBalance,
  skeletonCards, skinCard, skinImage, toastError, withLoading,
} from './core.js';

const C = 2 * Math.PI * 52; // длина окружности кольца
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
};

const el = {
  inputBody: $('[data-input-body]'), inputTotal: $('[data-input-total]'),
  balanceBox: $('[data-balance-box]'), stake: $('#stake'), range: $('[data-stake-range]'), balanceLeft: $('[data-balance-left]'),
  sumIn: $('[data-sum-in]'), sumTarget: $('[data-sum-target]'),
  ringWin: $('[data-ring-win]'), pointer: $('[data-pointer]'), chance: $('[data-chance]'), multLabel: $('[data-mult]'),
  go: $('[data-go]'), goMini: $('[data-go-mini]'), chanceMini: $('[data-chance-mini]'), why: $('[data-why]'), result: $('[data-result]'),
  targets: $('[data-targets]'), more: $('[data-targets-more]'), q: $('#target-q'), multFilter: $('[data-mult-filter]'),
  feed: $('[data-feed]'),
  fairHash: $('[data-fair-hash]'), fairClient: $('[data-fair-client]'), fairNonce: $('[data-fair-nonce]'),
};

// ── Расчёт ─────────────────────────────────────────────────

const inputValue = () => state.owned.filter((i) => state.selected.has(i.id)).reduce((s, i) => s + i.price, 0) + state.stake;

function calc() {
  const value = inputValue();
  if (!value || !state.target) return { value, chance: 0, ok: false, reason: state.user ? 'Выбери скины или сумму слева и цель справа' : 'Войди через Steam, чтобы сделать ставку' };
  const raw = (value / state.target.price) * (1 - state.cfg.houseEdge);
  if (value < state.cfg.minValue) return { value, chance: raw, ok: false, reason: `Минимальная ставка — ${rub(state.cfg.minValue)}` };
  if (raw > state.cfg.maxChance) return { value, chance: raw, ok: false, reason: `Шанс выше ${Math.round(state.cfg.maxChance * 100)}% — выбери цель дороже` };
  if (raw < state.cfg.minChance) return { value, chance: raw, ok: false, reason: 'Шанс меньше 1% — выбери цель дешевле или добавь ставку' };
  return { value, chance: raw, ok: true, reason: '' };
}

function render() {
  const { value, chance, ok, reason } = calc();
  const shown = Math.min(chance, state.cfg.maxChance);
  el.inputTotal.textContent = rub(value);
  el.sumIn.textContent = rub(value);
  el.sumTarget.textContent = state.target ? rub(state.target.price) : '—';
  el.ringWin.setAttribute('stroke-dasharray', `${(shown * C).toFixed(2)} ${C.toFixed(2)}`);
  el.ringWin.style.opacity = shown > 0 ? '1' : '0';
  const chanceText = pct(Math.floor(shown * 1e6));
  el.chance.textContent = chanceText;
  el.chanceMini.textContent = chanceText;
  el.multLabel.textContent = state.target && value ? `шанс · ×${(state.target.price / value).toFixed(2).replace('.', ',')}` : 'выбери ставку и цель';
  const can = ok && !state.spinning && Boolean(state.user);
  el.go.disabled = !can;
  el.goMini.disabled = !can;
  el.why.textContent = state.spinning ? '' : reason;
}

// ── Ставка ─────────────────────────────────────────────────

function renderInput() {
  if (!state.user) {
    el.inputBody.innerHTML = emptyState({
      iconName: 'i-user', title: 'Войди, чтобы сделать ставку', text: 'Вход через Steam — пароль мы не видим.',
      action: `<a class="btn btn-primary" href="${esc(loginUrl())}">${icon('b-steam')}<span>Войти через Steam</span></a>`,
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
      action: '<a class="btn btn-secondary btn-sm" href="/market/">Открыть маркет</a>',
    });
  el.balanceBox.hidden = false;
  const max = Math.floor(state.user.balance / 100);
  el.range.max = String(max);
  el.stake.max = String(max);
  el.balanceLeft.textContent = rub(state.user.balance);
}

el.inputBody.addEventListener('click', (e) => {
  const card = e.target.closest('[data-owned]');
  if (!card || card.getAttribute('aria-disabled') === 'true' || state.spinning) return;
  const id = Number(card.dataset.owned);
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
el.stake.addEventListener('input', () => setStake(el.stake.value));
el.range.addEventListener('input', () => setStake(el.range.value));
let stakeTimer;
[el.stake, el.range].forEach((x) => x.addEventListener('change', () => { clearTimeout(stakeTimer); stakeTimer = setTimeout(() => loadTargets(true), 200); }));

// ── Цели ───────────────────────────────────────────────────

function targetRange() {
  const value = inputValue();
  const { houseEdge, maxChance, minChance } = state.cfg;
  if (!value) return { min: 0, max: 0 };
  let min = Math.ceil((value * (1 - houseEdge)) / maxChance);
  const max = Math.floor((value * (1 - houseEdge)) / minChance);
  if (state.mult) min = Math.max(min, Math.ceil(value * state.mult));
  return { min, max };
}

let loadSeq = 0;
async function loadTargets(reset = false) {
  const seq = ++loadSeq;
  if (reset) { state.offset = 0; state.targets = []; el.targets.innerHTML = skeletonCards(6); }
  const { min, max } = targetRange();
  const p = new URLSearchParams({ q: state.q, sort: inputValue() ? 'price_asc' : 'popular', offset: String(state.offset), limit: String(PAGE) });
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
  state.target = state.target?.hashName === item.hashName ? null : item;
  $$('[data-target]', el.targets).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.target === state.target?.hashName)));
  el.result.innerHTML = '';
  render();
});
el.more.querySelector('button').addEventListener('click', () => loadTargets(false));

let qTimer;
el.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = el.q.value.trim(); loadTargets(true); }, 300); });

el.multFilter.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-mult-value]');
  if (!chip) return;
  state.mult = Number(chip.dataset.multValue);
  $$('[data-mult-value]', el.multFilter).forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
  loadTargets(true);
});

// ── Бросок ─────────────────────────────────────────────────

function spinTo(roll) {
  // Стрелка делает несколько оборотов и останавливается на результате броска
  const target = (roll / 1e6) * 360;
  const base = state.angle - (state.angle % 360);
  state.angle = base + 360 * 5 + target;
  if (prefersReducedMotion()) {
    el.pointer.style.transition = 'none';
    el.pointer.style.transform = `rotate(${state.angle}deg)`;
    return Promise.resolve();
  }
  el.pointer.style.transition = '';
  el.pointer.style.transform = `rotate(${state.angle}deg)`;
  return new Promise((resolve) => {
    const done = () => { el.pointer.removeEventListener('transitionend', done); resolve(); };
    el.pointer.addEventListener('transitionend', done);
    setTimeout(done, 4600);
  });
}

async function go() {
  const { ok } = calc();
  if (!ok || state.spinning) return;
  const body = { itemIds: [...state.selected], balance: state.stake, target: state.target.hashName };
  state.spinning = true;
  el.result.innerHTML = '';
  render();
  try {
    const r = await withLoading(el.go, () => api('/api/upgrade', { method: 'POST', body }));
    await spinTo(r.roll);
    state.user.balance = r.balance;
    state.user.fair.nonce = r.fair.nonce + 1;
    setBalance(r.balance);
    showResult(r);
    state.selected.clear();
    setStake(0);
    await loadOwned();
    loadTargets(true);
  } catch (err) {
    toastError(err);
    if (err.status === 409) await loadOwned();
  } finally {
    state.spinning = false;
    renderInput();
    renderFair();
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
    <p class="small muted mt-2">Бросок ${r.roll.toLocaleString('ru-RU')} из 1 000 000, нужно было меньше ${r.chance.toLocaleString('ru-RU')} (шанс ${pct(r.chance)}).</p>
    ${actions}`;
  el.result.querySelector('[data-again]')?.addEventListener('click', () => {
    el.result.innerHTML = '';
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

// ── Честность и лента ──────────────────────────────────────

function renderFair() {
  const f = state.user?.fair;
  el.fairHash.textContent = f ? f.serverSeedHash : 'появится после входа';
  el.fairClient.textContent = f ? f.clientSeed : '—';
  el.fairNonce.textContent = f ? String(f.nonce) : '0';
}

async function loadFeed() {
  try {
    const list = await api('/api/upgrades/recent');
    el.feed.innerHTML = list.length
      ? list.map((w) => `
        <div class="feed-item" data-rarity="${esc(w.item.rarity || '')}">
          ${skinImage(w.item, '')}
          <div class="grow"><p class="name">${esc(w.item.name)}</p><p class="tiny muted">${esc(w.user)} · шанс ${pct(w.chance)} · ${dateTime(w.at)}</p></div>
          <span class="num"><b>${rub(w.item.price)}</b></span>
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

const s = await session();
state.user = s.user;
if (s.config) state.cfg = s.config.upgrade;
await loadOwned();
renderInput();
renderFair();
render();
loadTargets(true);
loadFeed();
