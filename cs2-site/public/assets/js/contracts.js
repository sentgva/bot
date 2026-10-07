// Контракты: выбор 3–10 своих скинов, предпросмотр возможных результатов с шансами, подписание и лента-рулетка.
import {
  $, api, emptyState, esc, icon, loginUrl, lc, prefersReducedMotion, session, setBalance, skinCard, skinImage, toast, toastError, withLoading,
} from './core.js';

const el = {
  items: $('[data-ctr-items]'), count: $('[data-ctr-count]'), value: $('[data-ctr-value]'), range: $('[data-ctr-range]'),
  sign: $('[data-ctr-sign]'), why: $('[data-ctr-why]'), pool: $('[data-ctr-pool]'), roulette: $('[data-ctr-roulette]'), result: $('[data-ctr-result]'),
};
const state = { user: null, cfg: { minItems: 3, maxItems: 10, edge: 0.1 }, owned: [], selected: new Set(), preview: null, seq: 0, busy: false };

// Шанс: крупные — с одним знаком, маленькие — точнее
const fmtChance = (ppm) => `${(ppm / 10_000).toFixed(ppm >= 10_000 ? 1 : ppm >= 1_000 ? 2 : 4).replace(/\.?0+$/, '').replace('.', ',')}%`;

function renderItems() {
  if (!state.user) {
    el.items.innerHTML = emptyState({
      iconName: 'i-user', title: 'Войди, чтобы собрать контракт', text: 'Вход через Telegram — без паролей и регистрации.',
      action: `<a class="btn btn-primary" href="${esc(loginUrl())}">${icon('b-telegram')}<span>Войти через Telegram</span></a>`,
    });
    return;
  }
  const owned = state.owned.filter((i) => i.status === 'owned');
  if (!owned.length) {
    el.items.innerHTML = emptyState({
      iconName: 'i-package', title: 'Скинов пока нет', text: 'Открой пару кейсов — и собирай контракт из выпавших скинов.',
      action: '<a class="btn btn-primary btn-sm" href="/cases/">Открыть кейсы</a>',
    });
    return;
  }
  const full = state.selected.size >= state.cfg.maxItems;
  el.items.innerHTML = `<div class="upg-scroll"><div class="skin-grid" role="group" aria-label="Твои скины">${owned.map((i) => skinCard(i, {
    mode: 'select', selected: state.selected.has(i.id), disabled: full && !state.selected.has(i.id), attrs: `data-owned="${i.id}"`,
  })).join('')}</div></div>`;
}

function renderSummary() {
  const n = state.selected.size;
  const value = state.owned.filter((i) => state.selected.has(i.id)).reduce((a, i) => a + i.price, 0);
  el.count.textContent = `${n} / ${state.cfg.maxItems}`;
  el.value.textContent = lc(value);
  const p = state.preview;
  el.range.textContent = p ? `${lc(p.min)} – ${lc(p.max)}` : '—';
  const ready = Boolean(p) && n >= state.cfg.minItems && !state.busy;
  el.sign.disabled = !ready || !state.user;
  el.why.textContent = state.busy ? '' : !state.user ? 'Войди через Telegram, чтобы подписать контракт'
    : n < state.cfg.minItems ? `Выбери ещё ${state.cfg.minItems - n} — минимум ${state.cfg.minItems} скина`
      : p ? 'Шансы ниже — до подписания' : 'Считаем возможные результаты…';
}

function renderPool() {
  const p = state.preview;
  el.pool.innerHTML = p
    ? p.items.map((i) => skinCard(i, { tag: fmtChance(i.ppm) })).join('')
    : '<p class="muted small">Появится, когда выберешь скины.</p>';
}

// Предпросмотр с сервера: тот же расчёт, что при подписании
async function refreshPreview() {
  const seq = ++state.seq;
  state.preview = null;
  renderPool();
  renderSummary();
  if (state.selected.size < state.cfg.minItems) return;
  try {
    const p = await api('/api/contracts/preview', { method: 'POST', body: { ids: [...state.selected] } });
    if (seq !== state.seq) return;
    state.preview = p;
  } catch (err) {
    if (seq !== state.seq) return;
    el.why.textContent = err.message;
    return;
  }
  renderPool();
  renderSummary();
}

el.items.addEventListener('click', (e) => {
  const b = e.target.closest('[data-owned]');
  if (!b || state.busy || b.getAttribute('aria-disabled') === 'true') return;
  const id = Number(b.dataset.owned);
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  renderItems();
  refreshPreview();
});

// ── Подписание и лента ─────────────────────────────────────

const STRIP = 60;
const WIN_AT = 50;
function sample(items) {
  let r = Math.random() * 1_000_000;
  for (let i = items.length - 1; i >= 0; i--) { r -= items[i].ppm; if (r < 0) return items[i]; }
  return items[items.length - 1];
}
const stripCard = (i) => `<div class="r-card" data-rarity="${esc(i.rarity || '')}">${skinImage(i, '').replace('<div class="skin-img">', '').replace(/<\/div>$/, '')}<span class="r-name">${esc(i.name)}</span></div>`;

function spin(drop, pool) {
  el.roulette.innerHTML = `<div class="roulette"><div class="roulette-window"><div class="roulette-track">${
    Array.from({ length: STRIP }, (_, n) => stripCard(n === WIN_AT ? drop : sample(pool))).join('')
  }</div></div><span class="roulette-marker"></span></div>`;
  el.roulette.hidden = false;
  const track = $('.roulette-track', el.roulette);
  const fast = prefersReducedMotion();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const card = track.children[WIN_AT];
      const jitter = (Math.random() - 0.5) * card.offsetWidth * 0.7;
      const x = -(card.offsetLeft + card.offsetWidth / 2 - track.parentElement.clientWidth / 2 + jitter);
      track.style.setProperty('--spin', fast ? '900ms' : '5500ms');
      requestAnimationFrame(() => { track.classList.add('is-spinning'); track.style.setProperty('--x', `${x}px`); });
      const done = () => { card.classList.add('is-win'); resolve(); };
      track.addEventListener('transitionend', done, { once: true });
      setTimeout(done, fast ? 1400 : 6400);
    });
  });
}

function showResult(r) {
  const i = r.item;
  const mult = (i.price / r.value).toFixed(2).replace('.', ',');
  el.result.hidden = false;
  el.result.innerHTML = `
    <div class="case-drop" data-rarity="${esc(i.rarity || '')}">
      ${skinImage(i, i.hashName)}
      <div class="case-drop-text">
        <p class="eyebrow">Результат контракта · ×${mult} · шанс ${fmtChance(i.ppm)}</p>
        <p class="case-drop-name">${esc(i.hashName)}</p>
        <p class="case-drop-price">${lc(i.price)}</p>
        <div class="row mt-4">
          <button class="btn btn-secondary" type="button" data-sell="${r.userItemId}" data-loading="Продаём…">${icon('i-hand-coins')}<span>Продать за ${lc(r.sellPrice)}</span></button>
          <a class="btn btn-ghost" href="/upgrade/">${icon('i-trending-up')}<span>В апгрейд</span></a>
        </div>
        <p class="hint mt-2">Скин уже в инвентаре — его можно положить в новый контракт.</p>
      </div>
    </div>`;
}

el.sign.addEventListener('click', async () => {
  const p = state.preview;
  if (!p || state.busy) return;
  state.busy = true;
  el.result.hidden = true;
  renderSummary();
  try {
    const r = await withLoading(el.sign, () => api('/api/contracts/sign', { method: 'POST', body: { ids: [...state.selected], value: p.value } }));
    el.roulette.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    await spin(r.item, p.items);
    showResult(r);
    state.selected.clear();
    state.preview = null;
    state.owned = await api('/api/inventory').catch(() => []);
    renderItems();
    renderPool();
  } catch (err) {
    toastError(err);
    if (err.status === 409) { state.owned = await api('/api/inventory').catch(() => state.owned); renderItems(); refreshPreview(); }
  } finally {
    state.busy = false;
    renderSummary();
  }
});

el.result.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sell]');
  if (!b) return;
  await withLoading(b, async () => {
    try {
      const r = await api('/api/inventory/sell', { method: 'POST', body: { ids: [Number(b.dataset.sell)] } });
      if (typeof r.balance === 'number') setBalance(r.balance);
      toast(`Продано за ${lc(r.total)}`, 'success');
      b.replaceWith(Object.assign(document.createElement('span'), { className: 'badge badge-success', textContent: 'Продано' }));
      state.owned = await api('/api/inventory').catch(() => state.owned);
      renderItems();
    } catch (err) { toastError(err); }
  });
});

// ── Старт ──────────────────────────────────────────────────

const s = await session();
state.user = s.user;
if (s.config?.contracts) state.cfg = s.config.contracts;
$('[data-ctr-rtp]').textContent = `${Math.round((1 - state.cfg.edge) * 100)}%`;
if (state.user) state.owned = await api('/api/inventory').catch(() => []);
renderItems();
renderSummary();
