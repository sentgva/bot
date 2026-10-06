// Provably fair: результат апгрейда определяется заранее зафиксированным серверным сидом.
//
//   1. Сервер генерирует server_seed и показывает игроку только его SHA-256 хэш.
//   2. Игрок задаёт свой client_seed (или оставляет случайный).
//   3. Бросок: HMAC-SHA256(server_seed, `${client_seed}:${nonce}`), первые 8 hex-символов → число 0…2³²−1,
//      масштабируем к 0…999 999. Победа, если бросок < шанс × 1 000 000.
//   4. Когда игрок меняет сид, старый server_seed раскрывается — любой бросок можно пересчитать
//      на странице /fair/ (тот же алгоритм в public/assets/js/fair-core.js).

import crypto from 'node:crypto';

export const ROLL_MAX = 1_000_000;

export const newServerSeed = () => crypto.randomBytes(32).toString('hex');
export const newClientSeed = () => crypto.randomBytes(8).toString('hex');
export const hashSeed = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

export function computeRoll(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return Math.floor((parseInt(hmac.slice(0, 8), 16) / 2 ** 32) * ROLL_MAX);
}

// Шанс в миллионных долях: вход / цель × (1 − край), с ограничением сверху
export function chancePpm(inputValue, targetPrice, { houseEdge, maxChance }) {
  if (!(inputValue > 0) || !(targetPrice > 0)) return 0;
  const raw = (inputValue / targetPrice) * (1 - houseEdge);
  return Math.floor(Math.min(raw, maxChance) * ROLL_MAX);
}

export const isValidClientSeed = (s) => typeof s === 'string' && /^[\w-]{1,32}$/.test(s);
