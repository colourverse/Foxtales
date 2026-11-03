# 🦊 Fox Tales

A simple chat room for small teaching groups. Students in the room and on Zoom open one link
in any browser (Mac, Windows, Chromebook, phone). There's nothing to install and no account to make.

- **The teacher sets the room.** Open the site, type a room name, then copy the link it gives you.
- **Students** open the link, type their name once, and chat. Their name is remembered next time.
- Messages are kept, so anyone who joins late sees what was said earlier.
- A "Here now" list shows who has the room open.
- Web addresses in messages become clickable links.

It's a plain static site (`index.html`, `style.css`, `app.js`, `config.js`) with
[Supabase](https://supabase.com) (free tier) storing and delivering the messages.

## Setup (about 10 minutes)

1. **Create a Supabase project:** sign up at supabase.com, then choose *New project*. Any name and region is fine.
2. **Create the messages table:** in your project, open *SQL Editor* → *New query*, paste in all of
   [`supabase/schema.sql`](supabase/schema.sql), and click *Run*.
3. **Connect the site:** open *Project Settings* → *API* and copy the **Project URL** and the
   **anon public** key into `config.js`:
   ```js
   window.FOX_TALES_CONFIG = {
     supabaseUrl: "https://xxxx.supabase.co",
     supabaseAnonKey: "eyJ...",
     appName: "Fox Tales",
   };
   ```
   The anon key is designed to be public, so it's fine for it to sit in this file.
4. **Put the four files on any web host:** your own host, GitHub Pages, Netlify and so on.
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
- To clear a room, run this in the Supabase SQL Editor:
  `delete from public.messages where room = 'tuesday-writers';`

## Notes

- Anyone with a room's link can read and post in it. Nobody can edit or delete messages through the site.
- Each room shows its latest 300 messages.
- Brand colours are CSS variables at the top of `style.css`. The app name comes from `config.js`.
