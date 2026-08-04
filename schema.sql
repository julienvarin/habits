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
create policy "anon all" on habits for all to anon using (true) with check (true);
create policy "anon all" on entries for all to anon using (true) with check (true);

create table if not exists todos (
  id text primary key,
  text text not null,
  label text,
  done boolean not null default false,
  created_at bigint not null,
  done_at bigint
);

create index if not exists todos_done_created_idx on todos(done, created_at desc);

alter table todos enable row level security;
drop policy if exists "anon all" on todos;
create policy "anon all" on todos for all to anon using (true) with check (true);
