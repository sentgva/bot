// Ручная синхронизация каталога и цен: npm run prices
// Флаг --meta принудительно обновляет картинки и редкость.
import { syncCatalog } from '../lib/catalog.js';
import { getDb } from '../lib/db.js';

process.env.PGLITE_DIR ??= '.data/pglite';
const result = await syncCatalog({ forceMeta: process.argv.includes('--meta') });
console.log(`Готово: обновлено ${result.updated} скинов${result.meta ? ' (с метаданными)' : ''}`);
await (await getDb()).close();
