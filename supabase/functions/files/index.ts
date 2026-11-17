// Fox Tales "files" Edge Function: file sharing.
//
// Deploy with "Verify JWT" OFF: the site calls this with its publishable key.
//
// Actions (POST JSON, all need { room }):
//   sign               { name, size }                     -> { path, signedUrl }   anyone in the room
//   post               { path, name, type, body, sender } -> { message }           anyone in the room
//   delete-room-files  { passcode }                       -> { deleted }           teacher only

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const BUCKET = "files";
const MAX_BYTES = 25 * 1024 * 1024;

// Keep in step with ALLOWED_EXTENSIONS in app.js.
const ALLOWED = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg",
  // video and audio
  "mp4", "mov", "mpg", "mpeg", "avi", "webm", "mp3", "wav", "m4a",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "txt", "rtf", "csv", "md",
  // design
  "psd", "ai", "indd", "idml", "fig", "eps",
  // fonts
  "otf", "ttf", "woff", "woff2",
  // web and code
  "html", "htm", "css", "js", "json",
  // archives
  "zip",
]);

const ROOM_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function namedKey(variable: string, legacy: string): string {
  const raw = Deno.env.get(variable);
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (keys.default) return keys.default;
    } catch { /* fall through to the legacy key */ }
  }
  return Deno.env.get(legacy) ?? "";
}

const url = Deno.env.get("SUPABASE_URL") ?? "";
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, namedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), options);
const publicClient = createClient(url, namedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"), options);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// A file name that is safe to use in a storage path, keeping its extension.
export function safeFileName(name: string): string {
  const ext = extensionOf(name);
  const base = name.slice(0, ext ? name.length - ext.length - 1 : name.length)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80) || "file";
  return ext ? `${base}.${ext}` : base;
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const { action, passcode, room } = input;
  if (!isText(room, 1, 48) || !ROOM_RE.test(room)) {
    return json({ error: "Bad request" }, 400);
  }

  const storage = admin.storage.from(BUCKET);

  if (action === "delete-room-files") {
    // Teacher only.
    if (!isText(passcode, 1, 200)) return json({ error: "Wrong teacher passcode" }, 403);
    const check = await publicClient.rpc("is_teacher", { passcode });
    if (check.error) return json({ error: "Couldn't check the passcode" }, 500);
    if (check.data !== true) return json({ error: "Wrong teacher passcode" }, 403);

    let deleted = 0;
    for (let round = 0; round < 50; round++) {
      const { data, error } = await storage.list(room, { limit: 1000 });
      if (error) return json({ error: "Couldn't list the room's files", deleted }, 500);
      const paths = (data ?? []).filter((o) => o.id).map((o) => `${room}/${o.name}`);
      if (!paths.length) break;
      const removed = await storage.remove(paths);
      if (removed.error) return json({ error: "Couldn't delete the room's files", deleted }, 500);
      deleted += paths.length;
    }
    return json({ deleted });
  }

  if (action !== "sign" && action !== "post") return json({ error: "Unknown action" }, 400);

  // Anyone in a room can share files, but only in rooms that exist (so every file
  // belongs to a room the teacher can see in Manage rooms, and clear or delete).
  const found = await admin.from("rooms").select("slug").eq("slug", room).maybeSingle();
  if (found.error) return json({ error: "Couldn't check the room" }, 500);
  if (!found.data) return json({ error: "That room doesn't exist" }, 404);

  if (action === "sign") {
    const { name, size } = input;
    if (!isText(name, 1, 200)) return json({ error: "Missing file name" }, 400);
    if (!ALLOWED.has(extensionOf(name))) return json({ error: "That type of file isn't allowed" }, 400);
    if (typeof size !== "number" || size <= 0 || size > MAX_BYTES) {
      return json({ error: "Files must be 25 MB or smaller" }, 400);
    }
    const path = `${room}/${crypto.randomUUID()}-${safeFileName(name)}`;
    const { data, error } = await storage.createSignedUploadUrl(path);
    if (error || !data) return json({ error: "Couldn't start the upload" }, 500);
    return json({ path, signedUrl: data.signedUrl });
  }

  if (action === "post") {
    const { path, name, type, body, sender } = input;
    if (!isText(path, 1, 200) || !path.startsWith(room + "/") || path.slice(room.length + 1).includes("/")) {
      return json({ error: "Bad file path" }, 400);
    }
    if (!isText(name, 1, 200) || !isText(sender, 1, 40)) return json({ error: "Bad request" }, 400);
    const text = typeof body === "string" ? body.trim().slice(0, 2000) : "";
    const fileName = path.slice(room.length + 1);

    // Make sure the upload really happened, and read its real size.
    const listed = await storage.list(room, { search: fileName, limit: 10 });
    const obj = listed.data?.find((o) => o.name === fileName);
    if (!obj) return json({ error: "The upload didn't arrive. Please try again." }, 400);

    const { data, error } = await admin.from("messages").insert({
      room,
      name: sender,
      body: text,
      file_path: path,
      file_name: name,
      file_size: obj.metadata?.size ?? null,
      file_type: isText(type, 1, 100) ? type : null,
    }).select().single();
    if (error) return json({ error: "Couldn't post the file" }, 500);
    return json({ message: data });
  }

  return json({ error: "Unknown action" }, 400);
}

// Tests import handle() without starting a server.
if (Deno.env.get("FOXTALES_TEST") !== "1") Deno.serve(handle);
