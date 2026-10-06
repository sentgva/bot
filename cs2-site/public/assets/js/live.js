// Живая лента над сайтом: честный онлайн и последние выигрыши. Обновляется раз в 20 секунд,
// пока вкладка открыта и видна. Главная подписывается через onLive() — запрос всё равно один.
import { $, esc, rub, skinImage } from './core.js';

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

function renderDrops(drops) {
  const box = $('[data-live-drops]');
  if (!box) return;
  if (!drops.length) {
    box.innerHTML = '<p class="live-empty">Здесь появятся выигрыши игроков</p>';
    return;
  }
  const first = seen.size === 0;
  box.innerHTML = drops.map((d) => {
    const isNew = !first && !seen.has(d.id);
    return `<a class="drop${isNew ? ' is-new' : ''}" href="/upgrade/" data-rarity="${esc(d.item.rarity || '')}"
      title="${esc(d.user)} выиграл ${esc(d.item.hashName)} с шансом ${(d.chance / 10000).toFixed(1).replace('.', ',')}%">
      ${skinImage(d.item, '').replace('<div class="skin-img">', '').replace(/<\/div>$/, '')}
      <span class="drop-text"><span class="drop-name">${esc(d.item.name)}</span><span class="drop-price">${rub(d.item.price)}</span></span>
    </a>`;
  }).join('');
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

async function poll() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/live', { credentials: 'same-origin', headers: authHeaders() });
    if (res.ok) {
      last = await res.json();
      if (strip) {
        animateCount($('[data-online-count]'), last.online);
        renderDrops(last.drops);
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
