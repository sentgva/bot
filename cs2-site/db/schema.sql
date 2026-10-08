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
  source     text not null,               -- market | upgrade | admin | case | contract
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
  kind          text not null,             -- deposit | withdraw | refund | buy | sell | upgrade | buyback | admin | demo | bonus | case | promo | referral
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

-- Открытия кейсов (lib/cases.js)
create table if not exists case_opens (
  id               bigserial primary key,
  user_id          bigint not null references users(id),
  case_slug        text not null,
  case_price       bigint not null,
  hash_name        text not null,
  item_price       bigint not null,
  chance_ppm       integer not null,       -- шанс выпавшего скина, миллионные доли
  roll             integer not null,       -- 0…999999
  server_seed_hash text not null,
  client_seed      text not null,
  nonce            integer not null,
  user_item_id     bigint references user_items(id),
  created_at       timestamptz not null default now()
);
create index if not exists case_opens_user_idx on case_opens (user_id, id desc);
create index if not exists case_opens_drop_idx on case_opens (id desc) where item_price > case_price;

-- Промокоды (lib/promo.js)
create table if not exists promo_codes (
  code       text primary key,
  amount     bigint not null,            -- сотые LC
  max_uses   integer not null,
  uses       integer not null default 0,
  active     boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists promo_redemptions (
  code       text not null references promo_codes(code),
  user_id    bigint not null references users(id),
  created_at timestamptz not null default now(),
  primary key (code, user_id)
);

-- Админы, назначенные владельцем из админ-панели (владельцы — ADMIN_TG_IDS / ADMIN_TG_USERNAMES в окружении)
alter table users add column if not exists is_admin boolean not null default false;
-- Уровни (lib/vip.js): опыт в сотых долях очка
alter table users add column if not exists xp bigint not null default 0;
-- Бан: причина и срок (null — навсегда); после banned_until бан снимается сам
alter table users add column if not exists ban_reason text;
alter table users add column if not exists banned_until timestamptz;

-- Рефералы (lib/referrals.js): кто пригласил игрока
alter table users add column if not exists referred_by bigint references users(id);
create index if not exists users_referred_by_idx on users (referred_by) where referred_by is not null;

-- Контракты (lib/contracts.js): 3–10 скинов → один случайный скин
create table if not exists contracts (
  id               bigserial primary key,
  user_id          bigint not null references users(id),
  input_items      jsonb not null,
  input_value      bigint not null,
  hash_name        text not null,
  item_price       bigint not null,
  chance_ppm       integer not null,
  roll             integer not null,
  server_seed_hash text not null,
  client_seed      text not null,
  nonce            integer not null,
  user_item_id     bigint references user_items(id),
  created_at       timestamptz not null default now()
);
create index if not exists contracts_user_idx on contracts (user_id, id desc);

-- Рассылка новостей через бота (lib/broadcast.js)
create table if not exists bot_users (       -- кто писал боту; blocked — заблокировал бота / недоступен
  telegram_id  text primary key,
  first_name   text,
  username     text,
  blocked      boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table if not exists bot_state (       -- ожидание ввода в боте (например, текста новости после /news)
  telegram_id text primary key,
  value       text not null
);
create table if not exists broadcasts (
  id           bigserial primary key,
  from_chat_id text not null,                -- откуда копировать сообщение новости
  message_id   bigint not null,
  created_by   text not null,
  status       text not null default 'draft', -- draft | sending | done | cancelled
  cursor       text,                          -- до какого telegram_id уже разослали
  sent         integer not null default 0,
  failed       integer not null default 0,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- Поддержка в Telegram-боте (lib/support.js)
create table if not exists tickets (
  id          bigserial primary key,
  telegram_id text not null,
  user_id     bigint references users(id),
  tg_name     text,
  tg_username text,
  status      text not null default 'open',   -- open | closed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tickets_status_idx on tickets (status, updated_at desc);
create index if not exists tickets_tg_idx on tickets (telegram_id, status);
create table if not exists ticket_messages (
  id         bigserial primary key,
  ticket_id  bigint not null references tickets(id),
  sender     text not null,                   -- user | admin
  admin_name text,
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists ticket_messages_idx on ticket_messages (ticket_id, id);
-- Какое сообщение в чате админа относится к какому тикету (чтобы ответ reply'ем ушёл нужному игроку)
create table if not exists ticket_admin_messages (
  chat_id    text not null,
  message_id bigint not null,
  ticket_id  bigint not null references tickets(id),
  primary key (chat_id, message_id)
);

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

-- Разовая смена стартового бонуса на 1 000 LC (перезаписывает значение, сохранённое в админке до этого)
do $$
begin
  if not exists (select 1 from meta where key = 'migration_signup_bonus_1000') then
    insert into settings (key, value) values ('signupBonus', '100000') on conflict (key) do update set value = excluded.value;
    insert into meta (key, value) values ('migration_signup_bonus_1000', 'true');
  end if;
end $$;

-- Разовый сброс шансов апгрейдера к рабочим значениям (на сайте стояли комиссия 50% и максимум 5% — апгрейд был почти невозможен)
do $$
begin
  if not exists (select 1 from meta where key = 'migration_upgrade_odds_reset_1') then
    insert into settings (key, value) values ('houseEdge', '0.05'), ('maxChance', '0.8'), ('minChance', '0.01')
      on conflict (key) do update set value = excluded.value;
    insert into meta (key, value) values ('migration_upgrade_odds_reset_1', 'true');
  end if;
end $$;

-- Разово: минимальный шанс апгрейда 0 — можно ставить на любой скин (например, 10 LC на скин за 100 000 LC)
do $$
begin
  if not exists (select 1 from meta where key = 'migration_upgrade_min_chance_0') then
    insert into settings (key, value) values ('minChance', '0') on conflict (key) do update set value = excluded.value;
    insert into meta (key, value) values ('migration_upgrade_min_chance_0', 'true');
  end if;
end $$;

-- Разово: ответы поддержки анонимны — стираем сохранённые имена админов в тикетах
update ticket_messages set admin_name = null where admin_name is not null;
