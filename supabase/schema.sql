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

-- To clear a room later (run in the SQL Editor):
--   delete from public.messages where room = 'your-room-name';
