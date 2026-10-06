// Доступ к Postgres.
// В продакшене — настоящий Postgres (Neon) по DATABASE_URL.
// Локально и в тестах — PGlite: тот же Postgres, но в памяти процесса (или в папке PGLITE_DIR).
//
// Интерфейс одинаковый:
//   db.query(sql, params) → rows
//   db.one(sql, params)   → первая строка или null
//   db.tx(async (q) => …) — транзакция, q имеет те же query/one

import fs from 'node:fs';
import { config } from './config.js';

const SCHEMA = new URL('../db/schema.sql', import.meta.url);

let dbPromise = null;

const wrap = (run) => ({
  query: async (sql, params = []) => (await run(sql, params)).rows,
  one: async (sql, params = []) => (await run(sql, params)).rows[0] ?? null,
});

async function openPg(url) {
  const { default: pg } = await import('pg');
  // bigint и numeric приходят строками — переводим в числа (копейки помещаются в Number без потерь)
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  return {
    ...wrap((sql, params) => pool.query(sql, params)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(wrap((sql, params) => client.query(sql, params)));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const pglite = new PGlite(dir || undefined, { parsers: { 20: Number, 1700: Number } });
  const db = {
    ...wrap((sql, params) => pglite.query(sql, params)),
    tx: (fn) => pglite.transaction((t) => fn(wrap((sql, params) => t.query(sql, params)))),
    exec: (sql) => pglite.exec(sql),
    close: () => pglite.close(),
  };
  await migrate(db);
  return db;
}

export async function migrate(db) {
  await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
}

export function getDb() {
  if (!dbPromise) {
    dbPromise = config.databaseUrl ? openPg(config.databaseUrl) : openPglite(process.env.PGLITE_DIR);
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

// Для тестов: свежая база в памяти
export async function resetDb() {
  if (dbPromise) (await dbPromise).close?.();
  dbPromise = openPglite(undefined);
  return dbPromise;
}
