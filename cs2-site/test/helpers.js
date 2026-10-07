// Общие помощники тестов: свежая база PGlite в памяти и тестовые данные.
process.env.SESSION_SECRET = 'test-secret';
process.env.DATABASE_URL = '';
process.env.DATA_KEY = '11'.repeat(32);
process.env.SITE_URL = 'http://localhost:3000';
delete process.env.TG_BOT_TOKEN;

const { resetDb } = await import('../lib/db.js');
const { seedDemoItems } = await import('../lib/catalog.js');
const { upsertTelegramUser, changeBalance } = await import('../lib/users.js');
const { updateSettings } = await import('../lib/settings.js');

export async function freshDb() {
  const db = await resetDb();
  await seedDemoItems();
  // Стартовый бонус в тестах выключен, чтобы балансы считались от нуля (сам бонус проверяет test/admin.test.js)
  await updateSettings({ signupBonus: 0 });
  return db;
}

let n = 0;
export async function makeUser(balance = 0) {
  const u = await upsertTelegramUser({ id: 900000 + ++n, first_name: `user${n}` });
  if (balance) {
    const db = await (await import('../lib/db.js')).getDb();
    await db.tx((q) => changeBalance(q, u.id, balance, 'admin', { note: 'test' }));
  }
  return u;
}

export async function balanceOf(userId) {
  const db = await (await import('../lib/db.js')).getDb();
  const u = await db.one('select balance from users where id = $1', [userId]);
  const l = await db.one('select coalesce(sum(amount), 0)::bigint as s from ledger where user_id = $1', [userId]);
  return { balance: u.balance, ledger: l.s };
}
