// Главная: калькулятор шанса, живые цифры, витрина маркета, лучший дроп, вход через Telegram.
import { $, api, pct, lc, session, skinCard, skinImage } from './core.js';
import { onLive } from './live.js';
import { caseCard, paint } from './case-art.js';

const pctText = (x, digits = 1) => `${(x * 100).toFixed(digits).replace('.', ',').replace(/,0$/, '')}%`;

// ── Калькулятор ────────────────────────────────────────────
let edge = 0.05;
let maxChance = 0.8;
const calc = $('#calc');
function updateCalc() {
  const amount = Math.max(0, Number(calc.elements.amount.value) || 0);
  const mult = Number(calc.elements.mult.value) || 2;
  const chance = Math.min(maxChance, (1 / mult) * (1 - edge));
  $('[data-calc="chance"]').textContent = pctText(chance);
  $('[data-calc="target"]').textContent = lc(Math.floor(amount * mult) * 100);
}
calc?.addEventListener('input', updateCalc);
calc?.addEventListener('submit', (e) => e.preventDefault());

// ── Живые цифры (только реальные данные из базы и текущие настройки) ──
api('/api/stats').then((s) => {
  edge = 0.05;
  maxChance = s.maxChance;
  $('[data-stat="maxChance"]').textContent = `до ${pctText(s.maxChance, 0)}`;
  $('[data-stat="cryptoFee"]').textContent = pctText(s.cryptoFee, 0);
  $('[data-stat="minWithdraw"]').textContent = lc(s.minWithdraw);
  if (s.paid) {
    // Когда выплат достаточно — показываем, сколько реально выплачено
    $('[data-stat="sell"]').textContent = lc(s.paid).replace(/,\d+/, '');
    $('[data-stat-label="sell"]').textContent = 'уже выплачено игрокам';
    $('[data-paid-title]').textContent = `${lc(s.paid).replace(/,\d+/, '')} уже выплачено игрокам`;
  } else {
    $('[data-stat="sell"]').textContent = pctText(s.siteSellRate, 0);
  }
  updateCalc();
}).catch(() => { /* оставляем значения из разметки */ });

session().then(({ user, config }) => {
  if (config) { edge = config.upgrade.houseEdge; maxChance = config.upgrade.maxChance; updateCalc(); }
  // Курс звёзд из настроек сервера: 250 ⭐ → сколько LC (вниз до целого)
  const rate = config?.payments?.stars?.lcPerStar;
  if (rate) {
    $('[data-lc-rate]').textContent = String(rate).replace('.', ',');
    $('[data-lc-example]').textContent = Math.floor(250 * rate).toLocaleString('ru-RU');
  }
  // Кнопка «Открыть в боте» — ссылка на нашего бота из настроек сервера
  const bot = $('[data-cta-bot]');
  if (config?.auth?.botUsername) bot.href = `https://t.me/${config.auth.botUsername}`;
  else bot.hidden = true;
  if (user) { const login = $('[data-cta-login]'); login.href = '/upgrade/'; login.lastElementChild.textContent = 'Открыть апгрейдер'; }
  // Вошедшему не нужно «Войти» — ведём сразу в апгрейдер
  const primary = $('[data-hero-primary]');
  if (user && primary) {
    primary.href = '/upgrade/';
    primary.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-trending-up"/></svg><span>Открыть апгрейдер</span>';
  }
});


// ── Лучший дроп ────────────────────────────────────────────
onLive(({ best }) => {
  const card = $('[data-best]');
  if (!card || !best) return;
  const { item } = best;
  card.classList.remove('best-skeleton');
  card.removeAttribute('aria-busy');
  card.dataset.rarity = item.rarity || 'gold';
  $('[data-best-img]').innerHTML = skinImage(item, item.hashName).replace('<div class="skin-img">', '').replace(/<\/div>$/, '');
  $('[data-best-name]').textContent = item.hashName;
  $('[data-best-price]').textContent = lc(item.price);
  if (best.type === 'win') {
    $('[data-best-label]').textContent = 'Лучший дроп недели';
    $('[data-best-meta]').textContent = `${best.user} · шанс ${pct(best.chance)} · ставка ${lc(best.inputValue)}`;
  } else {
    $('[data-best-label]').textContent = 'Главный приз';
    $('[data-best-meta]').textContent = `Можно выбить со ставки от ${lc(best.minStake)}`;
  }
});

// ── Кейсы: по одному из каждой ценовой ступени ─────────────
api('/api/cases').then((list) => {
  if (!list.length) return;
  const pick = ['kilowatt', 'dreams', 'prisma2', 'knife', 'luxe'].map((slug) => list.find((c) => c.slug === slug)).filter(Boolean);
  const box = $('[data-home-cases-grid]');
  box.innerHTML = (pick.length >= 3 ? pick : list.slice(0, 5)).map(caseCard).join('');
  paint(box);
  $('[data-home-cases]').hidden = false;
}).catch(() => {});
