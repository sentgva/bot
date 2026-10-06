// Общий код всех страниц: тема, меню, сессия в шапке, API, форматирование, карточки скинов, уведомления.
// Подключается как ES-модуль (defer по умолчанию), страницы импортируют отсюда нужное.

const ICONS = '/assets/icons.svg';

// ── Утилиты ────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="${ICONS}#${name}"/></svg>`;

const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const rubFmt0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
// Копейки → «1 250 ₽». Копейки показываем только у сумм до 1 000 ₽ — так цифры читаются быстрее.
// exact: true — всегда с копейками (баланс в профиле, суммы выводов).
export const rub = (kop, { exact = false } = {}) => {
  const v = Math.round(kop) / 100;
  const short = !exact && Math.abs(v) >= 1000;
  return `${(short ? rubFmt0 : rubFmt).format(short ? Math.trunc(v) : v)} ₽`;
};
export const pct = (ppm, digits = 1) => `${(ppm / 10000).toFixed(digits).replace('.', ',')}%`;
export const dateTime = (v) => new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── API ────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || 'Сеть недоступна. Проверь подключение и попробуй ещё раз');
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'luxedrop', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Сессия грузится один раз на страницу
let sessionPromise;
export const session = () => (sessionPromise ??= api('/api/me').catch(() => ({ user: null, config: null })));
export async function refreshSession() {
  sessionPromise = api('/api/me').catch(() => ({ user: null, config: null }));
  const s = await sessionPromise;
  renderAuth(s.user);
  return s;
}

export const loginUrl = (next = location.pathname + location.hash) => `/api/auth/steam?next=${encodeURIComponent(next)}`;

// ── Уведомления ────────────────────────────────────────────

export function toast(message, type = 'info', { html = false, timeout = 5000 } = {}) {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const ico = { success: 'i-circle-check', error: 'i-circle-alert', info: 'i-info' }[type];
  el.innerHTML = `${icon(ico)}<div>${html ? message : esc(message)}</div>`;
  box.append(el);
  setTimeout(() => el.remove(), timeout);
}

export const toastError = (err) => toast(err?.message || 'Что-то пошло не так', 'error');

// Диалог подтверждения на <dialog>. Возвращает true/false.
export function confirmDialog({ title, html = '', confirm = 'Подтвердить', cancel = 'Отмена' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.setAttribute('aria-labelledby', 'dlg-title');
    d.innerHTML = `
      <form method="dialog" class="modal-body">
        <h2 id="dlg-title" class="h3">${esc(title)}</h2>
        <div class="muted">${html}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary" value="cancel">${esc(cancel)}</button>
          <button class="btn btn-primary" value="ok" autofocus>${esc(confirm)}</button>
        </div>
      </form>`;
    document.body.append(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
    d.showModal();
  });
}

// Кнопка в состоянии загрузки
export async function withLoading(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.classList.add('is-loading');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.innerHTML = `${icon('i-loader-circle')}<span>${esc(btn.dataset.loading || 'Секунду…')}</span>`;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

// ── Скины ──────────────────────────────────────────────────

const WEAR = {
  'Factory New': ['FN', 'Прямо с завода'], 'Minimal Wear': ['MW', 'Немного поношенное'], 'Field-Tested': ['FT', 'После полевых испытаний'],
  'Well-Worn': ['WW', 'Поношенное'], 'Battle-Scarred': ['BS', 'Закалённое в боях'],
};
export const RARITY = {
  consumer: 'Ширпотреб', industrial: 'Промышленное', milspec: 'Армейское', restricted: 'Запрещённое',
  classified: 'Засекреченное', covert: 'Тайное', gold: 'Редкое ★',
};
export const wearLabel = (w) => WEAR[w]?.[1] || '';
export const wearShort = (w) => WEAR[w]?.[0] || '';

// Силуэт оружия — показывается, пока нет картинки скина
const SILHOUETTE = '<svg class="silhouette" viewBox="0 0 120 44" fill="currentColor" aria-hidden="true"><path d="M4 18h34l3-4h34l2-3h9v3h28v5h-28l-3 4H72l-7 15h-9l5-13H44l-4 11H30l3-11H18l-9 5H4z"/></svg>';

// Картинки Steam CDN отдаются нужного размера по суффиксу — не тянем полноразмерные PNG
const sized = (url) => (/steamstatic\.com\/economy\/image\/[^/]+$/.test(url) ? `${url}/256fx192f` : url);

export function skinImage(item, alt = '') {
  if (!item.image) return `<div class="skin-img">${SILHOUETTE}</div>`;
  return `<div class="skin-img"><img src="${esc(sized(item.image))}" alt="${esc(alt)}" loading="lazy" decoding="async" width="256" height="192"></div>`;
}

// Картинка не загрузилась (CDN недоступен) — показываем силуэт. Слушаем на document: inline-обработчики запрещены CSP.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.parentElement?.classList.contains('skin-img')) img.outerHTML = SILHOUETTE;
}, true);

// Карточка скина. mode: 'static' (div) | 'select' (кнопка-переключатель)
export function skinCard(item, { mode = 'static', selected = false, disabled = false, price = item.price, actions = '', tag = '', attrs = '' } = {}) {
  const meta = [item.stattrak ? 'StatTrak™' : '', wearShort(item.wear)].filter(Boolean).join(' · ');
  const name = item.name || item.hashName;
  const inner = `
    ${tag ? `<span class="skin-tag">${tag}</span>` : ''}
    ${mode === 'select' ? `<span class="check">${icon('i-check', 'icon icon-sm')}</span>` : ''}
    ${skinImage(item, name)}
    <span class="skin-name">${esc(name)}</span>
    <span class="skin-meta">${esc(meta || RARITY[item.rarity] || ' ')}</span>
    <span class="skin-price">${price != null ? rub(price) : '—'}</span>
    ${actions ? `<span class="skin-actions">${actions}</span>` : ''}`;
  const common = `data-rarity="${esc(item.rarity || '')}" title="${esc(item.hashName || name)}" ${attrs}`;
  if (mode === 'select') {
    return `<button type="button" class="skin" aria-pressed="${selected}" ${disabled ? 'aria-disabled="true"' : ''} ${common}>${inner}</button>`;
  }
  return `<article class="skin" ${common}>${inner}</article>`;
}

export const skeletonCards = (n = 8) => Array.from({ length: n }, () => '<div class="skeleton skeleton-card" aria-hidden="true"></div>').join('');

export function emptyState({ iconName = 'i-package', title, text = '', action = '' }) {
  return `<div class="empty"><span class="icon-tile">${icon(iconName, 'icon icon-lg')}</span><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action}</div>`;
}

// ── Шапка: тема, меню, вход ───────────────────────────────

function initTheme() {
  const btns = $$('[data-theme-toggle]');
  const current = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const sync = () => btns.forEach((b) => b.setAttribute('aria-label', current() === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'));
  btns.forEach((b) => b.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ld-theme', next); } catch { /* приватный режим */ }
    sync();
  }));
  sync();
}

function initNav() {
  const btn = $('[data-nav-toggle]');
  const nav = $('#site-nav');
  if (!btn || !nav) return;
  const set = (open) => {
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    btn.querySelector('use').setAttribute('href', `${ICONS}#${open ? 'i-x' : 'i-menu'}`);
  };
  btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('is-open')) { set(false); btn.focus(); } });
}

export function renderAuth(user) {
  const box = $('[data-auth]');
  if (!box) return;
  if (!user) {
    box.innerHTML = `<a class="btn btn-primary btn-sm" href="${esc(loginUrl())}">${icon('b-steam')}<span>Войти<span class="hide-sm"> через Steam</span></span></a>`;
    return;
  }
  const initials = esc(user.name.trim().slice(0, 1).toUpperCase());
  const avatar = user.avatar
    ? `<img class="avatar" src="${esc(user.avatar)}" alt="" width="44" height="44">`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${initials}</span>`;
  box.innerHTML = `
    <a class="balance-chip" href="/profile/#wallet" aria-label="Баланс ${rub(user.balance)}, пополнить или вывести">${icon('i-wallet')}<span data-balance>${rub(user.balance)}</span></a>
    <a class="avatar-link" href="/profile/" aria-label="Профиль: ${esc(user.name)}">${avatar}</a>`;
}

// Обновить баланс в шапке без перезагрузки
export function setBalance(kop) {
  $$('[data-balance]').forEach((el) => { el.textContent = rub(kop); });
}

// ── Появление при скролле ──────────────────────────────────

function initReveal() {
  const els = $$('.reveal');
  if (!els.length) return;
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
}

// Сообщения после входа через Steam (?login=failed)
function loginNotice() {
  const p = new URLSearchParams(location.search);
  const v = p.get('login');
  if (!v) return;
  toast(v === 'banned' ? 'Аккаунт заблокирован. Напиши в поддержку' : 'Не получилось войти через Steam. Попробуй ещё раз', 'error');
  p.delete('login');
  history.replaceState(null, '', location.pathname + (p.size ? `?${p}` : '') + location.hash);
}

// ── Старт ──────────────────────────────────────────────────

document.documentElement.classList.remove('no-js');
initTheme();
initNav();
initReveal();
loginNotice();
session().then((s) => renderAuth(s.user));
