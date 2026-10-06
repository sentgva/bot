// Создаёт/обновляет таблицы в базе. На Vercel запускается при сборке (buildCommand в vercel.json).
import { config } from '../lib/config.js';
import { getDb, migrate } from '../lib/db.js';

if (!config.databaseUrl) {
  console.log('DATABASE_URL не задан — миграция пропущена (локально база создаётся сама)');
  process.exit(0);
}
const db = await getDb();
await migrate(db);
console.log('Схема базы обновлена');
await db.close();
