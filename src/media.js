import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InputFile } from 'grammy';

// Картинки из чата. На Vercel — Vercel Blob (публичные ссылки со случайным именем),
// локально — папка data/uploads, отдаётся по /media/...
// В сообщении хранится готовый адрес: 'https://…' или 'media/<файл>'.

const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function openMedia({ blobToken, dataDir }) {
  const name = (ext) => `${crypto.randomBytes(12).toString('hex')}.${ext}`;

  if (blobToken) {
    return {
      async save(buffer, ext) {
        const { put } = await import('@vercel/blob');
        const blob = await put(`chat/${name(ext)}`, buffer, {
          access: 'public',
          contentType: TYPES[ext] || 'application/octet-stream',
          token: blobToken,
          addRandomSuffix: false,
          cacheControlMaxAge: 60 * 60 * 24 * 365,
        });
        return blob.url;
      },
      // Telegram сам скачает фото по ссылке
      forTelegram: (ref) => ref,
    };
  }

  const uploads = path.join(dataDir, 'uploads');
  return {
    uploads,
    async save(buffer, ext) {
      await fs.promises.mkdir(uploads, { recursive: true });
      const file = name(ext);
      await fs.promises.writeFile(path.join(uploads, file), buffer);
      return `media/${file}`;
    },
    forTelegram: (ref) => new InputFile(path.join(uploads, path.basename(ref))),
  };
}
