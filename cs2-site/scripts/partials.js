// Общие куски страниц (шапка, футер, форма заявки) лежат в partials/ в одном экземпляре.
// Скрипт вставляет их во все HTML-страницы между метками:
//   <!-- partial:header --> … <!-- /partial:header -->
// и отмечает текущий пункт меню (aria-current="page"). Сборка на сервере не нужна:
// после правки partials/ запусти `npm run partials` и закоммить результат.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('public');
const PARTIALS = path.resolve('partials');

const partials = Object.fromEntries(
  fs.readdirSync(PARTIALS).filter((f) => f.endsWith('.html')).map((f) => [f.replace('.html', ''), fs.readFileSync(path.join(PARTIALS, f), 'utf8').trim()]),
);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'assets' ? [] : walk(p);
    return e.name.endsWith('.html') ? [p] : [];
  });
}

let changed = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  // URL страницы: public/market/index.html → /market/
  const url = '/' + path.relative(ROOT, file).replace(/index\.html$/, '').replace(/\\/g, '/');
  let out = src.replace(/([ \t]*)<!-- partial:([\w-]+) -->[\s\S]*?<!-- \/partial:\2 -->/g, (all, indent, name) => {
    if (!partials[name]) throw new Error(`${file}: нет partials/${name}.html`);
    let html = partials[name];
    if (name === 'header') {
      html = html.replace(/<a href="([^"]+)">/g, (a, href) => (href === url ? `<a href="${href}" aria-current="page">` : a));
    }
    const body = html.split('\n').map((l) => (l ? indent + l : l)).join('\n');
    return `${indent}<!-- partial:${name} -->\n${body}\n${indent}<!-- /partial:${name} -->`;
  });
  if (out !== src) { fs.writeFileSync(file, out); changed++; }
}
console.log(`Обновлено страниц: ${changed}`);
