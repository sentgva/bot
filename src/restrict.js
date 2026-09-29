// Бан и мут: сроки и тексты, общие для приложения и бота

export const MUTE_FOR = {
  '1h': { ms: 3600e3, label: 'на 1 час' },
  '1d': { ms: 86400e3, label: 'на сутки' },
  '7d': { ms: 7 * 86400e3, label: 'на 7 дней' },
  forever: { ms: 0, label: 'навсегда' },
};

export const muteUntil = (key) => (MUTE_FOR[key].ms ? Date.now() + MUTE_FOR[key].ms : 0);

const msk = (ts) =>
  new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export const BANNED_TEXT = 'Доступ закрыт: писать и оформлять заказы нельзя.';

export const mutedText = (r) =>
  r.mutedUntil ? `Писать в чат можно будет после ${msk(r.mutedUntil)} по Москве.` : 'Писать в чат сейчас нельзя.';

export const restrictLabel = (r) =>
  r.banned ? 'забанен' : r.muted ? (r.mutedUntil ? `мут до ${msk(r.mutedUntil)}` : 'мут навсегда') : '';
