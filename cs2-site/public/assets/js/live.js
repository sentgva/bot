// Живая лента над сайтом: честный онлайн, последние выигрыши и скины «Можно выбить». Обновляется раз в 20 секунд,
// пока вкладка открыта и видна. Главная подписывается через onLive() — запрос всё равно один.
import { $, esc, lc, skinImage } from './core.js';

const POLL_MS = 20_000;
const strip = $('[data-live]');
const listeners = new Set();
const seen = new Set();
let last = null;
let timer = null;

export function onLive(cb) {
  listeners.add(cb);
  if (last) cb(last);
}

const card = (item, cls, title) => `<a class="drop${cls}" href="/upgrade/" data-rarity="${esc(item.rarity || '')}" title="${esc(title)}">
      ${skinImage(item, '').replace('<div class="skin-img">', '').replace(/<\/div>$/, '')}
      <span class="drop-text"><span class="drop-name">${esc(item.name)}</span><span class="drop-price">${lc(item.price)}</span></span>
    </a>`;

let signature = '';
function renderDrops(drops, targets = []) {
  const box = $('[data-live-drops]');
  if (!box) return;
  // Перерисовываем, только если состав изменился, — иначе прокрутка дёргалась бы на каждом опросе
  const sig = drops.map((d) => d.id).join(',') + '|' + targets.map((t) => t.hashName).join(',');
  if (sig === signature) return;
  signature = sig;
  if (!drops.length && !targets.length) {
    box.innerHTML = '<p class="live-empty">Здесь появятся выигрыши игроков</p>';
    return;
  }
  const first = seen.size === 0;
  let html = drops.map((d) => card(d.item, !first && !seen.has(d.id) ? ' is-new' : '',
    `Выигрыш: ${d.item.hashName}, шанс ${(d.chance / 10000).toFixed(1).replace('.', ',')}%`)).join('');
  // Настоящих выигрышей мало — добираем реальными скинами каталога и честно подписываем
  if (targets.length) {
    html += '<span class="drop-sep">Можно выбить</span>'
      + targets.map((t) => card(t, ' is-target', `Можно выбить в апгрейдере: ${t.hashName}`)).join('');
  }
  // Бегущая строка: содержимое дважды подряд, вторая копия скрыта от скринридеров
  const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.innerHTML = `<div class="live-track${moving ? ' is-moving' : ''}"><div class="live-set">${html}</div>${moving ? `<div class="live-set" aria-hidden="true" inert>${html}</div>` : ''}</div>`;
  const track = box.firstElementChild;
  // Скорость постоянная (~40 px/с), сколько бы карточек ни было
  track.style.setProperty('--marquee', `${Math.max(20, Math.round(track.firstElementChild.scrollWidth / 40))}s`);
  drops.forEach((d) => seen.add(d.id));
}

// Счётчик плавно докручивается до нового значения
function animateCount(el, to) {
  const from = Number(el.dataset.value || to);
  el.dataset.value = String(to);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to.toLocaleString('ru-RU'); return; }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 900);
    el.textContent = Math.round(from + (to - from) * k).toLocaleString('ru-RU');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Маленький онлайн («1», «2») выглядит пусто — тогда показываем только пульсирующий значок
const ONLINE_MIN = 10;
function renderOnline(n) {
  const el = $('[data-online-count]');
  if (!el) return;
  el.hidden = n < ONLINE_MIN;
  if (!el.hidden) animateCount(el, n);
}

async function poll() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/live', { credentials: 'same-origin', headers: authHeaders() });
    if (res.ok) {
      last = await res.json();
      if (strip) {
        renderOnline(last.online);
        renderDrops(last.drops, last.targets);
      }
      listeners.forEach((cb) => cb(last));
    }
  } catch { /* сеть пропала — попробуем позже */ }
  if (!document.hidden) timer = setTimeout(poll, POLL_MS);
}

// Тот же токен, что у api() (нужен в Telegram Mini App, чтобы онлайн считал игрока, а не IP)
function authHeaders() {
  let token = null;
  try { token = sessionStorage.getItem('ld-token'); } catch { /* нет хранилища */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); else clearTimeout(timer); });
poll();
