// Кейсы: сетка кейсов, страница кейса (?c=slug), лента-рулетка как в CS и результат.
import {
  $, api, esc, icon, loginUrl, lc, pct, prefersReducedMotion, session, setBalance, skinCard, skinImage, toast, toastError, withLoading,
} from './core.js';
import { caseArt, caseCard, paint } from './case-art.js';

const grid = $('[data-cases-grid]');
const view = $('[data-case-view]');
const head = $('[data-cases-head]');
const openBtn = $('[data-open]');
const roulette = $('[data-roulette]');
const track = $('[data-track]');
const result = $('[data-result]');

const state = { cases: [], current: null, user: null, spinning: false };

// ── Сетка кейсов ───────────────────────────────────────────

function renderGrid() {
  grid.removeAttribute('aria-busy');
  if (!state.cases.length) {
    grid.innerHTML = '<p class="muted">Кейсы скоро появятся — подтягиваем цены скинов.</p>';
    return;
  }
  grid.innerHTML = state.cases.map(caseCard).join('');
  paint(grid);
}

// ── Страница кейса ─────────────────────────────────────────

function showCase(slug, push = false) {
  const c = state.cases.find((x) => x.slug === slug);
  if (!c) { showGrid(push); return; }
  state.current = c;
  if (push) history.pushState({ c: slug }, '', `/cases/?c=${encodeURIComponent(slug)}`);
  document.title = `Кейс «${c.name}» — LuxeDrop`;
  head.hidden = true;
  grid.hidden = true;
  view.hidden = false;
  $('[data-case-art]').outerHTML = caseArt(c, true).replace('class="case-art', 'data-case-art class="case-art');
  $('[data-case-name]').textContent = `Кейс «${c.name}»`;
  $('[data-case-sub]').textContent = `${c.items.length} скинов · самый дорогой — ${c.items[0].name} за ${lc(c.items[0].price)}`;
  $('[data-case-items]').innerHTML = c.items.map((i) => skinCard(i, { tag: pct(i.ppm, i.ppm < 1000 ? 3 : 2) })).join('');
  roulette.hidden = true;
  result.hidden = true;
  paint(view);
  renderOpenButton();
  scrollTo({ top: 0 });
}

function showGrid(push = false) {
  if (push) history.pushState({}, '', '/cases/');
  document.title = 'Кейсы CS2 с открытыми шансами — LuxeDrop';
  state.current = null;
  head.hidden = false;
  grid.hidden = false;
  view.hidden = true;
}

function renderOpenButton() {
  const c = state.current;
  if (!c) return;
  const label = $('[data-open-label]');
  openBtn.disabled = state.spinning;
  if (!state.user) { label.textContent = 'Войти, чтобы открыть'; return; }
  if (state.user.balance < c.price) { label.textContent = `Пополнить · нужно ${lc(c.price)}`; return; }
  label.textContent = `Открыть за ${lc(c.price)}`;
}

// ── Рулетка ────────────────────────────────────────────────

const STRIP = 60;
const WIN_AT = 50;

// Лента собирается по настоящим шансам кейса — без подкрученных «почти выпало»
function sample(items) {
  let r = Math.random() * 1_000_000;
  for (let i = items.length - 1; i >= 0; i--) { r -= items[i].ppm; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

const stripCard = (i) => `<div class="r-card" data-rarity="${esc(i.rarity || '')}">${skinImage(i, '').replace('<div class="skin-img">', '').replace(/<\/div>$/, '')}<span class="r-name">${esc(i.name)}</span></div>`;

function spin(drop) {
  const items = Array.from({ length: STRIP }, (_, n) => (n === WIN_AT ? drop : sample(state.current.items)));
  track.innerHTML = items.map(stripCard).join('');
  track.classList.remove('is-spinning');
  track.style.setProperty('--x', '0px');
  roulette.hidden = false;
  const fast = $('[data-fast]').checked || prefersReducedMotion();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const card = track.children[WIN_AT];
      const windowWidth = track.parentElement.clientWidth;
      const jitter = (Math.random() - 0.5) * card.offsetWidth * 0.7;
      const x = -(card.offsetLeft + card.offsetWidth / 2 - windowWidth / 2 + jitter);
      track.style.setProperty('--spin', fast ? '900ms' : '6500ms');
      // Даём браузеру применить начальное положение, затем запускаем прокрутку
      requestAnimationFrame(() => {
        track.classList.add('is-spinning');
        track.style.setProperty('--x', `${x}px`);
      });
      const done = () => { card.classList.add('is-win'); resolve(); };
      track.addEventListener('transitionend', done, { once: true });
      setTimeout(done, fast ? 1400 : 7200); // на случай, если transitionend не придёт
    });
  });
}

function showResult(r) {
  const i = r.item;
  result.hidden = false;
  result.innerHTML = `
    <div class="case-drop" data-rarity="${esc(i.rarity || '')}">
      ${skinImage(i, i.hashName)}
      <div class="case-drop-text">
        <p class="eyebrow">Твой дроп · шанс ${pct(i.ppm, i.ppm < 1000 ? 3 : 2)}</p>
        <p class="h3">${esc(i.hashName)}</p>
        <p class="case-drop-price">${lc(i.price)}</p>
        <div class="row mt-4">
          <button class="btn btn-secondary" type="button" data-sell="${r.userItemId}" data-loading="Продаём…">${icon('i-hand-coins')}<span>Продать за ${lc(r.sellPrice)}</span></button>
          <a class="btn btn-ghost" href="/upgrade/">${icon('i-trending-up')}<span>В апгрейд</span></a>
          <button class="btn btn-primary" type="button" data-again>${icon('i-package')}<span>Открыть ещё</span></button>
        </div>
        <p class="hint mt-2">Скин уже в инвентаре — можно забрать позже в профиле.</p>
      </div>
    </div>`;
}

async function open() {
  const c = state.current;
  if (!c || state.spinning) return;
  if (!state.user) { location.href = loginUrl(`/cases/?c=${c.slug}`); return; }
  if (state.user.balance < c.price) { location.href = '/profile/#wallet'; return; }
  state.spinning = true;
  result.hidden = true;
  renderOpenButton();
  try {
    const r = await withLoading(openBtn, () => api(`/api/cases/${encodeURIComponent(c.slug)}/open`, { method: 'POST' }));
    state.user.balance = r.balance;
    setBalance(r.balance);
    roulette.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    await spin(r.item);
    showResult(r);
  } catch (err) {
    toastError(err);
  } finally {
    state.spinning = false;
    renderOpenButton();
  }
}

openBtn.addEventListener('click', open);
result.addEventListener('click', async (e) => {
  if (e.target.closest('[data-again]')) { open(); return; }
  const sell = e.target.closest('[data-sell]');
  if (!sell) return;
  await withLoading(sell, async () => {
    try {
      const r = await api('/api/inventory/sell', { method: 'POST', body: { ids: [Number(sell.dataset.sell)] } });
      if (typeof r.balance === 'number') { state.user.balance = r.balance; setBalance(r.balance); }
      toast('Скин продан, LC на балансе', 'success');
      sell.replaceWith(Object.assign(document.createElement('span'), { className: 'badge badge-success', textContent: 'Продано' }));
      renderOpenButton();
    } catch (err) { toastError(err); }
  });
});

// Переходы внутри страницы без перезагрузки
grid.addEventListener('click', (e) => {
  const a = e.target.closest('[data-case]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  showCase(a.dataset.case, true);
});
$('[data-case-back]').addEventListener('click', (e) => { e.preventDefault(); if (!state.spinning) showGrid(true); });
addEventListener('popstate', () => {
  const slug = new URLSearchParams(location.search).get('c');
  if (slug) showCase(slug); else showGrid();
});

// ── Старт ──────────────────────────────────────────────────

const [list, s] = await Promise.all([api('/api/cases').catch(() => []), session()]);
state.cases = list;
state.user = s.user;
const edge = s.config?.cases?.edge;
if (edge != null) $('[data-case-rtp]').textContent = `${Math.round((1 - edge) * 100)}%`;
renderGrid();
const initial = new URLSearchParams(location.search).get('c');
if (initial) showCase(initial);
