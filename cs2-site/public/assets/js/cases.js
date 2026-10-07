// Кейсы: сетка кейсов, страница кейса (?c=slug), лента-рулетка как в CS и результат.
import {
  $, $$, api, esc, icon, loginUrl, lc, pct, prefersReducedMotion, session, setBalance, skinCard, skinImage, toast, toastError, withLoading,
} from './core.js';
import { caseArt, caseCard, paint } from './case-art.js';

const grid = $('[data-cases-grid]');
const view = $('[data-case-view]');
const head = $('[data-cases-head]');
const openBtn = $('[data-open]');
const roulettes = $('[data-roulettes]');
const result = $('[data-result]');

const state = { cases: [], current: null, user: null, spinning: false, count: 1 };

// ── Сетка кейсов ───────────────────────────────────────────

function renderGrid() {
  grid.removeAttribute('aria-busy');
  if (!state.cases.length) {
    grid.innerHTML = '<p class="muted">Кейсы скоро появятся — подтягиваем цены скинов.</p>';
    return;
  }
  const cs = state.cases.filter((c) => c.kind === 'cs');
  const own = state.cases.filter((c) => c.kind !== 'cs');
  const group = (title, list) => (list.length ? `<h2 class="h3 case-group">${title}</h2>${list.map(caseCard).join('')}` : '');
  grid.innerHTML = group('Кейсы CS2', cs) + group('Кейсы LuxeDrop', own);
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
  roulettes.hidden = true;
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
  const total = c.price * state.count;
  openBtn.disabled = state.spinning;
  $$('[data-count]').forEach((b) => { b.setAttribute('aria-pressed', String(Number(b.dataset.count) === state.count)); b.disabled = state.spinning; });
  if (!state.user) { label.textContent = 'Войти, чтобы открыть'; return; }
  if (state.user.balance < total) { label.textContent = `Пополнить · нужно ${lc(total)}`; return; }
  label.textContent = state.count > 1 ? `Открыть ${state.count} за ${lc(total)}` : `Открыть за ${lc(total)}`;
}

// ── Рулетка: по ленте на каждый кейс, крутятся одновременно ──

const STRIP = 60;
const WIN_AT = 50;

// Лента собирается по настоящим шансам кейса — без подкрученных «почти выпало»
function sample(items) {
  let r = Math.random() * 1_000_000;
  for (let i = items.length - 1; i >= 0; i--) { r -= items[i].ppm; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

const stripCard = (i) => `<div class="r-card" data-rarity="${esc(i.rarity || '')}">${skinImage(i, '').replace('<div class="skin-img">', '').replace(/<\/div>$/, '')}<span class="r-name">${esc(i.name)}</span></div>`;

function spinAll(drops) {
  const fast = $('[data-fast]').checked || prefersReducedMotion();
  roulettes.classList.toggle('is-multi', drops.length > 1);
  roulettes.innerHTML = drops.map((d) => `<div class="roulette"><div class="roulette-window"><div class="roulette-track">${
    Array.from({ length: STRIP }, (_, n) => stripCard(n === WIN_AT ? d.item : sample(state.current.items))).join('')
  }</div></div><span class="roulette-marker"></span></div>`).join('');
  roulettes.hidden = false;
  const tracks = $$('.roulette-track', roulettes);
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      tracks.forEach((track, i) => {
        const card = track.children[WIN_AT];
        const jitter = (Math.random() - 0.5) * card.offsetWidth * 0.7;
        const x = -(card.offsetLeft + card.offsetWidth / 2 - track.parentElement.clientWidth / 2 + jitter);
        // Ленты останавливаются чуть вразнобой — как на больших сайтах кейсов
        track.style.setProperty('--spin', `${(fast ? 900 : 6000) + i * (fast ? 120 : 350)}ms`);
        requestAnimationFrame(() => { track.classList.add('is-spinning'); track.style.setProperty('--x', `${x}px`); });
      });
      const last = tracks[tracks.length - 1];
      const done = () => { tracks.forEach((t) => t.children[WIN_AT].classList.add('is-win')); resolve(); };
      last.addEventListener('transitionend', done, { once: true });
      setTimeout(done, (fast ? 1600 : 8200) + tracks.length * 400); // на случай, если transitionend не придёт
    });
  });
}

function showResult(r) {
  result.hidden = false;
  const drops = r.drops;
  const sum = drops.reduce((a, d) => a + d.sellPrice, 0);
  const won = drops.reduce((a, d) => a + d.item.price, 0);
  result.innerHTML = `
    <div class="case-result-head">
      <p class="h3">${drops.length > 1 ? `Дроп из ${drops.length} кейсов · ${lc(won)}` : 'Твой дроп'}</p>
      <div class="row">
        <button class="btn btn-secondary" type="button" data-sell-all data-loading="Продаём…">${icon('i-hand-coins')}<span>Продать ${drops.length > 1 ? 'всё ' : ''}за ${lc(sum)}</span></button>
        <a class="btn btn-ghost" href="/upgrade/">${icon('i-trending-up')}<span>В апгрейд</span></a>
        <button class="btn btn-primary" type="button" data-again>${icon('i-package')}<span>Открыть ещё</span></button>
      </div>
    </div>
    <div class="case-drops${drops.length > 1 ? ' is-multi' : ''}">${drops.map((d) => `
      <div class="case-drop" data-rarity="${esc(d.item.rarity || '')}" data-drop="${d.userItemId}">
        ${skinImage(d.item, d.item.hashName)}
        <div class="case-drop-text">
          <p class="eyebrow">Шанс ${pct(d.item.ppm, d.item.ppm < 1000 ? 3 : 2)}</p>
          <p class="case-drop-name">${esc(d.item.hashName)}</p>
          <p class="case-drop-price">${lc(d.item.price)}</p>
          <button class="btn btn-ghost btn-sm" type="button" data-sell="${d.userItemId}" data-price="${d.sellPrice}" data-loading="…">Продать за ${lc(d.sellPrice)}</button>
        </div>
      </div>`).join('')}</div>
    <p class="hint mt-2">Скины уже в инвентаре — можно забрать позже в профиле.</p>`;
}

async function open() {
  const c = state.current;
  if (!c || state.spinning) return;
  if (!state.user) { location.href = loginUrl(`/cases/?c=${c.slug}`); return; }
  if (state.user.balance < c.price * state.count) { location.href = '/profile/#wallet'; return; }
  state.spinning = true;
  result.hidden = true;
  renderOpenButton();
  try {
    const r = await withLoading(openBtn, () => api(`/api/cases/${encodeURIComponent(c.slug)}/open`, { method: 'POST', body: { count: state.count, price: c.price } }));
    state.user.balance = r.balance;
    setBalance(r.balance);
    roulettes.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    await spinAll(r.drops || [r]);
    showResult({ drops: r.drops || [r] });
  } catch (err) {
    // Цена кейса CS2 обновилась вместе с ценами скинов — показываем новую, игрок жмёт ещё раз
    if (err.status === 409 && err.data?.price) { c.price = err.data.price; }
    toastError(err);
  } finally {
    state.spinning = false;
    renderOpenButton();
  }
}

async function sell(ids, btn) {
  await withLoading(btn, async () => {
    try {
      const r = await api('/api/inventory/sell', { method: 'POST', body: { ids } });
      if (typeof r.balance === 'number') { state.user.balance = r.balance; setBalance(r.balance); }
      toast(`Продано на ${lc(r.total)}`, 'success');
      for (const id of ids) {
        const b = $(`[data-sell="${id}"]`, result);
        b?.replaceWith(Object.assign(document.createElement('span'), { className: 'badge badge-success', textContent: 'Продано' }));
      }
      $('[data-sell-all]', result)?.remove();
      renderOpenButton();
    } catch (err) { toastError(err); }
  });
}

openBtn.addEventListener('click', open);
$('[data-counts]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-count]');
  if (!b || state.spinning) return;
  state.count = Number(b.dataset.count);
  renderOpenButton();
});
result.addEventListener('click', (e) => {
  if (e.target.closest('[data-again]')) { open(); return; }
  const all = e.target.closest('[data-sell-all]');
  if (all) { sell($$('[data-sell]', result).map((b) => Number(b.dataset.sell)), all); return; }
  const one = e.target.closest('[data-sell]');
  if (one) sell([Number(one.dataset.sell)], one);
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
