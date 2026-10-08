// Общий код всех страниц: тема, меню, сессия в шапке, API, форматирование, карточки скинов, уведомления.
// Подключается как ES-модуль (defer по умолчанию), страницы импортируют отсюда нужное.

const ICONS = '/assets/icons.svg';

// ── Утилиты ────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="${ICONS}#${name}"/></svg>`;

const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
// LuxeCoin — валюта сайта (1 LC = 1 ₽ стоимости скинов). Сотые доли → «1 250 LC», всегда вниз до целого.
export const lc = (v) => `${intFmt.format(Math.floor(v / 100))} LC`;
// Настоящие рубли — только там, где деньги уходят на карту/СБП (сумма к выплате)
export const rub = (kop) => `${rubFmt.format(Math.round(kop) / 100)} ₽`;
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

// Код пригласившего (?ref=КОД в ссылке) — запоминаем на 30 дней, отправляем при первом входе
const REF_TTL = 30 * 24 * 3600 * 1000;
try {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref && /^[0-9A-Za-z]{2,12}$/.test(ref)) localStorage.setItem('ld-ref', JSON.stringify({ ref, at: Date.now() }));
} catch { /* хранилище недоступно */ }
export function getRef() {
  try {
    const v = JSON.parse(localStorage.getItem('ld-ref') || 'null');
    return v && Date.now() - v.at < REF_TTL ? v.ref : null;
  } catch { return null; }
}

// Токен сессии для Telegram Mini App (там cookie могут быть недоступны). На обычном сайте его нет.
let memoryToken = null;
export function getToken() {
  try { return sessionStorage.getItem('ld-token') || memoryToken; } catch { return memoryToken; }
}
export function setToken(token) {
  memoryToken = token;
  try { if (token) sessionStorage.setItem('ld-token', token); else sessionStorage.removeItem('ld-token'); } catch { /* приватный режим */ }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  const token = getToken();
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'luxedrop',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ── Telegram Mini App ──────────────────────────────────────
// Сайт открыт из бота: Telegram передаёт данные запуска в адресе (#tgWebAppData=…).
// Запоминаем это на время сессии, чтобы режим сохранялся при переходах между страницами.
export function inTelegram() {
  const launched = /tgWebAppData=/.test(location.hash);
  try {
    if (launched) sessionStorage.setItem('ld-tg', '1');
    return launched || sessionStorage.getItem('ld-tg') === '1';
  } catch {
    return launched;
  }
}
const tgModule = inTelegram() ? import('./tg.js').catch((err) => { console.error(err); return null; }) : null;
const tgReady = tgModule?.then((m) => m?.init()).catch((err) => { console.error(err); return null; });

async function loadMe() {
  await tgReady;
  const me = await api('/api/me').catch(() => ({ user: null, config: null }));
  // Токен Mini App истёк — входим заново по данным запуска из Telegram
  if (!me.user && tgModule) {
    const tg = await tgModule;
    if (await tg?.login()) return api('/api/me').catch(() => me);
  }
  return me;
}

// Сессия грузится один раз на страницу
let sessionPromise;
export const session = () => (sessionPromise ??= loadMe());
export async function refreshSession() {
  sessionPromise = api('/api/me').catch(() => ({ user: null, config: null }));
  const s = await sessionPromise;
  renderAuth(s.user);
  return s;
}

// Вход только через Telegram: страница /login/ сразу отправляет на oauth.telegram.org и возвращает обратно
export const loginUrl = (next = location.pathname + location.hash) => `/login/?auto=1&next=${encodeURIComponent(next)}`;

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
  const wasDisabled = btn.disabled; // кнопку, выключенную до запроса, не включаем обратно
  btn.classList.add('is-loading');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.innerHTML = `${icon('i-loader-circle')}<span>${esc(btn.dataset.loading || 'Секунду…')}</span>`;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = wasDisabled;
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
export const sized = (url) => (/steamstatic\.com\/economy\/image\/[^/]+$/.test(url) ? `${url}/256fx192f` : url);

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
    <span class="skin-price">${price != null ? lc(price) : '—'}</span>
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
  const current = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'); // тёмная — по умолчанию
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
    box.innerHTML = `<a class="btn btn-primary btn-sm" href="${esc(loginUrl())}">${icon('b-telegram')}<span>Войти<span class="hide-sm"> через Telegram</span></span></a>`;
    return;
  }
  const initials = esc(user.name.trim().slice(0, 1).toUpperCase());
  const avatar = user.avatar
    ? `<img class="avatar" src="${esc(user.avatar)}" alt="" width="44" height="44">`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${initials}</span>`;
  box.innerHTML = `
    <a class="balance-chip" href="/profile/#wallet" aria-label="Баланс ${lc(user.balance)}, пополнить или вывести">${icon('i-crown', 'icon lc-crown')}<span data-balance>${lc(user.balance)}</span></a>
    <a class="avatar-link" href="/profile/" aria-label="Профиль: ${esc(user.name)}">${avatar}</a>`;
}

// ── Плашка бана: нельзя закрыть, исчезает только после разбана или окончания срока ──

const fmtLeft = (ms) => {
  const m = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mm = m % 60;
  return [d ? `${d} дн.` : '', h ? `${h} ч` : '', !d && mm ? `${mm} мин` : ''].filter(Boolean).join(' ');
};
export function renderBan(ban) {
  if (!ban) return;
  const until = ban.until ? new Date(ban.until) : null;
  // Экран блокировки: чёрный, на весь экран, сверху — срок и причина, ниже — окно поддержки
  const build = () => {
    const el = document.createElement('div');
    el.className = 'ban-screen';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'ban-title');
    el.dataset.banBar = '';
    const when = until
      ? `до ${until.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · осталось <b data-ban-left>${fmtLeft(until - Date.now())}</b>`
      : '<b>навсегда</b>';
    el.innerHTML = `
      <div class="ban-box">
        <div class="ban-head">
          <span class="ban-icon" aria-hidden="true">⛔</span>
          <h1 id="ban-title">Аккаунт ${ban.full ? 'полностью ' : ''}заблокирован</h1>
          <p class="ban-when">${when}</p>
          ${ban.reason ? `<p class="ban-reason">Причина: <b>${esc(ban.reason)}</b></p>` : ''}
        </div>
        <section class="ban-support" aria-label="Поддержка">
          <p class="ban-support-title">💬 Поддержка</p>
          ${ban.full
    ? '<p class="ban-closed">Полная блокировка: обращения в поддержку для этого аккаунта не принимаются.</p>'
    : `<div class="ban-chat" data-ban-chat><p class="ban-hint">Если считаешь блокировку ошибкой — напиши здесь. Ответ придёт сюда и в нашего Telegram-бота.</p></div>
          <form class="ban-form" data-ban-form novalidate>
            <textarea name="text" rows="2" maxlength="3500" placeholder="Сообщение в поддержку…" aria-label="Сообщение в поддержку" required></textarea>
            <button type="submit">Отправить</button>
          </form>`}
        </section>
      </div>`;
    document.body.append(el);
    if (!ban.full) setupBanSupport(el);
    return el;
  };
  let screen = build();
  document.documentElement.classList.add('is-banned');
  // Удалили экран (например, через инструменты разработчика) — возвращаем
  new MutationObserver(() => { if (!document.body.contains(screen)) screen = build(); }).observe(document.body, { childList: true });
  if (until) {
    setInterval(() => {
      const left = until - Date.now();
      if (left <= 0) { location.reload(); return; } // срок вышел — бан снимется на сервере сам
      const el = screen.querySelector('[data-ban-left]');
      if (el) el.textContent = fmtLeft(left);
    }, 30_000);
  }
}

// Чат с поддержкой на экране блокировки: история обращения + отправка, обновление раз в 15 секунд
function setupBanSupport(root) {
  const chat = root.querySelector('[data-ban-chat]');
  const form = root.querySelector('[data-ban-form]');
  const hint = chat.innerHTML;
  const load = async () => {
    try {
      const r = await api('/api/support');
      if (!r.messages?.length) return;
      chat.innerHTML = r.messages.map((m) => `<div class="ban-msg ${m.sender === 'admin' ? 'is-admin' : 'is-me'}"><span>${esc(m.text)}</span><time>${new Date(m.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>`).join('');
      chat.scrollTop = chat.scrollHeight;
    } catch { if (!chat.children.length) chat.innerHTML = hint; }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = form.elements.text.value.trim();
    if (!text) { form.elements.text.focus(); return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('/api/support', { method: 'POST', body: { text } });
      form.elements.text.value = '';
      await load();
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  form.elements.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  load();
  setInterval(load, 15_000);
}

// Ежедневная награда готова — значок-подарок внизу экрана, ведёт в профиль
async function dailyBadge(user) {
  if (!user || user.ban || location.pathname.startsWith('/admin') || location.pathname.startsWith('/profile')) return;
  const d = await api('/api/daily').catch(() => null);
  if (!d?.ready) return;
  const a = document.createElement('a');
  a.className = 'daily-badge';
  a.href = '/profile/#vip';
  a.dataset.dailyBadge = '';
  a.innerHTML = `<span aria-hidden="true">🎁</span><span>Забрать ${lc(d.reward)}</span>`;
  document.body.append(a);
}

// Плашка акции на пополнение (включается в админке): «+50% к пополнению · осталось 3 ч 12 мин»
export function renderPromo(cfg) {
  const b = cfg?.payments?.depositBonus;
  if (!b || document.querySelector('[data-promo-bar]')) return;
  const until = b.until ? new Date(b.until) : null;
  if (until && until <= Date.now()) return;
  const bar = document.createElement('a');
  bar.className = 'promo-bar';
  bar.href = '/profile/#wallet';
  bar.dataset.promoBar = '';
  const pct = Math.round(b.percent * 100);
  bar.innerHTML = `<span aria-hidden="true">🔥</span><span><b>${pct >= 100 ? 'x2' : `+${pct}%`} к пополнению</b>${until ? ` · осталось <b data-promo-left>${fmtLeft(until - Date.now())}</b>` : ''}</span><span class="promo-cta">Пополнить →</span>`;
  const anchor = document.querySelector('.live-strip') || document.querySelector('.site-header');
  anchor ? anchor.after(bar) : document.body.prepend(bar);
  if (until) {
    const t = setInterval(() => {
      const left = until - Date.now();
      if (left <= 0) { bar.remove(); clearInterval(t); return; }
      bar.querySelector('[data-promo-left]').textContent = fmtLeft(left);
    }, 30_000);
  }
}

// Обновить баланс в шапке без перезагрузки
export function setBalance(kop) {
  $$('[data-balance]').forEach((el) => { el.textContent = lc(kop); });
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

// Сообщения после неудачного входа (?login=failed)
function loginNotice() {
  const p = new URLSearchParams(location.search);
  const v = p.get('login');
  if (!v) return;
  toast(v === 'banned' ? 'Аккаунт заблокирован. Напиши в поддержку' : 'Не получилось войти через Telegram. Попробуй ещё раз', 'error');
  p.delete('login');
  history.replaceState(null, '', location.pathname + (p.size ? `?${p}` : '') + location.hash);
}

// ── Старт ──────────────────────────────────────────────────

document.documentElement.classList.remove('no-js');
initTheme();
initNav();
initReveal();
loginNotice();
session().then((s) => { renderAuth(s.user); renderBan(s.user?.ban); renderPromo(s.config); dailyBadge(s.user); });
import('./live.js'); // живая лента: онлайн и выигрыши
