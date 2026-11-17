-- Fox Tales: mark the teacher's messages.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.

alter table public.messages add column if not exists from_teacher boolean not null default false;

-- The website can only post plain messages that aren't marked as the teacher's.
-- (Files go through the "files" Edge Function; teacher messages through post_as_teacher.)
drop policy if exists "anyone can post messages" on public.messages;
create policy "anyone can post messages"
  on public.messages for insert
  to anon, authenticated
  with check (file_path is null and from_teacher = false);

-- Post a message marked as the teacher's (teacher passcode required).
create or replace function public.post_as_teacher(room_name text, sender text, message text, passcode text)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare row public.messages;
begin
  if not public.is_teacher(passcode) then
    raise exception 'Wrong teacher passcode' using errcode = '28P01';
  end if;
  insert into public.messages (room, name, body, from_teacher)
  values (room_name, sender, message, true)
  returning * into row;
  return row;
end $$;

revoke all on function public.post_as_teacher(text, text, text, text) from public;
grant execute on function public.post_as_teacher(text, text, text, text) to anon, authenticated;
