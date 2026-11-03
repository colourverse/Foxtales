-- Fox Tales: set (or change) the teacher passcode.
-- 1. Paste this into Supabase → SQL Editor → New query.
-- 2. Replace YOUR-PASSCODE-HERE with your passcode (keep the quote marks).
-- 3. Click Run. Then delete this query from the SQL Editor's saved list,
--    because it contains your passcode in plain text.

insert into private.settings (key, value)
values ('teacher_passcode', extensions.crypt('YOUR-PASSCODE-HERE', extensions.gen_salt('bf')))
on conflict (key) do update set value = excluded.value;

-- Check it worked (should say true):
--   select public.is_teacher('YOUR-PASSCODE-HERE');
