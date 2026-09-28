import fs from 'node:fs';
import path from 'node:path';

// Хранилища с одним интерфейсом в духе Redis: cmd('HSET', ...) и pipe([[...], [...]]).
//   postgres — Neon (подключается в Vercel → Storage), команды переводятся в SQL;
//   redis    — Upstash по REST;
//   memory   — локально, в памяти с сохранением в JSON-файл.

export function openStore({ postgresUrl, redisUrl, redisToken, file } = {}) {
  if (postgresUrl) return postgresStore(postgresUrl);
  if (redisUrl) return redisStore(redisUrl, redisToken);
  return memoryStore(file);
}

// Все данные в одной таблице: ключ, поле (для хэшей, множеств, списков), значение, score, срок жизни
const SCHEMA = [
  `create table if not exists kv (
    k text not null,
    f text not null default '',
    v text,
    score double precision,
    seq bigserial,
    exp timestamptz,
    primary key (k, f)
  )`,
  'create index if not exists kv_score on kv (k, score)',
  'delete from kv where exp < now()',
];

const LIVE = '(exp is null or exp > now())';

// Перевод команды в SQL: { text, params, map(rows) -> ответ как у Redis }
const SQL = {
  GET: (k) => ({
    text: `select v from kv where k = $1 and f = '' and ${LIVE}`,
    params: [k],
    map: (r) => r[0]?.v ?? null,
  }),
  SET(k, v, ...opts) {
    const i = opts.findIndex((o) => String(o).toUpperCase() === 'EX');
    return {
      text: `insert into kv (k, f, v, exp) values ($1, '', $2, case when $3::int is null then null else now() + make_interval(secs => $3::int) end)
             on conflict (k, f) do update set v = excluded.v, exp = excluded.exp`,
      params: [k, v, i >= 0 ? Number(opts[i + 1]) : null],
      map: () => 'OK',
    };
  },
  EXISTS: (k) => ({
    text: `select exists(select 1 from kv where k = $1 and ${LIVE}) as e`,
    params: [k],
    map: (r) => (r[0].e ? 1 : 0),
  }),
  EXPIRE: (k, sec) => ({
    text: 'update kv set exp = now() + make_interval(secs => $2::int) where k = $1 returning 1',
    params: [k, Number(sec)],
    map: (r) => (r.length ? 1 : 0),
  }),
  INCRBY: (k, n) => ({
    text: `insert into kv (k, f, v) values ($1, '', $2::bigint::text)
           on conflict (k, f) do update set
             v = ((case when kv.exp <= now() then 0 else kv.v::bigint end) + $2::bigint)::text,
             exp = case when kv.exp <= now() then null else kv.exp end
           returning v`,
    params: [k, Number(n)],
    map: (r) => Number(r[0].v),
  }),
  INCR: (k) => SQL.INCRBY(k, 1),
  DECRBY: (k, n) => SQL.INCRBY(k, -Number(n)),

  HGET: (k, f) => ({ text: 'select v from kv where k = $1 and f = $2', params: [k, f], map: (r) => r[0]?.v ?? null }),
  HSET(k, ...pairs) {
    const fields = pairs.filter((_, i) => i % 2 === 0);
    const values = pairs.filter((_, i) => i % 2 === 1);
    return {
      text: `insert into kv (k, f, v) select $1, * from unnest($2::text[], $3::text[])
             on conflict (k, f) do update set v = excluded.v`,
      params: [k, fields, values],
      map: () => fields.length,
    };
  },
  HGETALL: (k) => ({ text: 'select f, v from kv where k = $1', params: [k], map: (r) => r.flatMap((x) => [x.f, x.v]) }),
  HVALS: (k) => ({ text: 'select v from kv where k = $1', params: [k], map: (r) => r.map((x) => x.v) }),
  HMGET: (k, ...fields) => ({
    text: 'select f, v from kv where k = $1 and f = any($2::text[])',
    params: [k, fields],
    map: (r) => {
      const found = new Map(r.map((x) => [x.f, x.v]));
      return fields.map((f) => found.get(f) ?? null);
    },
  }),
  HINCRBY: (k, f, n) => ({
    text: `insert into kv (k, f, v) values ($1, $2, $3::bigint::text)
           on conflict (k, f) do update set v = (kv.v::bigint + $3::bigint)::text
           returning v`,
    params: [k, f, Number(n)],
    map: (r) => Number(r[0].v),
  }),

  // член множества может быть длинным (JSON сообщения), поэтому в ключ кладём его md5
  ZADD: (k, score, member) => ({
    text: `insert into kv (k, f, v, score) values ($1, md5($3), $3, $2)
           on conflict (k, f) do update set score = excluded.score`,
    params: [k, Number(score), member],
    map: () => 1,
  }),
  ZRANGEBYSCORE(k, min, max) {
    const where = ['k = $1'];
    const params = [k];
    for (const [bound, op] of [[String(min), '>'], [String(max), '<']]) {
      if (bound === '-inf' || bound === '+inf') continue;
      const exclusive = bound.startsWith('(');
      params.push(Number(exclusive ? bound.slice(1) : bound));
      where.push(`score ${op}${exclusive ? '' : '='} $${params.length}`);
    }
    return { text: `select v from kv where ${where.join(' and ')} order by score`, params, map: (r) => r.map((x) => x.v) };
  },

  RPUSH: (k, ...vals) => ({
    text: `insert into kv (k, f, v) select $1, gen_random_uuid()::text, x
           from unnest($2::text[]) with ordinality as t(x, i) order by i`,
    params: [k, vals],
    map: () => vals.length,
  }),
  LRANGE: (k, start, stop) => ({
    text: 'select v from kv where k = $1 order by seq',
    params: [k],
    map: (r) => {
      const n = r.length;
      let a = Number(start);
      let b = Number(stop);
      if (a < 0) a += n;
      if (b < 0) b += n;
      return r.slice(Math.max(0, a), b + 1).map((x) => x.v);
    },
  }),

  SADD: (k, ...members) => ({
    text: 'insert into kv (k, f) select $1, unnest($2::text[]) on conflict do nothing',
    params: [k, members],
    map: () => members.length,
  }),
  SMEMBERS: (k) => ({ text: 'select f from kv where k = $1', params: [k], map: (r) => r.map((x) => x.f) }),
};

function postgresStore(url) {
  let sql;
  let ready;
  const init = () =>
    (ready ??= (async () => {
      const { neon } = await import('@neondatabase/serverless');
      sql = neon(url);
      await sql.transaction(SCHEMA.map((statement) => sql.query(statement)));
    })().catch((err) => {
      ready = null;
      throw err;
    }));

  const compile = (args) => {
    const [name, ...rest] = args.map(String);
    const build = SQL[name.toUpperCase()];
    if (!build) throw new Error(`Команда ${name} не поддерживается`);
    return build(...rest);
  };

  return {
    kind: 'postgres',
    init,
    async cmd(...args) {
      await init();
      const q = compile(args);
      return q.map(await sql.query(q.text, q.params));
    },
    async pipe(cmds) {
      if (!cmds.length) return [];
      await init();
      const qs = cmds.map(compile);
      const results = await sql.transaction(qs.map((q) => sql.query(q.text, q.params)));
      return results.map((rows, i) => qs[i].map(rows));
    },
  };
}

function redisStore(url, token) {
  async function call(pathname, body) {
    const res = await fetch(`${url.replace(/\/+$/, '')}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Redis ${res.status}: ${data.error || 'нет ответа'}`);
    return data;
  }
  const unwrap = (r) => {
    if (r.error) throw new Error(`Redis: ${r.error}`);
    return r.result;
  };
  return {
    kind: 'redis',
    cmd: async (...args) => unwrap(await call('', args.map(String))),
    pipe: async (cmds) => (cmds.length ? (await call('/pipeline', cmds.map((c) => c.map(String)))).map(unwrap) : []),
  };
}

function memoryStore(file) {
  // key -> { t: 's'|'h'|'z'|'l'|'set', v, exp? }
  let data = {};
  if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));

  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  };
  const touch = () => {
    if (file && !timer) timer = setTimeout(flush, 250);
  };

  const live = (key) => {
    const e = data[key];
    if (e?.exp && e.exp <= Date.now()) delete data[key];
    return data[key];
  };
  const of = (key, t, init) => {
    const e = live(key);
    if (e) {
      if (e.t !== t) throw new Error(`WRONGTYPE ${key}`);
      return e.v;
    }
    data[key] = { t, v: init };
    return data[key].v;
  };
  const s = (v) => String(v);

  const commands = {
    GET: (k) => live(k)?.v ?? null,
    SET(k, v, ...opts) {
      const up = opts.map((o) => String(o).toUpperCase());
      if (up.includes('NX') && live(k)) return null;
      const exIndex = up.indexOf('EX');
      data[k] = { t: 's', v: s(v), exp: exIndex >= 0 ? Date.now() + Number(opts[exIndex + 1]) * 1000 : undefined };
      return 'OK';
    },
    DEL: (...keys) => keys.filter((k) => live(k) && delete data[k]).length,
    EXISTS: (...keys) => keys.filter((k) => live(k)).length,
    EXPIRE(k, sec) {
      const e = live(k);
      if (!e) return 0;
      e.exp = Date.now() + Number(sec) * 1000;
      return 1;
    },
    INCRBY(k, n) {
      const e = live(k);
      const next = Number(e?.v ?? 0) + Number(n);
      data[k] = { t: 's', v: s(next), exp: e?.exp };
      return next;
    },
    INCR: (k) => commands.INCRBY(k, 1),
    DECRBY: (k, n) => commands.INCRBY(k, -Number(n)),

    HGET: (k, f) => live(k)?.v[f] ?? null,
    HSET(k, ...pairs) {
      const h = of(k, 'h', {});
      let added = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        if (!(pairs[i] in h)) added++;
        h[pairs[i]] = s(pairs[i + 1]);
      }
      return added;
    },
    HDEL(k, ...fields) {
      const h = live(k)?.v || {};
      return fields.filter((f) => f in h && delete h[f]).length;
    },
    HGETALL: (k) => Object.entries(live(k)?.v || {}).flat(),
    HVALS: (k) => Object.values(live(k)?.v || {}),
    HMGET: (k, ...fields) => fields.map((f) => live(k)?.v[f] ?? null),
    HINCRBY(k, f, n) {
      const h = of(k, 'h', {});
      h[f] = s(Number(h[f] ?? 0) + Number(n));
      return Number(h[f]);
    },

    ZADD(k, score, member) {
      const z = of(k, 'z', []);
      const i = z.findIndex(([, m]) => m === s(member));
      if (i >= 0) z.splice(i, 1);
      z.push([Number(score), s(member)]);
      z.sort((a, b) => a[0] - b[0]);
      return i >= 0 ? 0 : 1;
    },
    ZRANGEBYSCORE(k, min, max) {
      const bound = (b, lower) => {
        b = String(b);
        if (b === '-inf') return [-Infinity, false];
        if (b === '+inf') return [Infinity, false];
        return b.startsWith('(') ? [Number(b.slice(1)), true] : [Number(b), false];
      };
      const [lo, loEx] = bound(min, true);
      const [hi, hiEx] = bound(max, false);
      return (live(k)?.v || [])
        .filter(([sc]) => (loEx ? sc > lo : sc >= lo) && (hiEx ? sc < hi : sc <= hi))
        .map(([, m]) => m);
    },

    RPUSH: (k, ...vals) => of(k, 'l', []).push(...vals.map(s)),
    LRANGE(k, start, stop) {
      const l = live(k)?.v || [];
      const n = l.length;
      let a = Number(start);
      let b = Number(stop);
      if (a < 0) a += n;
      if (b < 0) b += n;
      return l.slice(Math.max(0, a), b + 1);
    },

    SADD(k, ...members) {
      const set = of(k, 'set', []);
      let added = 0;
      for (const m of members.map(s)) if (!set.includes(m)) (set.push(m), added++);
      return added;
    },
    SMEMBERS: (k) => [...(live(k)?.v || [])],
  };

  const run = (args) => {
    const [name, ...rest] = args.map(String);
    const fn = commands[name.toUpperCase()];
    if (!fn) throw new Error(`Команда ${name} не поддерживается`);
    const result = fn(...rest);
    touch();
    return result;
  };

  return {
    kind: 'memory',
    flush,
    cmd: async (...args) => run(args),
    pipe: async (cmds) => cmds.map(run),
  };
}
