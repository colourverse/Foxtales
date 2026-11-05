-- Fox Tales: teacher "Manage rooms" page (list and delete rooms).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Both functions need the teacher passcode.

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
