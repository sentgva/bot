// Локальный сервер: статика из public/ + API, как на Vercel.
// Без DATABASE_URL база — PGlite в папке .data (переживает перезапуск).
//   npm run dev  →  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.PGLITE_DIR ??= path.resolve('.data/pglite');
process.env.DEMO_TOPUP ??= '1';
process.env.DEV_LOGIN ??= '1';
// Локальный ключ шифрования карт, чтобы был виден вывод на карту. В продакшене задаётся свой DATA_KEY
process.env.DATA_KEY ??= '00'.repeat(32);

const { handler } = await import('../lib/app.js');
const { seedDemoItems, syncCatalog } = await import('../lib/catalog.js');
const { getDb } = await import('../lib/db.js');

const ROOT = path.resolve('public');
// Те же заголовки безопасности, что на Vercel, — чтобы нарушения CSP были видны локально
const SECURITY = Object.fromEntries(
  JSON.parse(fs.readFileSync('vercel.json', 'utf8')).headers.find((h) => h.source === '/(.*)').headers
    .filter((h) => !['Strict-Transport-Security'].includes(h.key))
    .map((h) => [h.key, h.key === 'Content-Security-Policy' ? h.value.replace('; upgrade-insecure-requests', '') : h.value]),
);
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  let file = path.join(ROOT, decodeURIComponent(pathname));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) { res.writeHead(308, { Location: pathname + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  let status = 200;
  if (!fs.existsSync(file)) { file = path.join(ROOT, '404.html'); status = 404; }
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  // Сжатие текстовых файлов, как на Vercel (чтобы замеры скорости локально были честными)
  const br = /br/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg|xml/.test(type);
  res.writeHead(status, { 'Content-Type': type, ...(br && { 'Content-Encoding': 'br', Vary: 'Accept-Encoding' }) });
  const stream = fs.createReadStream(file).on('error', () => res.end());
  (br ? stream.pipe(zlib.createBrotliCompress()) : stream).pipe(res);
}

http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  if (req.url.startsWith('/api/')) return handler(req, res);
  serveStatic(req, res);
}).listen(PORT, async () => {
  console.log(`LuxeDrop: http://localhost:${PORT}`);
  // Каталог: пробуем настоящие цены, без интернета — демо-набор
  await getDb();
  const seeded = await seedDemoItems();
  if (seeded) {
    console.log(`Каталог: загружено ${seeded} демо-скинов. Настоящие цены: npm run prices`);
  }
  if (process.env.SYNC_PRICES === '1') {
    syncCatalog().then((r) => console.log('Цены обновлены:', r)).catch((e) => console.warn('Цены не обновились:', e.message));
  }
});
