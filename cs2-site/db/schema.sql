-- LuxeDrop: схема базы. Идемпотентна: можно запускать повторно (npm run migrate).
-- Все суммы хранятся в копейках (bigint), чтобы не было ошибок округления.

create table if not exists users (
  id           bigserial primary key,
  steam_id     text unique,             -- устарело: вход теперь только через Telegram
  name         text not null,
  avatar       text,
  trade_url    text,
  balance      bigint not null default 0 check (balance >= 0),
  is_banned    boolean not null default false,
  -- provably fair: активная пара сидов и счётчик бросков
  server_seed  text not null,
  client_seed  text not null,
  nonce        integer not null default 0,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Каталог скинов: метаданные + рыночная цена (обновляется синхронизацией цен)
create table if not exists items (
  hash_name    text primary key,          -- market_hash_name из Steam
  name         text not null,             -- «AK-47 | Redline»
  weapon       text,
  wear         text,                      -- Factory New / Field-Tested / …
  rarity       text,                      -- ключ редкости: covert, classified, …
  rarity_color text,
  image        text,
  stattrak     boolean not null default false,
  price        bigint not null,           -- рыночная цена, копейки
  quantity     integer not null default 0,
  updated_at   timestamptz not null default now()
);
create index if not exists items_price_idx on items (price);

-- Скины, которые лежат у игроков на сайте
create table if not exists user_items (
  id         bigserial primary key,
  user_id    bigint not null references users(id),
  hash_name  text not null references items(hash_name),
  price      bigint not null,             -- цена на момент получения
  source     text not null,               -- market | upgrade | admin
  status     text not null default 'owned', -- owned | withdrawing | withdrawn | sold | burned
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_items_user_idx on user_items (user_id, status);

-- Журнал всех движений баланса. Сумма amount по пользователю = его баланс.
create table if not exists ledger (
  id            bigserial primary key,
  user_id       bigint not null references users(id),
  amount        bigint not null,           -- + пополнение, − списание
  balance_after bigint not null,
  kind          text not null,             -- deposit | withdraw | refund | buy | sell | upgrade | buyback | admin | demo
  ref           text,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists ledger_user_idx on ledger (user_id, id desc);

-- Раскрытые серверные сиды (после смены сида игроком)
create table if not exists seeds (
  id               bigserial primary key,
  user_id          bigint not null references users(id),
  server_seed      text not null,
  server_seed_hash text not null unique,
  client_seed      text not null,
  last_nonce       integer not null,
  revealed_at      timestamptz not null default now()
);

create table if not exists upgrades (
  id               bigserial primary key,
  user_id          bigint not null references users(id),
  input_items      jsonb not null,         -- [{id, hashName, price}]
  input_balance    bigint not null,
  input_value      bigint not null,
  target_hash_name text not null,
  target_price     bigint not null,
  chance_ppm       integer not null,       -- шанс в миллионных долях
  roll             integer not null,       -- 0…999999
  won              boolean not null,
  server_seed_hash text not null,
  client_seed      text not null,
  nonce            integer not null,
  result_item_id   bigint,
  created_at       timestamptz not null default now()
);
create index if not exists upgrades_user_idx on upgrades (user_id, id desc);
create index if not exists upgrades_won_idx on upgrades (won, id desc);

-- Денежные операции: пополнения (in) и выводы (out)
create table if not exists payments (
  id          bigserial primary key,
  user_id     bigint not null references users(id),
  direction   text not null,               -- in | out
  method      text not null,               -- crypto | card | sbp | demo
  amount      bigint not null,             -- сумма в копейках (для out — списано с баланса)
  fee         bigint not null default 0,
  status      text not null,               -- pending | review | processing | paid | rejected | failed
  provider_id text,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  paid_at     timestamptz
);
create index if not exists payments_user_idx on payments (user_id, id desc);
create index if not exists payments_status_idx on payments (status, id);
create unique index if not exists payments_provider_idx on payments (method, provider_id) where provider_id is not null;

-- Вывод скинов в Steam
create table if not exists skin_withdrawals (
  id           bigserial primary key,
  user_id      bigint not null references users(id),
  user_item_id bigint not null references user_items(id),
  hash_name    text not null,
  price        bigint not null,
  trade_url    text not null,
  status       text not null,              -- review | processing | sent | refunded
  provider_id  text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists skin_withdrawals_status_idx on skin_withdrawals (status, id);

-- Ограничение частоты запросов (работает между копиями serverless-функции)
create table if not exists rate_limits (
  key          text not null,
  window_start bigint not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

-- Настройки, которые админ меняет без редеплоя (наценки, комиссии, лимиты)
create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

-- Служебное: когда последний раз синхронизировали цены
create table if not exists meta (
  key   text primary key,
  value jsonb not null
);

-- Telegram Mini App: игрок входит через Telegram, Steam тогда не обязателен
alter table users alter column steam_id drop not null;
alter table users add column if not exists telegram_id text;
alter table users add column if not exists tg_username text;
create unique index if not exists users_telegram_idx on users (telegram_id);

-- Кто сейчас на сайте: страница отмечается раз в 20 секунд (для честного счётчика «онлайн»)
create table if not exists presence (
  key     text primary key,               -- u:<id игрока> или g:<хэш IP>
  seen_at timestamptz not null default now()
);
create index if not exists presence_seen_idx on presence (seen_at);

-- LuxeCoin: цены скинов — целые LC (1 LC = 1 ₽), округление вниз. Безопасно повторять.
update items set price = price - price % 100 where price % 100 <> 0;
