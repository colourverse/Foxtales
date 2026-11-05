# 🦊 Fox Tales

A simple chat room for small teaching groups. Students in the room and on Zoom open one link
in any browser (Mac, Windows, Chromebook, phone). There's nothing to install and no account to make.

- **The teacher sets the room.** On the home page, use *Start a room* and type a room name.
- **Students** go to the home page, type the room name and their own name under *Join a room*, and chat.
  Or they can open a direct link to the room, which the teacher can paste into Zoom chat or email.
  Their name is remembered next time.
- Messages are kept, so anyone who joins late sees what was said earlier.
- A "Here now" list shows who has the room open.
- Web addresses in messages become clickable links.

It's a plain static site (`index.html`, `style.css`, `app.js`, `config.js`) with
[Supabase](https://supabase.com) (free tier) storing and delivering the messages.

## Setup (about 10 minutes)

1. **Create a Supabase project:** sign up at supabase.com, then choose *New project*. Any name and region is fine.
2. **Create the messages table:** in your project, open *SQL Editor* → *New query*,
   paste in all of [`supabase/schema.sql`](supabase/schema.sql), and click *Run*.
   If Supabase asks about Row Level Security, choose *Run and enable RLS*.
3. **Set your teacher passcode:** in a new query, paste [`supabase/set-passcode.sql`](supabase/set-passcode.sql),
   replace `YOUR-PASSCODE-HERE` with your passcode, and click *Run*.
   Then delete that query from the SQL Editor's saved list, because it contains your passcode.
4. **Connect the site:** open *Project Settings* → *API Keys* and copy the **Project URL** and the
   **Publishable key** (starts with `sb_publishable_`) into `config.js`:
   ```js
   window.FOX_TALES_CONFIG = {
     supabaseUrl: "https://xxxx.supabase.co",
     supabaseAnonKey: "sb_publishable_...",
     appName: "Fox Tales",
   };
   ```
   The publishable key is designed to be public, so it's fine for it to sit in this file.
   **Never** use the *secret* key here. The older "anon" key also works until Supabase retires it.
5. **Put the four files on any web host:** your own host, GitHub Pages, Netlify and so on.
   There's no build step.

If `config.js` is left blank, the app runs in **demo mode**. Messages are then only shared between tabs
in the same browser, which is handy for trying it out locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Using it in class

- Make the link before the session and paste it into the Zoom chat, an email, or on the board.
  Links look like `https://your-site/?room=tuesday-writers`.
- Reusing the same room name next week brings back the earlier conversation.
- **Clearing a room:** click *Teacher tools* (bottom of the left panel), enter your passcode, then *Clear room*.
  Every message in that room is deleted for everyone, and students' screens empty straight away.
  Your browser remembers the passcode until you click *Lock teacher tools*, so don't unlock on a shared computer.
- To change the passcode, run `supabase/set-passcode.sql` again with the new one.

## Notes

- Anyone with a room's link can read and post in it. Only someone with the teacher passcode can clear a room.
  The check happens in the database, so hiding or showing the button doesn't matter for security.
- In demo mode, any passcode unlocks the teacher tools.
- Each room shows its latest 300 messages.
- Brand colours are CSS variables at the top of `style.css`. The app name comes from `config.js`.
