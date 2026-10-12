-- Run this in the Supabase SQL editor once to set up the database.

create table if not exists habits (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#22c55e',
  section text,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- Migration: add section column if table already exists
alter table habits add column if not exists section text;

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references habits(id) on delete cascade,
  date date not null,
  created_at timestamptz not null default now(),
  unique (habit_id, date)
);

create index if not exists entries_habit_date_idx on entries(habit_id, date);

alter table habits enable row level security;
alter table entries enable row level security;

drop policy if exists "anon all" on habits;
drop policy if exists "anon all" on entries;

create table if not exists todos (
  id text primary key,
  text text not null,
  label text,
  -- 'todo'   = a task
  -- 'list'   = an item on a freeform tickable list (movies to watch, books to
  --            read, things to buy…), with `label` as the list name.
  -- 'stress' = a task placed on the stress board; stress_x / stress_y (0..1)
  --            hold its position (x = complexity, y = stress).
  kind text not null default 'todo',
  done boolean not null default false,
  created_at bigint not null,
  done_at bigint,
  stress_x double precision,
  stress_y double precision
);

-- Migration: add kind column if the todos table already exists.
alter table todos add column if not exists kind text not null default 'todo';
-- Migration: stress-board coordinates (x = complexity, y = stress; both 0..1).
alter table todos add column if not exists stress_x double precision;
alter table todos add column if not exists stress_y double precision;

create index if not exists todos_done_created_idx on todos(done, created_at desc);

alter table todos enable row level security;
drop policy if exists "anon all" on todos;

-- One journal entry per day. "day_text" is the short note about the day;
-- "learnt_text" is the things-I-learnt section. A day counts toward the
-- journaling streak when day_text is non-empty (see journal.js).
create table if not exists journal (
  date date primary key,
  day_text text,
  learnt_text text,
  tomorrow_text text,
  big_done boolean not null default false,
  updated_at bigint,
  created_at timestamptz not null default now()
);

-- Migration: "one thing to do tomorrow" + whether that day's big task got done.
-- The big task for a given day is the previous day's tomorrow_text (see journal.js).
alter table journal add column if not exists tomorrow_text text;
alter table journal add column if not exists big_done boolean not null default false;

create index if not exists journal_date_idx on journal(date desc);

alter table journal enable row level security;
drop policy if exists "anon all" on journal;


-- Web Push subscriptions for the daily reminder (one row per device).
create table if not exists push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

-- Used only by the `reminder` Edge Function (service role); no API access.
-- VAPID keys are generated on first use; sent_on stops duplicate reminders.
create table if not exists push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text not null,
  vapid_private text not null
);
create table if not exists reminder_log (
  day date primary key,
  sent_at timestamptz not null default now()
);
alter table push_config enable row level security;
alter table reminder_log enable row level security;

-- ============================================================
-- Access: only the owner's account can read or write.
-- ============================================================
-- Emails allowed to use the app. Add yours once (SQL editor, not in this file):
--   insert into allowed_users (email) values ('you@example.com');
create table if not exists allowed_users (
  email text primary key
);
alter table allowed_users enable row level security;
-- No policies on allowed_users: nobody can read or change it through the API.

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function is_owner() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['habits', 'entries', 'todos', 'journal', 'push_subscriptions'] loop
    execute format('drop policy if exists "anon all" on %I', t);
    execute format('drop policy if exists "owner all" on %I', t);
    execute format('create policy "owner all" on %I for all to authenticated using (is_owner()) with check (is_owner())', t);
  end loop;
end $$;
