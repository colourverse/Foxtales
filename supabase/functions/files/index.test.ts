// Tests for the "files" Edge Function, run against a fake Supabase API (no real project needed):
//   deno run --allow-net --allow-env --allow-read supabase/functions/files/index.test.ts \
//     ./supabase/functions/files/index.ts
const store = new Map<string, number>(); // "room/file" -> size
const inserted: Record<string, unknown>[] = [];
const seenKeys = new Set<string>();

const fake = Deno.serve({ port: 54999, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  seenKeys.add(req.headers.get("apikey") ?? "none");
  const body = req.method === "GET" ? null : await req.text();
  const j = body ? JSON.parse(body) : null;
  const ok = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/rest/v1/rpc/is_teacher") return ok(j.passcode === "right");
  if (u.pathname === "/rest/v1/rooms") {
    const slug = (u.searchParams.get("slug") ?? "").replace(/^eq\./, "");
    return ok(["tuesday-writers", "other-room"].includes(slug) ? [{ slug }] : []);
  }
  if (u.pathname.startsWith("/storage/v1/object/upload/sign/files/")) {
    const p = u.pathname.slice("/storage/v1/object/upload/sign/files/".length);
    return ok({ url: `/object/upload/sign/files/${p}?token=tok123` });
  }
  if (u.pathname === "/storage/v1/object/list/files") {
    const prefix = (j.prefix as string).replace(/\/$/, "");
    const out = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix + "/") && (!j.search || k.slice(prefix.length + 1).startsWith(j.search)))
      .slice(0, j.limit)
      .map(([k, size]) => ({ name: k.slice(prefix.length + 1), id: crypto.randomUUID(), metadata: { size } }));
    return ok(out);
  }
  if (u.pathname === "/storage/v1/object/files" && req.method === "DELETE") {
    for (const p of j.prefixes) store.delete(p);
    return ok(j.prefixes.map((p: string) => ({ name: p })));
  }
  if (u.pathname === "/rest/v1/messages" && req.method === "POST") {
    const row = { id: inserted.length + 1, created_at: new Date().toISOString(), ...j };
    inserted.push(row);
    return ok(req.headers.get("accept")?.includes("vnd.pgrst.object") ? row : [row], 201);
  }
  return ok({ error: "unhandled " + req.method + " " + u.pathname }, 404);
});

Deno.env.set("SUPABASE_URL", "http://localhost:54999");
Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ default: "sb_secret_TEST" }));
Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", JSON.stringify({ default: "sb_publishable_TEST" }));
Deno.env.set("FOXTALES_TEST", "1");
const fn = await import(Deno.args[0] ? new URL(Deno.args[0], "file://" + Deno.cwd() + "/").href : "./index.ts");

let failures = 0;
function check(label: string, cond: boolean, extra: unknown = "") {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  " + JSON.stringify(extra)));
  if (!cond) failures++;
}
async function call(payload: unknown, method = "POST") {
  const res = await fn.handle(new Request("http://x/files", { method, body: method === "POST" ? JSON.stringify(payload) : undefined }));
  const text = await res.text();
  let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cors: res.headers.get("access-control-allow-origin") };
}

let r = await call(null, "OPTIONS");
check("OPTIONS preflight has CORS", r.status === 200 && r.cors === "*", r);
r = await call({ action: "sign", room: "tuesday-writers", name: "student work.png", size: 10 });
check("student (no passcode) can sign", r.status === 200 && /^tuesday-writers\/[0-9a-f-]{36}-student-work\.png$/.test(r.data.path), r);
const spath = r.data.path; store.set(spath, 10);
r = await call({ action: "post", room: "tuesday-writers", path: spath, name: "student work.png", type: "image/png", body: "My poster", sender: "Sam" });
check("student can post", r.status === 200 && r.data.message?.name === "Sam" && r.data.message?.file_path === spath, r);
check("student file not marked as teacher's", r.data.message?.from_teacher === false, r.data);
r = await call({ action: "post", passcode: "guess", room: "tuesday-writers", path: spath, name: "student work.png", sender: "Sam" });
check("wrong passcode still posts, unmarked", r.status === 200 && r.data.message?.from_teacher === false, r.data);
store.delete(spath);
r = await call({ action: "sign", room: "made-up-room", name: "a.pdf", size: 10 });
check("room that doesn't exist refused (404)", r.status === 404, r);
r = await call({ action: "post", room: "made-up-room", path: "made-up-room/x.pdf", name: "x.pdf", sender: "Sam" });
check("post into room that doesn't exist refused", r.status === 404, r);
r = await call({ action: "sign", room: "tuesday-writers", name: "virus.exe", size: 10 });
check("student .exe refused", r.status === 400, r);
r = await call({ action: "sign", passcode: "right", room: "../etc", name: "a.pdf", size: 10 });
check("bad room name refused (400)", r.status === 400, r);
r = await call({ action: "sign", passcode: "right", room: "tuesday-writers", name: "virus.exe", size: 10 });
check(".exe refused", r.status === 400 && /isn't allowed/.test(r.data.error), r);
r = await call({ action: "sign", passcode: "right", room: "tuesday-writers", name: "big.mp4", size: 25 * 1024 * 1024 + 1 });
check("over 25 MB refused", r.status === 400 && /25 MB/.test(r.data.error), r);
r = await call({ action: "sign", passcode: "right", room: "tuesday-writers", name: "Week 3 – Notes (final).PDF", size: 1234 });
check("sign ok", r.status === 200, r);
const path = r.data.path as string;
check("path is room/uuid-safe-name", /^tuesday-writers\/[0-9a-f-]{36}-Week-3-Notes-final\.pdf$/.test(path), path);
check("signed URL has token", /\/storage\/v1\/object\/upload\/sign\/files\/.+\?token=tok123$/.test(r.data.signedUrl), r.data.signedUrl);

r = await call({ action: "post", passcode: "right", room: "tuesday-writers", path, name: "Week 3 – Notes (final).PDF", type: "application/pdf", body: "Here you go", sender: "Ms Fox" });
check("post before upload refused", r.status === 400 && /didn't arrive/.test(r.data.error), r);
store.set(path, 1234); // simulate the browser's upload
r = await call({ action: "post", passcode: "right", room: "tuesday-writers", path, name: "Week 3 – Notes (final).PDF", type: "application/pdf", body: "  Here you go ", sender: "Ms Fox" });
check("post ok", r.status === 200, r);
check("teacher's file marked as teacher's", r.data.message?.from_teacher === true, r.data);
check("message has file fields + real size", r.data.message?.file_path === path && r.data.message?.file_size === 1234 && r.data.message?.body === "Here you go" && r.data.message?.name === "Ms Fox", r.data);
r = await call({ action: "post", passcode: "right", room: "tuesday-writers", path: "other-room/x.pdf", name: "x.pdf", sender: "Ms Fox" });
check("post with another room's path refused", r.status === 400, r);
r = await call({ action: "post", passcode: "right", room: "tuesday-writers", path: "tuesday-writers/../x.pdf", name: "x.pdf", sender: "Ms Fox" });
check("post with nested path refused", r.status === 400, r);

store.set("tuesday-writers/b.png", 5); store.set("other-room/keep.png", 7);
r = await call({ action: "delete-room-files", passcode: "right", room: "tuesday-writers" });
check("delete-room-files deleted 2", r.status === 200 && r.data.deleted === 2, r);
check("other room's file kept", store.has("other-room/keep.png") && store.size === 1, [...store.keys()]);
r = await call({ action: "delete-room-files", passcode: "wrong", room: "other-room" });
check("delete with wrong passcode refused", r.status === 403 && store.size === 1, r);
r = await call({ action: "delete-room-files", room: "other-room" });
check("delete with no passcode refused", r.status === 403 && store.size === 1, r);
r = await call({ action: "nope", passcode: "right", room: "other-room" });
check("unknown action 400", r.status === 400, r);

check("safeFileName keeps extension", fn.safeFileName("..My file!!.tar.ZIP") === "My-file-.tar.zip" || fn.safeFileName("..My file!!.tar.ZIP") === "My-file.tar.zip", fn.safeFileName("..My file!!.tar.ZIP"));
check("safeFileName handles no base", fn.safeFileName(".png") === "file.png" || fn.safeFileName(".png") === "png", fn.safeFileName(".png"));
check("used secret + publishable keys (never a Bearer JWT)", seenKeys.has("sb_secret_TEST") && seenKeys.has("sb_publishable_TEST"), [...seenKeys]);

await fake.shutdown();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
Deno.exit(failures ? 1 : 0);
