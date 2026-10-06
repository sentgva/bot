import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLL_MAX, chancePpm, computeRoll, hashSeed, isValidClientSeed } from '../lib/fair.js';
import * as browserFair from '../public/assets/js/fair-core.js';

test('бросок детерминирован и в диапазоне', () => {
  const a = computeRoll('server', 'client', 0);
  assert.equal(a, computeRoll('server', 'client', 0));
  assert.notEqual(a, computeRoll('server', 'client', 1));
  for (let i = 0; i < 1000; i++) {
    const r = computeRoll('s' + i, 'c', i);
    assert.ok(r >= 0 && r < ROLL_MAX);
  }
});

test('распределение бросков примерно равномерное', () => {
  const N = 20000;
  let below = 0;
  for (let i = 0; i < N; i++) if (computeRoll('seed', 'c', i) < ROLL_MAX * 0.3) below++;
  assert.ok(Math.abs(below / N - 0.3) < 0.02, `доля ${below / N}`);
});

test('проверка в браузере (WebCrypto) даёт тот же результат, что и сервер', async () => {
  for (let i = 0; i < 20; i++) {
    const seed = 'abc' + i;
    assert.equal(await browserFair.computeRoll(seed, 'player', i), computeRoll(seed, 'player', i));
    assert.equal(await browserFair.sha256(seed), hashSeed(seed));
  }
});

test('шанс: формула и ограничение', () => {
  const s = { houseEdge: 0.05, maxChance: 0.8 };
  assert.equal(chancePpm(100, 200, s), 475000); // ×2 → 47.5%
  assert.equal(chancePpm(100, 1000, s), 95000); // ×10 → 9.5%
  assert.equal(chancePpm(100, 100, s), 800000); // не больше 80%
  assert.equal(chancePpm(0, 100, s), 0);
});

test('клиентский сид', () => {
  assert.ok(isValidClientSeed('my_seed-1'));
  assert.ok(!isValidClientSeed(''));
  assert.ok(!isValidClientSeed('a'.repeat(33)));
  assert.ok(!isValidClientSeed('пробел есть'));
});
