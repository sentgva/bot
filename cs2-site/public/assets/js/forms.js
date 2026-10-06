// Формы: правила проверки (те же, что на сервере в lib/validate.js), маски и ошибки на лету.

import { esc, icon } from './core.js';

export const TRADE_URL = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d{1,10}&token=[\w-]{8}$/;

export function phoneDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d && !d.startsWith('7')) d = '7' + d;
  return d.slice(0, 11);
}
export const isPhone = (v) => /^79\d{9}$/.test(phoneDigits(v));

export function formatPhone(v) {
  const d = phoneDigits(v);
  if (!d) return '';
  const p = d.slice(1);
  let out = '+7';
  if (p.length) out += ` (${p.slice(0, 3)}`;
  if (p.length >= 3) out += ')';
  if (p.length > 3) out += ` ${p.slice(3, 6)}`;
  if (p.length > 6) out += `-${p.slice(6, 8)}`;
  if (p.length > 8) out += `-${p.slice(8, 10)}`;
  return out;
}

export function isCard(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 16 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
export const formatCard = (v) => String(v || '').replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');

export const maskPhone = (input) => input.addEventListener('input', () => { input.value = formatPhone(input.value); });
export const maskCard = (input) => input.addEventListener('input', () => { input.value = formatCard(input.value); });

// ── Проверка полей на лету ─────────────────────────────────
// rules: { имяПоля: (значение, форма) => текст ошибки или '' }

export function liveValidate(form, rules) {
  const fieldOf = (name) => form.elements[name];
  const errorEl = (el) => form.querySelector(`#${(el.id || el[0]?.name)}-error`);

  function check(name, touch = false) {
    const el = fieldOf(name);
    if (!el) return true;
    const first = el instanceof RadioNodeList ? el[0] : el;
    const value = el instanceof RadioNodeList ? el.value : el.type === 'checkbox' ? el.checked : el.value;
    const msg = rules[name](value, form) || '';
    if (touch) first.classList.add('touched');
    const show = first.classList.contains('touched');
    const target = el instanceof RadioNodeList ? [...el] : [el];
    target.forEach((t) => t.setAttribute('aria-invalid', String(Boolean(msg) && show)));
    const err = errorEl(first);
    if (err) err.innerHTML = msg && show ? `${icon('i-circle-alert', 'icon icon-sm')}<span>${esc(msg)}</span>` : '';
    return !msg;
  }

  for (const name of Object.keys(rules)) {
    const el = fieldOf(name);
    if (!el) continue;
    const list = el instanceof RadioNodeList ? [...el] : [el];
    list.forEach((node) => {
      node.addEventListener('blur', () => check(name, node.type !== 'radio' && node.value !== ''));
      node.addEventListener('input', () => check(name, node.type === 'radio' || node.type === 'checkbox'));
      node.addEventListener('change', () => check(name, true));
    });
  }

  return {
    // Проверить всё перед отправкой; фокус на первое поле с ошибкой
    validateAll() {
      let firstBad = null;
      for (const name of Object.keys(rules)) {
        if (!check(name, true) && !firstBad) firstBad = name;
      }
      if (firstBad) {
        const el = fieldOf(firstBad);
        (el instanceof RadioNodeList ? el[0] : el).focus();
      }
      return !firstBad;
    },
    // Ошибка с сервера к конкретному полю
    setServerError(name, message) {
      const el = fieldOf(name);
      if (!el) return false;
      const first = el instanceof RadioNodeList ? el[0] : el;
      first.classList.add('touched');
      first.setAttribute('aria-invalid', 'true');
      const err = errorEl(first);
      if (err) err.innerHTML = `${icon('i-circle-alert', 'icon icon-sm')}<span>${esc(message)}</span>`;
      first.focus();
      return true;
    },
  };
}
