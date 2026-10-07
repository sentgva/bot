// Версия скриптов и стилей в адресе: /assets/js/x.js → /assets/v/<хэш>/js/x.js (только при сборке на Vercel).
// Хэш считается по содержимому css/js, поэтому после каждого изменения у файлов новый адрес и браузер
// (в том числе встроенный браузер Telegram) гарантированно скачивает свежую версию, а не берёт старую из кеша.
// Модули импортируют друг друга по относительным путям, так что версия подхватывается и для них.
// Vercel переписывает /assets/v/<хэш>/* обратно на /assets/* (vercel.json → rewrites).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.VERCEL && !process.argv.includes('--force')) {
  console.log('Не Vercel — версии ассетов не проставляем (файлы в репозитории не трогаем)');
  process.exit(0);
}

const ROOT = path.resolve('public');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? files(p) : [p];
});

const hash = crypto.createHash('sha256');
for (const f of [...files(path.join(ROOT, 'assets/css')), ...files(path.join(ROOT, 'assets/js'))].sort()) hash.update(f).update(fs.readFileSync(f));
const version = hash.digest('hex').slice(0, 10);

let changed = 0;
for (const f of files(ROOT).filter((p) => p.endsWith('.html'))) {
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(/(href|src)="\/assets\/(css|js)\//g, `$1="/assets/v/${version}/$2/`);
  if (out !== src) { fs.writeFileSync(f, out); changed++; }
}
console.log(`Версия ассетов ${version}: обновлено страниц ${changed}`);
