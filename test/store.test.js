import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

// Одни и те же команды должны давать одинаковый ответ в памяти и в Postgres.
// Postgres проверяется, если задан TEST_DATABASE_URL.
const stores = [['memory', openStore()]];
if (process.env.TEST_DATABASE_URL) stores.push(['postgres', openStore({ postgresUrl: process.env.TEST_DATABASE_URL })]);

for (const [name, store] of stores) {
  test(`хранилище ${name}: команды ведут себя как в Redis`, async () => {
    const p = `test:${Date.now()}:${Math.random().toString(36).slice(2)}:`;
    const long = JSON.stringify({ text: 'я'.repeat(3500) });

    assert.equal(await store.cmd('GET', `${p}s`), null);
    assert.equal(await store.cmd('SET', `${p}s`, 'x', 'EX', 60), 'OK');
    assert.equal(await store.cmd('GET', `${p}s`), 'x');
    assert.equal(await store.cmd('EXISTS', `${p}s`), 1);
    assert.equal(await store.cmd('INCR', `${p}n`), 1);
    assert.equal(await store.cmd('INCR', `${p}n`), 2);
    assert.equal(await store.cmd('DECRBY', `${p}n`, 1), 1);

    await store.cmd('HSET', `${p}h`, 'a', '1', 'b', '2');
    assert.equal(await store.cmd('HGET', `${p}h`, 'a'), '1');
    assert.equal(await store.cmd('HINCRBY', `${p}h`, 'a', 5), 6);
    assert.deepEqual((await store.cmd('HMGET', `${p}h`, 'b', 'zz', 'a')), ['2', null, '6']);
    const all = await store.cmd('HGETALL', `${p}h`);
    assert.deepEqual(Object.fromEntries([[all[0], all[1]], [all[2], all[3]]]), { a: '6', b: '2' });
    assert.deepEqual((await store.cmd('HVALS', `${p}h`)).sort(), ['2', '6']);
    assert.deepEqual((await store.cmd('HKEYS', `${p}h`)).sort(), ['a', 'b']);

    await store.cmd('SET', `${p}del`, '1');
    assert.equal(await store.cmd('DEL', `${p}del`, `${p}nope`), 1);
    assert.equal(await store.cmd('GET', `${p}del`), null);

    const [, , third] = await store.pipe([
      ['ZADD', `${p}z`, 3, 'c'],
      ['ZADD', `${p}z`, 1, long],
      ['ZADD', `${p}z`, 2, 'b'],
    ]);
    assert.equal(third, 1);
    assert.deepEqual(await store.cmd('ZRANGEBYSCORE', `${p}z`, '(1', '+inf'), ['b', 'c']);
    assert.deepEqual(await store.cmd('ZRANGEBYSCORE', `${p}z`, '(0', '+inf'), [long, 'b', 'c']);

    await store.cmd('RPUSH', `${p}l`, 'x', 'y');
    await store.cmd('RPUSH', `${p}l`, 'z');
    assert.deepEqual(await store.cmd('LRANGE', `${p}l`, 0, -1), ['x', 'y', 'z']);
    assert.deepEqual(await store.cmd('LRANGE', `${p}l`, -1, -1), ['z']);

    await store.cmd('SADD', `${p}set`, '5', '7', '5');
    assert.deepEqual((await store.cmd('SMEMBERS', `${p}set`)).sort(), ['5', '7']);

    assert.equal(await store.cmd('EXPIRE', `${p}n`, 1), 1);
    assert.equal(await store.cmd('EXPIRE', `${p}missing`, 1), 0);
  });
}
