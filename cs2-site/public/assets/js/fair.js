// Страница «Честность»: пересчёт броска в браузере (WebCrypto), параметры можно передать в адресе.
import { $, esc, icon } from './core.js';
import { ROLL_MAX, computeRoll, sha256 } from './fair-core.js';
import { liveValidate } from './forms.js';

const form = $('#verify');
const out = $('[data-out]');

// Ссылка «Проверить» из профиля заполняет форму: ?server=…&client=…&nonce=…&chance=ppm
const p = new URLSearchParams(location.search);
if (p.get('server')) form.elements.server.value = p.get('server');
if (p.get('client')) form.elements.client.value = p.get('client');
if (p.get('nonce')) form.elements.nonce.value = p.get('nonce');
if (p.get('chance')) form.elements.chance.value = String(Number(p.get('chance')) / 10000);

const v = liveValidate(form, {
  server: (val) => (val.trim() ? '' : 'Вставь раскрытый серверный сид'),
  client: (val) => (val.trim() ? '' : 'Вставь клиентский сид'),
  nonce: (val) => (/^\d+$/.test(val) ? '' : 'Целое число от 0'),
});

async function verify() {
  const server = form.elements.server.value.trim();
  const client = form.elements.client.value.trim();
  const nonce = Number(form.elements.nonce.value);
  const chance = Number(form.elements.chance.value);
  const [roll, hash] = await Promise.all([computeRoll(server, client, nonce), sha256(server)]);
  const verdict = chance > 0
    ? (roll < Math.floor((chance / 100) * ROLL_MAX)
      ? `<span class="badge badge-success">${icon('i-circle-check', 'icon icon-sm')}Победа: бросок меньше ${Math.floor((chance / 100) * ROLL_MAX).toLocaleString('ru-RU')}</span>`
      : `<span class="badge">${icon('i-circle-x', 'icon icon-sm')}Мимо: бросок не меньше ${Math.floor((chance / 100) * ROLL_MAX).toLocaleString('ru-RU')}</span>`)
    : '';
  out.innerHTML = `
    <div class="summary">
      <div><span>Бросок</span><b class="num">${roll.toLocaleString('ru-RU')}</b></div>
      <div><span>Из</span><span class="num">1 000 000</span></div>
    </div>
    <p class="row mt-3">${verdict}</p>
    <p class="small muted mt-3">SHA-256 серверного сида — сравни с хэшем, который видел до броска:</p>
    <p class="mono small">${esc(hash)}</p>`;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (v.validateAll()) verify();
});
if (p.get('server')) verify();
