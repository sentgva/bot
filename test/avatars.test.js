import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOT_TOKEN ||= '123456:TEST_TOKEN';
const { openStore } = await import('../src/store.js');
const { openDb } = await import('../src/db.js');
const { createAvatars } = await import('../src/avatars.js');

const until = async (check) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(await check(), 'не дождались');
};

test('аватарка из Telegram: скачивается, кэшируется на сутки, не затирается профилем', async () => {
  const db = openDb(openStore());
  const calls = [];
  const api = {
    getUserProfilePhotos: async (id) => {
      calls.push(id);
      return id === 2 ? { total_count: 0, photos: [] } : { total_count: 1, photos: [[{ file_id: 'small', file_unique_id: 'u1' }, { file_id: 'big' }]] };
    },
  };
  const downloads = [];
  const avatars = createAvatars(db, api, async (fileId) => (downloads.push(fileId), 'media/ava.jpg'));

  avatars.touch(await db.upsertUser({ id: 1, first_name: 'Ann' }));
  await until(async () => (await db.getUser(1)).photoAt);
  assert.equal((await db.getUser(1)).photo, 'media/ava.jpg');
  assert.deepEqual(downloads, ['small'], 'берём маленький вариант');

  // профиль обновился из Telegram — аватарка на месте, повторно в тот же день не спрашиваем
  const again = await db.upsertUser({ id: 1, first_name: 'Anna', username: 'anna' });
  assert.equal(again.photo, 'media/ava.jpg');
  assert.equal(again.firstName, 'Anna');
  avatars.touch(again);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1);

  // фото скрыто настройками приватности — остаются инициалы, но проверка запомнена
  avatars.touch(await db.upsertUser({ id: 2, first_name: 'Hidden' }));
  await until(async () => (await db.getUser(2)).photoAt);
  assert.equal((await db.getUser(2)).photo, null);
});

test('аватарка: то же фото не качаем заново, ошибка Telegram не ломает бота', async () => {
  const db = openDb(openStore());
  await db.upsertUser({ id: 5, first_name: 'Bob' });
  await db.updateUser(5, { photo: 'media/old.jpg', photoId: 'same', photoAt: 1 });
  let downloads = 0;
  const avatars = createAvatars(db, { getUserProfilePhotos: async () => ({ photos: [[{ file_id: 'f', file_unique_id: 'same' }]] }) }, async () => (downloads++, 'media/new.jpg'));
  avatars.touch(await db.getUser(5));
  await until(async () => (await db.getUser(5)).photoAt > 1);
  assert.equal(downloads, 0);
  assert.equal((await db.getUser(5)).photo, 'media/old.jpg');

  await db.upsertUser({ id: 6, first_name: 'Err' });
  const broken = createAvatars(db, { getUserProfilePhotos: async () => { throw new Error('boom'); } }, async () => 'x');
  broken.touch(await db.getUser(6));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await db.getUser(6)).photo, undefined);
});
