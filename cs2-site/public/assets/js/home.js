// Главная: калькулятор шанса, живые цифры, форма заявки, CTA для вошедших.
import { $, api, rub, session } from './core.js';
import { initSellForm } from './forms.js';

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
  $('[data-calc="target"]').textContent = rub(Math.round(amount * mult * 100));
}
calc?.addEventListener('input', updateCalc);
calc?.addEventListener('submit', (e) => e.preventDefault());

// ── Живые цифры (только реальные данные из базы и текущие настройки) ──
api('/api/stats').then((s) => {
  edge = 0.05;
  maxChance = s.maxChance;
  $('[data-stat="maxChance"]').textContent = `до ${pctText(s.maxChance, 0)}`;
  $('[data-stat="cryptoFee"]').textContent = pctText(s.cryptoFee, 0);
  $('[data-stat="minWithdraw"]').textContent = rub(s.minWithdraw);
  if (s.paid) {
    // Когда выплат достаточно — показываем, сколько реально выплачено
    $('[data-stat="buyback"]').textContent = rub(s.paid).replace(/,\d+/, '');
    $('[data-stat-label="buyback"]').textContent = 'уже выплачено игрокам';
    $('[data-paid-title]').textContent = `${rub(s.paid).replace(/,\d+/, '')} уже выплачено игрокам`;
  } else {
    $('[data-stat="buyback"]').textContent = pctText(s.buybackRate, 0);
  }
  updateCalc();
}).catch(() => { /* оставляем значения из разметки */ });

session().then(({ user, config }) => {
  if (config) { edge = config.upgrade.houseEdge; maxChance = config.upgrade.maxChance; updateCalc(); }
  // Вошедшему не нужно «Войти через Steam» — ведём сразу в апгрейдер
  const primary = $('[data-hero-primary]');
  if (user && primary) {
    primary.href = '/upgrade/';
    primary.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-trending-up"/></svg><span>Открыть апгрейдер</span>';
  }
});

initSellForm($('#sell-form'));
