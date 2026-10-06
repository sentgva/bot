// Проверка честности в браузере — тот же алгоритм, что на сервере (lib/fair.js), но через WebCrypto.
// Работает и в Node (тест test/fair.test.js сверяет результаты).

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const ROLL_MAX = 1_000_000;

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function computeRoll(serverSeed, clientSeed, nonce) {
  const key = await crypto.subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${clientSeed}:${nonce}`)));
  return Math.floor((parseInt(sig.slice(0, 8), 16) / 2 ** 32) * ROLL_MAX);
}
