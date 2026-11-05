-- Fox Tales: add the room list (for projects set up before rooms existed).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.

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
