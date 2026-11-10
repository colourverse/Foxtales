-- Fox Tales: file sharing (teacher only).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Also needs the "files" Edge Function (supabase/functions/files) deployed
-- with "Verify JWT" turned off; it checks the teacher passcode itself.

-- Storage bucket. Public, so files can be opened by link; nobody can list
-- or upload except through the Edge Function. 25 MB per file.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 26214400)
on conflict (id) do update set public = true, file_size_limit = 26214400;

-- Messages can carry one file.
alter table public.messages add column if not exists file_path text;
alter table public.messages add column if not exists file_name text;
alter table public.messages add column if not exists file_size bigint;
alter table public.messages add column if not exists file_type text;

-- A message needs text, a file, or both.
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_body_or_file;
alter table public.messages add constraint messages_body_or_file check (
  char_length(body) <= 2000 and (char_length(body) >= 1 or file_path is not null)
);

alter table public.messages drop constraint if exists messages_file_fields;
alter table public.messages add constraint messages_file_fields check (
  file_path is null
  or (split_part(file_path, '/', 1) = room
      and file_path ~ '^[a-z0-9-]+/[A-Za-z0-9._-]+$'
      and char_length(file_path) <= 200
      and file_name is not null and char_length(file_name) between 1 and 200
      and (file_type is null or char_length(file_type) <= 100))
);

-- The website can only post plain messages. Messages with files are added
-- by the Edge Function after it has checked the teacher passcode.
drop policy if exists "anyone can post messages" on public.messages;
create policy "anyone can post messages"
  on public.messages for insert
  to anon, authenticated
  with check (file_path is null);
