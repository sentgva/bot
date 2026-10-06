// Проверка пользовательских данных. Те же правила продублированы на фронтенде (assets/js/forms.js)
// для подсказок на лету, но решает всегда сервер.

const TRADE_URL = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d{1,10})&token=([\w-]{8})$/;

export function parseTradeUrl(url) {
  const m = typeof url === 'string' ? url.trim().match(TRADE_URL) : null;
  return m ? { url: url.trim(), partner: m[1], token: m[2] } : null;
}

// +7 (999) 123-45-67 → +79991234567
export function normalizePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  const d = digits.length === 11 && (digits[0] === '7' || digits[0] === '8') ? '7' + digits.slice(1) : digits.length === 10 ? '7' + digits : '';
  return /^79\d{9}$/.test(d) ? '+' + d : null;
}

export function normalizeTelegram(v) {
  const s = String(v || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  return /^[a-zA-Z][\w]{4,31}$/.test(s) ? '@' + s : null;
}

// Номер карты: 16–19 цифр и контрольная сумма Луна
export function normalizeCard(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 16 || d.length > 19) return null;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0 ? d : null;
}

export const maskCard = (d) => `${d.slice(0, 4)} •••• •••• ${d.slice(-4)}`;

// Рубли из формы («1 500,50») → копейки
export function rublesToKop(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
}
