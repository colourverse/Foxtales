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
-- Rooms: the list of rooms that exist, so "Join a room" can say when
-- a room name isn't found. "Start a room" adds to this list.
-- ---------------------------------------------------------------

create table if not exists public.rooms (
  slug       text        primary key
             check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 48),
  title      text        not null check (char_length(title) between 1 and 64),
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists "anyone can see rooms" on public.rooms;
create policy "anyone can see rooms"
  on public.rooms for select
  to anon, authenticated
  using (true);

drop policy if exists "anyone can create rooms" on public.rooms;
create policy "anyone can create rooms"
  on public.rooms for insert
  to anon, authenticated
  with check (true);

-- Add rooms that already have messages (from before this list existed).
insert into public.rooms (slug, title)
select distinct on (room) room, initcap(replace(room, '-', ' '))
from public.messages
where room ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(room) <= 48
on conflict (slug) do nothing;

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

-- Belt and braces: the website can never read this table directly.
-- (The teacher functions below still can, because they run as the table owner.)
alter table private.settings enable row level security;
revoke all on private.settings from anon, authenticated;

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

-- ---------------------------------------------------------------
-- Manage rooms (teacher): list and delete rooms.
-- ---------------------------------------------------------------

-- Every room, with how many messages it has and when it was last used.
create or replace function public.list_rooms(passcode text)
returns table (slug text, title text, created_at timestamptz,
               message_count bigint, last_message_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher(passcode) then
    raise exception 'Wrong teacher passcode' using errcode = '28P01';
  end if;
  return query
  with all_rooms as (
    select r.slug as s, r.title as t, r.created_at as c
    from public.rooms r
    union all
    -- rooms that only exist as messages
    select m.room, initcap(replace(m.room, '-', ' ')), min(m.created_at)
    from public.messages m
    where not exists (select 1 from public.rooms r2 where r2.slug = m.room)
    group by m.room
  )
  select a.s, a.t, a.c, count(m.id), max(m.created_at)
  from all_rooms a
  left join public.messages m on m.room = a.s
  group by a.s, a.t, a.c
  order by coalesce(max(m.created_at), a.c) desc;
end $$;

-- Delete a room and all its messages. Returns how many messages were deleted.
create or replace function public.delete_room(room_slug text, passcode text)
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
  delete from public.messages where room = room_slug;
  get diagnostics n = row_count;
  delete from public.rooms where slug = room_slug;
  return n;
end $$;

revoke all on function public.list_rooms(text) from public;
revoke all on function public.delete_room(text, text) from public;
grant execute on function public.list_rooms(text) to anon, authenticated;
grant execute on function public.delete_room(text, text) to anon, authenticated;

-- No passcode is set here. To set one, run supabase/set-passcode.sql.
-- Until then, teacher tools stay locked.
