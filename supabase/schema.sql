-- Fox Tales: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room       text        not null check (char_length(room) between 1 and 64),
  name       text        not null check (char_length(name) between 1 and 40),
  body       text        not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_at_idx
  on public.messages (room, created_at);

-- Row level security: anyone with the link can read and post,
-- but nobody can edit or delete through the public API.
alter table public.messages enable row level security;

drop policy if exists "anyone can read messages" on public.messages;
create policy "anyone can read messages"
  on public.messages for select
  to anon, authenticated
  using (true);

drop policy if exists "anyone can post messages" on public.messages;
create policy "anyone can post messages"
  on public.messages for insert
  to anon, authenticated
  with check (true);

-- Send new messages to open browsers in real time.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

-- You can also clear a room by hand here in the SQL Editor:
--   delete from public.messages where room = 'your-room-name';

-- ---------------------------------------------------------------
-- Teacher tools: "Clear room" button, protected by a passcode.
-- The passcode is stored hashed in a private schema the website can't read.
-- ---------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists private.settings (
  key   text primary key,
  value text not null
);

-- Is this the teacher passcode?
create or replace function public.is_teacher(passcode text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare stored text;
begin
  select value into stored from private.settings where key = 'teacher_passcode';
  return stored is not null
     and passcode is not null
     and passcode <> 'change-me'          -- the placeholder never works
     and extensions.crypt(passcode, stored) = stored;
end $$;

-- Delete every message in a room (teacher passcode required).
create or replace function public.clear_room(room_name text, passcode text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  if not public.is_teacher(passcode) then
    raise exception 'Wrong teacher passcode' using errcode = '28P01';
  end if;
  delete from public.messages where room = room_name;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.is_teacher(text) from public;
revoke all on function public.clear_room(text, text) from public;
grant execute on function public.is_teacher(text) to anon, authenticated;
grant execute on function public.clear_room(text, text) to anon, authenticated;

-- SET YOUR TEACHER PASSCODE: change 'change-me' below, then run this file.
-- (Run just this statement again any time you want a new passcode.)
insert into private.settings (key, value)
values ('teacher_passcode', extensions.crypt('change-me', extensions.gen_salt('bf')))
on conflict (key) do update set value = excluded.value;
