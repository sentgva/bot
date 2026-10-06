// Режим Telegram Mini App. Загружается из core.js, только когда сайт открыт из бота.
//   • вход по подписанным данным Telegram (initData) — без Steam и паролей;
//   • тема и цвета Telegram, без меню и футера сайта, вкладки внизу;
//   • кнопка «Апгрейдить» — нативная MainButton, вибрация на результат броска;
//   • «Назад» — кнопка Telegram, внешние ссылки открываются средствами Telegram.
import { $, $$, api, icon, setToken } from './core.js';

const SDK = 'https://telegram.org/js/telegram-web-app.js';
const BG = { dark: '#0a0906', light: '#f8f4ea' }; // совпадает с --bg в main.css
const ACCENT = { dark: '#e2b13c', light: '#c99a2e' };

let tg = null;

function loadSdk() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Telegram SDK не загрузился'));
    document.head.append(s);
  });
}

// Войти по данным запуска. Возвращает true, если получилось.
export async function login() {
  if (!tg?.initData) return false;
  try {
    const r = await api('/api/auth/telegram', { method: 'POST', body: { initData: tg.initData } });
    setToken(r.token);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export async function init() {
  if (!window.Telegram?.WebApp) await loadSdk();
  tg = window.Telegram?.WebApp;
  if (!tg?.initData) return; // открыто не из Telegram — обычный сайт

  const root = document.documentElement;
  root.classList.add('tg');
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast?.('7.7')) tg.disableVerticalSwipes(); // свайп по спискам скинов не закрывает приложение

  applyTheme();
  tg.onEvent('themeChanged', applyTheme);

  const ready = document.readyState === 'loading' ? new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true })) : Promise.resolve();
  ready.then(() => { renderTabs(); setupBackButton(); setupMainButton(); setupHaptics(); setupLinks(); });

  // Свежий запуск из бота — всегда входим заново: так подтягиваются имя и аватар
  if (/tgWebAppData=/.test(location.hash) || !sessionStorageToken()) await login();
}

function sessionStorageToken() {
  try { return sessionStorage.getItem('ld-token'); } catch { return null; }
}

// Тема Telegram → тема сайта, цвета шапки Telegram → наш фон
function applyTheme() {
  const scheme = tg.colorScheme === 'light' ? 'light' : 'dark';
  if (scheme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme; // тёмная — основная тема сайта
  try {
    tg.setHeaderColor(BG[scheme]);
    tg.setBackgroundColor(BG[scheme]);
    if (tg.isVersionAtLeast?.('7.10')) tg.setBottomBarColor(BG[scheme]);
  } catch { /* старые версии Telegram */ }
  tg.MainButton?.setParams({ color: ACCENT[scheme], text_color: '#1a1203' });
}

// Вкладки внизу экрана вместо меню сайта
function renderTabs() {
  const here = location.pathname;
  const tabs = [
    ['/upgrade/', 'i-trending-up', 'Апгрейд'],
    ['/market/', 'i-shopping-cart', 'Маркет'],
    ['/profile/', 'i-wallet', 'Профиль'],
  ];
  const nav = document.createElement('nav');
  nav.className = 'tg-tabs';
  nav.setAttribute('aria-label', 'Разделы');
  nav.innerHTML = tabs.map(([href, ico, label]) =>
    `<a href="${href}"${here.startsWith(href) ? ' aria-current="page"' : ''}>${icon(ico)}<span>${label}</span></a>`).join('');
  document.body.append(nav);
}

function setupBackButton() {
  const home = location.pathname.startsWith('/upgrade/');
  if (home) { tg.BackButton.hide(); return; }
  tg.BackButton.show();
  tg.BackButton.onClick(() => { if (history.length > 1) history.back(); else location.href = '/upgrade/'; });
}

// На странице апгрейдера кнопка «Апгрейдить» — нативная кнопка Telegram внизу
function setupMainButton() {
  const go = $('[data-go]');
  const chance = $('[data-chance]');
  if (!go || !chance) { tg.MainButton.hide(); return; }
  const sync = () => {
    if (go.getAttribute('aria-busy') === 'true') { tg.MainButton.showProgress(false); return; }
    tg.MainButton.hideProgress();
    if (go.disabled) { tg.MainButton.hide(); return; }
    tg.MainButton.setText(`Апгрейдить · ${chance.textContent}`);
    tg.MainButton.enable();
    tg.MainButton.show();
  };
  tg.MainButton.onClick(() => { if (!go.disabled) go.click(); });
  new MutationObserver(sync).observe(go, { attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
  new MutationObserver(sync).observe(chance, { childList: true, characterData: true, subtree: true });
  sync();
}

// Вибрация: выбор скина и результат броска
function setupHaptics() {
  const h = tg.HapticFeedback;
  if (!h) return;
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-owned], [data-target], [data-asset], .chip')) h.selectionChanged();
  });
  const result = $('[data-result]');
  if (result) {
    new MutationObserver(() => {
      if ($('.ring-result.win', result)) h.notificationOccurred('success');
      else if ($('.ring-result.lose', result)) h.notificationOccurred('error');
    }).observe(result, { childList: true });
  }
}

// Ссылки на другие сайты и t.me — средствами Telegram, иначе они откроются внутри приложения
function setupLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.origin === location.origin) return;
    e.preventDefault();
    if (url.hostname === 't.me') tg.openTelegramLink(url.href);
    else tg.openLink(url.href);
  }, true);
  // Вход через Steam внутри Telegram не нужен — аккаунт уже есть
  $$('a[href^="/api/auth/steam"]').forEach((a) => { a.hidden = true; });
}
