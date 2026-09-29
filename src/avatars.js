import { waitUntil } from '@vercel/functions';

// Аватарки покупателей из Telegram: берём фото профиля через Bot API, кладём в наше хранилище
// (Vercel Blob или data/uploads) и показываем админу. Проверяем раз в сутки на пользователя.
// Если человек скрыл фото настройками приватности, остаются инициалы.

const DAY = 24 * 3600e3;

export function createAvatars(db, api, download) {
  const inflight = new Map();

  const stale = (user) => Boolean(user) && (!user.photoAt || Date.now() - user.photoAt > DAY);

  async function refresh(userId) {
    const user = await db.getUser(userId);
    if (!stale(user)) return;
    const { photos } = await api.getUserProfilePhotos(userId, { limit: 1 });
    const size = photos[0]?.[0]; // самый маленький вариант, 160×160
    if (!size) return db.updateUser(userId, { photo: null, photoId: null, photoAt: Date.now() });
    if (size.file_unique_id === user.photoId && user.photo) return db.updateUser(userId, { photoAt: Date.now() });
    const photo = await download(size.file_id);
    await db.updateUser(userId, { photo, photoId: size.file_unique_id, photoAt: Date.now() });
  }

  return {
    stale,
    // В фоне и не чаще одного запроса на человека одновременно; ответ пользователю не ждёт
    touch(user) {
      if (!stale(user) || inflight.has(user.id)) return;
      const job = refresh(user.id)
        .catch((err) => console.warn('[avatar]', user.id, err.description || err.message))
        .finally(() => inflight.delete(user.id));
      inflight.set(user.id, job);
      waitUntil(job);
    },
  };
}
