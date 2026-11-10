(function () {
  "use strict";

  var config = window.FOX_TALES_CONFIG || {};
  var HISTORY_LIMIT = 300;

  // ---------- file sharing (teacher only) ----------
  // Keep in step with ALLOWED in supabase/functions/files/index.ts.
  var MAX_FILE_BYTES = 25 * 1024 * 1024;
  var FILE_KINDS = {
    image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"],
    video: ["mp4", "mov", "mpg", "mpeg", "avi", "webm"],
    audio: ["mp3", "wav", "m4a"],
    pdf: ["pdf"],
    doc: ["doc", "docx", "odt", "txt", "rtf", "md"],
    sheet: ["xls", "xlsx", "ods", "csv"],
    slides: ["ppt", "pptx", "odp"],
    design: ["psd", "ai", "indd", "idml", "fig", "eps"],
    font: ["otf", "ttf", "woff", "woff2"],
    code: ["html", "htm", "css", "js", "json"],
    archive: ["zip"],
  };
  var FILE_ICONS = { image: "🖼️", video: "🎬", audio: "🎵", pdf: "📕", doc: "📝", sheet: "📊", slides: "📽️",
    design: "🎨", font: "🔤", code: "💻", archive: "📦" };
  var ALLOWED_EXTENSIONS = [];
  Object.keys(FILE_KINDS).forEach(function (k) { ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS.concat(FILE_KINDS[k]); });

  function extensionOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function fileKind(name) {
    var ext = extensionOf(name);
    for (var k in FILE_KINDS) if (FILE_KINDS[k].indexOf(ext) !== -1) return k;
    return "other";
  }

  function formatBytes(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  // Files live on Supabase's address, not this site's, so nothing in them can reach this page.
  function fileUrl(path, downloadName) {
    var url = config.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/public/files/" +
      path.split("/").map(encodeURIComponent).join("/");
    return downloadName ? url + "?download=" + encodeURIComponent(downloadName) : url;
  }

  function callFilesFunction(payload) {
    return fetch(config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/files", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.supabaseAnonKey },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ")");
        return data;
      });
    });
  }
  var $ = function (id) { return document.getElementById(id); };

  // ---------- small helpers ----------

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  function slugify(text) {
    return String(text).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  }

  function prettyRoom(slug) {
    return slug.split("-").filter(Boolean)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }

  function randomId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function nameColour(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return "hsl(" + h + ", 55%, 38%)";
  }

  function roomLink(slug) {
    var url = new URL(window.location.href);
    url.search = "?room=" + encodeURIComponent(slug);
    url.hash = "";
    return url.toString();
  }

  // Put text into an element, turning web addresses into clickable links (safely).
  function fillWithLinks(el, text) {
    var re = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement("a");
      a.href = m[0];
      a.textContent = m[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  // ---------- backends ----------
  // Each backend provides: loadHistory(), send(name, body), join(name, handlers), rename(name),
  // checkTeacher(passcode) and clearRoom(passcode).

  var supabaseClient = null;
  function getClient() {
    if (!supabaseClient) supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    return supabaseClient;
  }

  // ---------- room list ----------
  // find(slug) resolves to { title } if the room exists, or null if it doesn't.
  // create(slug, title) resolves to { existed: true/false }.

  function SupabaseRooms() {
    this.find = function (slug) {
      var client;
      try { client = getClient(); } catch (e) { return Promise.resolve({ title: null }); }
      return client.from("rooms").select("slug, title").eq("slug", slug).maybeSingle().then(function (res) {
        // If the check itself fails (e.g. the rooms table isn't set up yet), let people in rather than block them.
        if (res.error) return { title: null };
        if (res.data) return { title: res.data.title };
        // Rooms from before the room list existed only show up as messages.
        return client.from("messages").select("id").eq("room", slug).limit(1).then(function (r) {
          return !r.error && r.data && r.data.length ? { title: null } : null;
        });
      }, function () { return { title: null }; });
    };

    this.create = function (slug, title) {
      var self = this;
      return self.find(slug).then(function (found) {
        if (found) return { existed: true };
        return getClient().from("rooms").insert({ slug: slug, title: title }).then(function (res) {
          if (res.error && res.error.code === "23505") return { existed: true };
          if (res.error) throw res.error;
          return { existed: false };
        });
      });
    };

    this.checkTeacher = function (passcode) {
      return getClient().rpc("is_teacher", { passcode: passcode }).then(function (res) {
        if (res.error) throw res.error;
        return res.data === true;
      });
    };

    // Teacher only: every room with message_count and last_message_at.
    this.list = function (passcode) {
      return getClient().rpc("list_rooms", { passcode: passcode }).then(function (res) {
        if (res.error) throw res.error;
        return res.data || [];
      });
    };

    // Teacher only: delete a room and its messages, and tell anyone inside it.
    this.remove = function (slug, passcode) {
      var client = getClient();
      return client.rpc("delete_room", { room_slug: slug, passcode: passcode }).then(function (res) {
        if (res.error) throw res.error;
        // Remove the room's files too. If that fails the room is still gone; the files are just left over.
        return callFilesFunction({ action: "delete-room-files", passcode: passcode, room: slug }).catch(function () {});
      }).then(function () {
        return new Promise(function (resolve) {
          var ch = client.channel("room:" + slug);
          var finish = function () { client.removeChannel(ch); resolve(); };
          var timer = setTimeout(finish, 4000);
          ch.subscribe(function (status) {
            if (status === "SUBSCRIBED") {
              ch.send({ type: "broadcast", event: "deleted", payload: {} }).then(function () {
                clearTimeout(timer); finish();
              }, function () { clearTimeout(timer); finish(); });
            }
          });
        });
      });
    };
  }

  function LocalRooms() {
    var key = "foxtales-demo-rooms";
    function read() { try { return JSON.parse(store(key) || "{}"); } catch (e) { return {}; } }
    this.find = function (slug) {
      var all = read();
      if (all[slug]) return Promise.resolve({ title: all[slug] });
      return Promise.resolve(store("foxtales-demo:" + slug) && store("foxtales-demo:" + slug) !== "[]" ? { title: null } : null);
    };
    this.create = function (slug, title) {
      return this.find(slug).then(function (found) {
        if (found) return { existed: true };
        var all = read(); all[slug] = title; store(key, JSON.stringify(all));
        return { existed: false };
      });
    };

    // Demo mode has no real passcode: anything typed unlocks teacher tools.
    this.checkTeacher = function (passcode) { return Promise.resolve(!!passcode); };

    this.list = function () {
      var all = read(), out = {}, i, k;
      Object.keys(all).forEach(function (slug) {
        out[slug] = { slug: slug, title: all[slug], created_at: null, message_count: 0, last_message_at: null };
      });
      try {
        for (i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (k.indexOf("foxtales-demo:") !== 0) continue;
          var slug = k.slice("foxtales-demo:".length);
          var msgs = JSON.parse(localStorage.getItem(k) || "[]");
          out[slug] = out[slug] || { slug: slug, title: prettyRoom(slug), created_at: null, message_count: 0, last_message_at: null };
          out[slug].message_count = msgs.length;
          out[slug].last_message_at = msgs.length ? msgs[msgs.length - 1].created_at : null;
        }
      } catch (e) {}
      return Promise.resolve(Object.keys(out).map(function (k) { return out[k]; }));
    };

    this.remove = function (slug) {
      var all = read(); delete all[slug]; store(key, JSON.stringify(all));
      store("foxtales-demo:" + slug, null);
      if ("BroadcastChannel" in window) {
        var bc = new BroadcastChannel("foxtales-demo:" + slug);
        bc.postMessage({ type: "deleted" });
        bc.close();
      }
      return Promise.resolve();
    };
  }

  function SupabaseBackend(room) {
    var client = getClient();
    var channel = null, myName = "", clientId = randomId();

    this.loadHistory = function () {
      return client.from("messages").select("*").eq("room", room)
        .order("created_at", { ascending: false }).limit(HISTORY_LIMIT)
        .then(function (res) {
          if (res.error) throw res.error;
          return res.data.reverse();
        });
    };

    this.send = function (name, body) {
      return client.from("messages").insert({ room: room, name: name, body: body })
        .select().single()
        .then(function (res) { if (res.error) throw res.error; return res.data; });
    };

    this.join = function (name, h) {
      myName = name;
      channel = client.channel("room:" + room, { config: { presence: { key: clientId } } });
      channel
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: "room=eq." + room },
          function (payload) { h.onMessage(payload.new); })
        .on("broadcast", { event: "cleared" }, function () { h.onCleared(); })
        .on("broadcast", { event: "deleted" }, function () { h.onDeleted(); })
        .on("presence", { event: "sync" }, function () {
          var state = channel.presenceState(), names = [];
          Object.keys(state).forEach(function (k) {
            if (state[k][0] && state[k][0].name) names.push(state[k][0].name);
          });
          h.onPresence(names);
        })
        .subscribe(function (status) {
          if (status === "SUBSCRIBED") {
            channel.track({ name: myName });
            h.onConnection(true);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            h.onConnection(false);
          }
        });
    };

    this.rename = function (name) {
      myName = name;
      if (channel) channel.track({ name: name });
    };

    this.checkTeacher = function (passcode) {
      return client.rpc("is_teacher", { passcode: passcode }).then(function (res) {
        if (res.error) throw res.error;
        return res.data === true;
      });
    };

    this.clearRoom = function (passcode) {
      return client.rpc("clear_room", { room_name: room, passcode: passcode }).then(function (res) {
        if (res.error) throw res.error;
        // Tell everyone else in the room to empty their screens.
        if (channel) channel.send({ type: "broadcast", event: "cleared", payload: {} });
        return callFilesFunction({ action: "delete-room-files", passcode: passcode, room: room }).catch(function () {});
      });
    };
  }

  // Demo mode: no server, shares messages between tabs in this browser only.
  function LocalBackend(room) {
    var key = "foxtales-demo:" + room;
    var bc = "BroadcastChannel" in window ? new BroadcastChannel(key) : null;
    var me = randomId(), myName = "", peers = {}, handlers = null;

    function read() {
      try { return JSON.parse(store(key) || "[]"); } catch (e) { return []; }
    }

    this.loadHistory = function () { return Promise.resolve(read().slice(-HISTORY_LIMIT)); };

    this.send = function (name, body) {
      var all = read();
      var msg = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), room: room,
        name: name, body: body, created_at: new Date().toISOString() };
      all.push(msg);
      store(key, JSON.stringify(all.slice(-HISTORY_LIMIT)));
      if (bc) bc.postMessage({ type: "message", msg: msg });
      return Promise.resolve(msg);
    };

    function announce() {
      if (bc) bc.postMessage({ type: "here", id: me, name: myName });
    }

    function reportPeople() {
      var now = Date.now(), names = [myName];
      Object.keys(peers).forEach(function (id) {
        if (now - peers[id].seen < 8000) names.push(peers[id].name); else delete peers[id];
      });
      handlers.onPresence(names);
    }

    this.join = function (name, h) {
      myName = name; handlers = h;
      if (bc) bc.onmessage = function (e) {
        var d = e.data;
        if (d.type === "message") h.onMessage(d.msg);
        if (d.type === "here") { var isNew = !peers[d.id]; peers[d.id] = { name: d.name, seen: Date.now() }; if (isNew) announce(); reportPeople(); }
        if (d.type === "bye") { delete peers[d.id]; reportPeople(); }
        if (d.type === "cleared") h.onCleared();
        if (d.type === "deleted") h.onDeleted();
      };
      window.addEventListener("beforeunload", function () { if (bc) bc.postMessage({ type: "bye", id: me }); });
      announce();
      setInterval(function () { announce(); reportPeople(); }, 3000);
      reportPeople();
      h.onConnection(true);
    };

    this.rename = function (name) { myName = name; announce(); reportPeople(); };

    // Demo mode has no real passcode: anything typed unlocks teacher tools.
    this.checkTeacher = function (passcode) { return Promise.resolve(!!passcode); };

    this.clearRoom = function () {
      store(key, null);
      if (bc) bc.postMessage({ type: "cleared" });
      return Promise.resolve();
    };
  }

  // ---------- screens ----------

  var params = new URLSearchParams(window.location.search);
  var room = slugify(params.get("room") || "");
  var useSupabase = !!(config.supabaseUrl && config.supabaseAnonKey);
  var rooms = useSupabase ? new SupabaseRooms() : new LocalRooms();
  var roomTitle = prettyRoom(room);

  document.querySelectorAll(".app-name").forEach(function (el) { el.textContent = config.appName || "Fox Tales"; });
  if (!useSupabase) $("demoBanner").hidden = false;

  function show(id) {
    ["screenHome", "screenNotFound", "screenName", "screenChat", "screenManage"].forEach(function (s) { $(s).hidden = s !== id; });
  }

  function setUpHomeScreen() {
    show("screenHome");
    var siteAddress = window.location.host + window.location.pathname.replace(/index\.html$/, "").replace(/\/$/, "");
    document.querySelectorAll(".site-address").forEach(function (el) { el.textContent = siteAddress; });
    $("joinNameInput").value = store("foxtales-name") || "";
    var retry = /^#join=(.*)$/.exec(window.location.hash);
    if (retry) {
      $("joinRoomInput").value = decodeURIComponent(retry[1]);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    $("joinRoomInput").focus();
    if (retry) $("joinRoomInput").select();

    $("joinForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var slug = slugify($("joinRoomInput").value);
      var name = $("joinNameInput").value.replace(/\s+/g, " ").trim().slice(0, 40);
      if (!slug) { $("joinRoomInput").value = ""; $("joinRoomInput").focus(); return; }
      if (!name) { $("joinNameInput").value = ""; $("joinNameInput").focus(); return; }
      store("foxtales-name", name);
      var btn = $("joinForm").querySelector("button");
      btn.disabled = true;
      btn.textContent = "Checking…";
      rooms.find(slug).then(function (found) {
        btn.disabled = false;
        btn.textContent = "Join room";
        if (found) window.location.href = roomLink(slug);
        else showNotFound(slug, $("joinRoomInput").value.trim());
      });
    });

    $("createForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var typed = $("roomInput").value.replace(/\s+/g, " ").trim();
      var slug = slugify(typed);
      if (!slug) { $("roomInput").value = ""; $("roomInput").focus(); return; }
      var btn = $("createForm").querySelector("button");
      btn.disabled = true;
      $("createError").hidden = true;
      rooms.create(slug, typed.slice(0, 64)).then(function (result) {
        btn.disabled = false;
        var link = roomLink(slug);
        $("createdRoomName").textContent = typed;
        $("roomExisted").hidden = !result.existed;
        $("linkOutput").value = link;
        $("openRoom").href = link;
        $("linkBox").hidden = false;
        $("linkOutput").select();
      }, function () {
        btn.disabled = false;
        $("createError").textContent = "Couldn't create the room. Please check your internet connection and try again.";
        $("createError").hidden = false;
      });
    });
    $("copyLink").addEventListener("click", function () {
      var btn = this, text = $("linkOutput").value;
      var done = function () { btn.textContent = "Copied!"; setTimeout(function () { btn.textContent = "Copy"; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { $("linkOutput").select(); document.execCommand("copy"); done(); });
      } else { $("linkOutput").select(); document.execCommand("copy"); done(); }
    });
  }

  function showRoomClosed() {
    showNotFound(room, roomTitle);
    $("notFoundTitle").textContent = "Room closed";
    $("notFoundLead").textContent = "Your teacher has closed " + roomTitle + ".";
    $("notFoundHelp").textContent = "Ask your teacher which room to join next.";
    $("notFoundCreate").hidden = true;
    $("roomLabel").hidden = true;
  }

  function showNotFound(slug, typed) {
    show("screenNotFound");
    $("notFoundName").textContent = typed || prettyRoom(slug);
    $("notFoundRetry").href = "./#join=" + encodeURIComponent(typed || prettyRoom(slug));
    $("notFoundRetry").onclick = function (e) {
      if (room) return; // came from a direct link: the href reloads the home page
      e.preventDefault(); // already on the home page: just go back to it
      show("screenHome");
      $("joinRoomInput").focus();
      $("joinRoomInput").select();
    };
    $("notFoundCreate").onclick = function () {
      var btn = this;
      btn.disabled = true;
      rooms.create(slug, prettyRoom(slug)).then(function () {
        window.location.href = roomLink(slug);
      }, function () {
        btn.disabled = false;
        $("notFoundError").hidden = false;
      });
    };
    $("notFoundRetry").focus();
  }

  var nameCallback = null;
  function askName(isChange) {
    show("screenName");
    $("joinRoomName").textContent = roomTitle;
    $("nameInput").value = isChange ? (store("foxtales-name") || "") : "";
    $("nameForm").querySelector("button").textContent = isChange ? "Save name" : "Join the chat";
    $("nameInput").focus();
    nameCallback = isChange ? renameTo : startChat;
  }
  $("nameForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("nameInput").value.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) { $("nameInput").focus(); return; }
    store("foxtales-name", name);
    if (nameCallback) nameCallback(name);
  });

  // ---------- chat ----------

  var backend = null, myName = "", messages = [], pending = [], started = false;

  function startChat(name) {
    myName = name;
    show("screenChat");
    if (started) return;
    started = true;
    try {
      backend = useSupabase ? new SupabaseBackend(room) : new LocalBackend(room);
    } catch (err) {
      setStatus("Couldn't start the chat. Please check your internet connection and refresh the page.");
      return;
    }
    refreshHistory();
    var wasConnected = false;
    backend.join(myName, {
      onMessage: addMessage,
      onPresence: showPeople,
      onDeleted: showRoomClosed,
      onCleared: function () {
        messages = [];
        render(true);
        setStatus("");
        flash("The teacher cleared the room.");
      },
      onConnection: function (ok) {
        if (ok) {
          setStatus("");
          if (wasConnected) refreshHistory(); // catch up after a dropped connection
          wasConnected = true;
        } else {
          setStatus("Reconnecting… new messages may be delayed.");
        }
      },
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshHistory(); // e.g. laptop woke from sleep
    });
    restoreTeacher();
    $("messageInput").focus();
  }

  function renameTo(name) {
    myName = name;
    if (backend) backend.rename(name);
    show("screenChat");
    render(true);
    $("messageInput").focus();
  }
  $("changeName").addEventListener("click", function () { askName(true); });

  function refreshHistory() {
    backend.loadHistory().then(function (rows) {
      // Replace what we have (so cleared messages disappear), but keep anything
      // that arrived live while the request was in flight.
      var newest = rows.length ? rows[rows.length - 1].created_at : "";
      var arrivedSince = messages.filter(function (m) { return m.created_at > newest; });
      messages = [];
      rows.concat(arrivedSince).forEach(addMessageQuiet);
      render(true);
    }, function () {
      setStatus("Couldn't load earlier messages. Try refreshing the page.");
    });
  }

  function addMessageQuiet(msg) {
    for (var i = 0; i < messages.length; i++) if (messages[i].id === msg.id) return false;
    // If this is the server copy of something I just sent, drop the placeholder.
    for (var j = 0; j < pending.length; j++) {
      if (pending[j].name === msg.name && pending[j].body === msg.body && !pending[j].failed) {
        pending.splice(j, 1); break;
      }
    }
    messages.push(msg);
    messages.sort(function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id; });
    return true;
  }

  function addMessage(msg) {
    if (addMessageQuiet(msg)) render(false, msg.name === myName);
  }

  function setStatus(text) {
    $("status").textContent = text;
    $("status").hidden = !text;
  }

  function showPeople(names) {
    var unique = Array.from(new Set(names)).sort(function (a, b) { return a.localeCompare(b); });
    var list = $("peopleList");
    list.textContent = "";
    unique.forEach(function (n) {
      var li = document.createElement("li");
      var dot = document.createElement("span"); dot.className = "dot";
      var label = document.createElement("span"); label.textContent = n + (n === myName ? " (you)" : "");
      li.appendChild(dot); li.appendChild(label);
      list.appendChild(li);
    });
    $("peopleCount").textContent = "(" + unique.length + ")";
  }

  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

  function render(forceBottom, mineJustArrived) {
    var box = $("messages");
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.textContent = "";

    var all = messages.concat(pending);
    if (!all.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No messages in " + roomTitle + " yet. Say hello! 👋";
      box.appendChild(empty);
      return;
    }

    var lastDay = "";
    all.forEach(function (m) {
      var when = new Date(m.created_at);
      var day = when.toDateString();
      if (day !== lastDay) {
        var sep = document.createElement("div");
        sep.className = "day";
        sep.textContent = day === new Date().toDateString() ? "Today" : dayFmt.format(when);
        box.appendChild(sep);
        lastDay = day;
      }
      var wrap = document.createElement("div");
      wrap.className = "msg" + (m.name === myName ? " mine" : "") + (m.pending ? " pending" : "") + (m.failed ? " failed" : "");
      var meta = document.createElement("div");
      meta.className = "meta";
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = m.name;
      if (m.name !== myName) who.style.color = nameColour(m.name);
      meta.appendChild(who);
      meta.appendChild(document.createTextNode(" · " + (m.failed ? "not sent" : m.pending ? "sending…" : timeFmt.format(when))));
      var bubble = document.createElement("div");
      bubble.className = "bubble" + (m.file_path ? " has-file" : "");
      if (m.file_path) bubble.appendChild(attachmentFor(m));
      if (m.body) {
        var text = document.createElement("div");
        text.className = "text";
        fillWithLinks(text, m.body);
        bubble.appendChild(text);
      }
      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      if (m.failed) {
        var retry = document.createElement("button");
        retry.className = "link-button";
        retry.textContent = "Try again";
        retry.addEventListener("click", function () {
          pending.splice(pending.indexOf(m), 1);
          sendMessage(m.body);
        });
        wrap.appendChild(retry);
      }
      box.appendChild(wrap);
    });

    if (forceBottom || nearBottom || mineJustArrived) box.scrollTop = box.scrollHeight;
  }

  // Built once per message and reused, so images don't reload every time the chat redraws.
  var attachmentCache = {};
  function attachmentFor(m) {
    if (attachmentCache[m.id]) return attachmentCache[m.id];
    var kind = fileKind(m.file_name), el;
    if (kind === "image") {
      el = document.createElement("a");
      el.className = "attachment image";
      el.href = fileUrl(m.file_path);
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.title = m.file_name;
      var img = document.createElement("img");
      img.src = fileUrl(m.file_path);
      img.alt = m.file_name;
      img.loading = "lazy";
      img.addEventListener("load", function () {
        var box = $("messages");
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
      });
      el.appendChild(img);
    } else {
      // PDFs, videos and audio open in the browser; everything else downloads.
      var opens = kind === "pdf" || ((kind === "video" || kind === "audio") && ["mpg", "mpeg", "avi"].indexOf(extensionOf(m.file_name)) === -1);
      el = document.createElement("a");
      el.className = "attachment file";
      el.href = opens ? fileUrl(m.file_path) : fileUrl(m.file_path, m.file_name);
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      var icon = document.createElement("span");
      icon.className = "file-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = FILE_ICONS[kind] || "📎";
      var info = document.createElement("span");
      info.className = "file-info";
      var name = document.createElement("span");
      name.className = "file-name";
      name.textContent = m.file_name;
      var meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent = [extensionOf(m.file_name).toUpperCase(), formatBytes(m.file_size), opens ? "Open" : "Download"]
        .filter(Boolean).join(" · ");
      info.appendChild(name);
      info.appendChild(meta);
      el.appendChild(icon);
      el.appendChild(info);
    }
    attachmentCache[m.id] = el;
    return el;
  }

  function sendMessage(body) {
    var temp = { id: "tmp-" + randomId(), name: myName, body: body, created_at: new Date().toISOString(), pending: true };
    pending.push(temp);
    render(true);
    backend.send(myName, body).then(function (row) {
      var i = pending.indexOf(temp);
      if (i !== -1) pending.splice(i, 1);
      addMessageQuiet(row);
      render(false, true);
    }, function () {
      temp.pending = false;
      temp.failed = true;
      render(false, true);
    });
  }

  var input = $("messageInput");
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 4, 160) + "px";
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit ? $("composer").requestSubmit() : $("sendButton").click();
    }
  });
  $("composer").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body || !backend) return;
    sendMessage(body.slice(0, 2000));
    input.value = "";
    autosize();
    input.focus();
  });

  // ---------- teacher tools ----------

  var teacherPasscode = "";

  function setTeacherMode(on) {
    $("attachButton").hidden = !on;
    $("teacherLocked").hidden = on;
    $("teacherUnlocked").hidden = !on;
    $("teacherForm").hidden = true;
  }

  function restoreTeacher() {
    var saved = store("foxtales-teacher");
    if (!saved) return;
    backend.checkTeacher(saved).then(function (ok) {
      if (ok) { teacherPasscode = saved; setTeacherMode(true); }
      else store("foxtales-teacher", null);
    }, function () {});
  }

  $("teacherOpen").addEventListener("click", function () {
    $("teacherForm").hidden = false;
    $("teacherError").hidden = true;
    $("teacherPass").value = "";
    $("teacherPass").focus();
  });

  $("teacherForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var pass = $("teacherPass").value;
    if (!pass || !backend) return;
    var btn = $("teacherForm").querySelector("button");
    btn.disabled = true;
    backend.checkTeacher(pass).then(function (ok) {
      btn.disabled = false;
      if (!ok) {
        $("teacherError").textContent = "That passcode isn't right.";
        $("teacherError").hidden = false;
        return;
      }
      teacherPasscode = pass;
      store("foxtales-teacher", pass);
      setTeacherMode(true);
    }, function () {
      btn.disabled = false;
      $("teacherError").textContent = "Couldn't check the passcode. Is the internet working?";
      $("teacherError").hidden = false;
    });
  });

  $("teacherLeave").addEventListener("click", function () {
    teacherPasscode = "";
    store("foxtales-teacher", null);
    setTeacherMode(false);
  });

  $("clearRoom").addEventListener("click", function () {
    var label = roomTitle;
    if (!window.confirm("Delete all messages in \"" + label + "\" for everyone?\n\nThis can't be undone.")) return;
    var btn = this;
    btn.disabled = true;
    backend.clearRoom(teacherPasscode).then(function () {
      btn.disabled = false;
      messages = [];
      pending = [];
      render(true);
      flash("Room cleared.");
    }, function () {
      btn.disabled = false;
      flash("Couldn't clear the room. Please try again.");
    });
  });

  var flashTimer = null;
  function flash(text, duration) {
    var el = $("notice");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, duration || 4000);
  }

  // ---------- sending files (teacher) ----------

  $("fileInput").setAttribute("accept", ALLOWED_EXTENSIONS.map(function (e) { return "." + e; }).join(","));
  $("attachButton").addEventListener("click", function () {
    if (!useSupabase) { flash("Sharing files needs the live Supabase setup."); return; }
    $("fileInput").click();
  });
  $("fileInput").addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = "";
    if (files.length) sendFiles(files);
  });

  // Drag a file onto the chat (teacher mode only).
  var conversation = document.querySelector(".conversation");
  var dragDepth = 0;
  function dragHasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; }
  conversation.addEventListener("dragenter", function (e) {
    if (!teacherPasscode || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    conversation.classList.add("dropping");
  });
  conversation.addEventListener("dragover", function (e) {
    if (teacherPasscode && dragHasFiles(e)) e.preventDefault();
  });
  conversation.addEventListener("dragleave", function () {
    if (dragDepth && --dragDepth === 0) conversation.classList.remove("dropping");
  });
  conversation.addEventListener("drop", function (e) {
    if (!teacherPasscode || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    conversation.classList.remove("dropping");
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (!files.length) return;
    if (!useSupabase) { flash("Sharing files needs the live Supabase setup."); return; }
    sendFiles(files);
  });

  var MAX_FILES_AT_ONCE = 10;
  var uploading = false;

  function fileProblem(file) {
    var ext = extensionOf(file.name);
    if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
      return ext ? "." + ext + " files can't be shared" : "files without an extension can't be shared";
    }
    if (file.size > MAX_FILE_BYTES) return "it's " + formatBytes(file.size) + " and the limit is 25 MB";
    if (file.size === 0) return "it's empty";
    return "";
  }

  // Share several files one after another, each as its own message.
  // Problem files are skipped and listed at the end; typed text goes with the first file that's shared.
  function sendFiles(files) {
    if (uploading) { flash("Please wait for the current upload to finish."); return; }
    var skipped = [], ok = [];
    files.forEach(function (f) {
      var problem = fileProblem(f);
      if (problem) skipped.push(f.name + " (" + problem + ")"); else ok.push(f);
    });
    if (ok.length > MAX_FILES_AT_ONCE) {
      skipped.push((ok.length - MAX_FILES_AT_ONCE) + " more (you can share up to " + MAX_FILES_AT_ONCE + " files at a time)");
      ok = ok.slice(0, MAX_FILES_AT_ONCE);
    }
    if (!ok.length) {
      flash("Couldn't share " + skipped.join(", ") + ".", 10000);
      return;
    }

    var caption = input.value.trim().slice(0, 2000);
    var shared = 0, i = 0;
    uploading = true;

    function next() {
      if (i >= ok.length) {
        uploading = false;
        hideUpload();
        if (skipped.length) {
          flash((shared ? "Shared " + shared + " of " + files.length + " files. " : "") +
            "Not shared: " + skipped.join(", ") + ".", 12000);
        }
        return;
      }
      var file = ok[i];
      var label = ok.length > 1 ? (i + 1) + " of " + ok.length + ": " : "";
      uploadOne(file, label, caption).then(function (message) {
        shared++;
        if (caption) {
          // The caption went with this file; clear it so it isn't repeated.
          if (input.value.trim() === caption) { input.value = ""; autosize(); }
          caption = "";
        }
        if (message && addMessageQuiet(message)) render(false, true);
      }, function (err) {
        skipped.push(file.name + " (" + (err && err.message ? err.message.replace(/\.$/, "") : "upload failed") + ")");
      }).then(function () {
        i++;
        next();
      });
    }
    next();
  }

  function uploadOne(file, label, caption) {
    showUpload(label + file.name, 0);
    return callFilesFunction({ action: "sign", passcode: teacherPasscode, room: room, name: file.name, size: file.size })
      .then(function (signed) {
        return putFile(signed.signedUrl, file, label).then(function () { return signed.path; });
      })
      .then(function (path) {
        showUpload(label + file.name, 100, "Posting…");
        return callFilesFunction({ action: "post", passcode: teacherPasscode, room: room, path: path,
          name: file.name, type: file.type || "", body: caption, sender: myName });
      })
      .then(function (result) { return result.message; });
  }

  // Upload straight to storage with progress (the signed URL allows exactly one upload).
  function putFile(signedUrl, file, label) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("PUT", signedUrl);
      xhr.setRequestHeader("apikey", config.supabaseAnonKey);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.setRequestHeader("cache-control", "max-age=3600");
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) showUpload((label || "") + file.name, Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(xhr.status === 413 ? "the file is too big." : "the upload failed (" + xhr.status + ")."));
      };
      xhr.onerror = function () { reject(new Error("the upload was interrupted. Is the internet working?")); };
      xhr.send(file);
    });
  }

  function showUpload(name, percent, label) {
    $("upload").hidden = false;
    $("uploadName").textContent = name;
    $("uploadStatus").textContent = label || percent + "%";
    $("uploadBar").style.width = percent + "%";
  }
  function hideUpload() { $("upload").hidden = true; }

  // ---------- manage rooms (teacher) ----------

  var dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

  function setUpManageScreen() {
    show("screenManage");
    document.title = "Manage rooms · " + (config.appName || "Fox Tales");
    var saved = store("foxtales-teacher");
    if (saved) {
      rooms.checkTeacher(saved).then(function (ok) {
        if (ok) loadRoomList(saved); else { store("foxtales-teacher", null); showManageLock(); }
      }, function () { showManageLock("Couldn't check the passcode. Is the internet working?"); });
    } else {
      showManageLock();
    }

    $("manageForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var pass = $("managePass").value;
      if (!pass) return;
      var btn = $("manageForm").querySelector("button");
      btn.disabled = true;
      rooms.checkTeacher(pass).then(function (ok) {
        btn.disabled = false;
        if (!ok) { showManageLock("That passcode isn't right."); return; }
        store("foxtales-teacher", pass);
        loadRoomList(pass);
      }, function () {
        btn.disabled = false;
        showManageLock("Couldn't check the passcode. Is the internet working?");
      });
    });

    $("manageLock").addEventListener("click", function () {
      store("foxtales-teacher", null);
      showManageLock();
    });
  }

  function showManageLock(error) {
    $("manageLocked").hidden = false;
    $("manageUnlocked").hidden = true;
    $("manageError").textContent = error || "";
    $("manageError").hidden = !error;
    $("managePass").value = "";
    $("managePass").focus();
  }

  function loadRoomList(pass) {
    $("manageLocked").hidden = true;
    $("manageUnlocked").hidden = false;
    var list = $("roomList");
    list.textContent = "";
    $("roomListStatus").textContent = "Loading rooms…";
    $("roomListStatus").hidden = false;
    rooms.list(pass).then(function (rows) {
      rows.sort(function (a, b) {
        return String(b.last_message_at || b.created_at || "").localeCompare(String(a.last_message_at || a.created_at || ""));
      });
      $("roomListStatus").hidden = !!rows.length;
      $("roomListStatus").textContent = "There are no rooms yet. Make one from the home page.";
      rows.forEach(function (r) { list.appendChild(roomRow(r, pass)); });
    }, function () {
      $("roomListStatus").textContent = "Couldn't load the rooms. Please refresh the page to try again.";
    });
  }

  function roomRow(r, pass) {
    var li = document.createElement("li");
    var info = document.createElement("div");
    info.className = "room-info";
    var a = document.createElement("a");
    a.href = roomLink(r.slug);
    a.textContent = r.title || prettyRoom(r.slug);
    var meta = document.createElement("div");
    meta.className = "room-meta";
    var count = Number(r.message_count) || 0;
    var parts = [count === 0 ? "No messages" : count === 1 ? "1 message" : count + " messages"];
    if (r.last_message_at) parts.push("last used " + dateFmt.format(new Date(r.last_message_at)));
    else if (r.created_at) parts.push("made " + dateFmt.format(new Date(r.created_at)));
    meta.textContent = parts.join(" · ");
    info.appendChild(a);
    info.appendChild(meta);
    var del = document.createElement("button");
    del.type = "button";
    del.className = "danger small";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete " + a.textContent);
    del.addEventListener("click", function () {
      var what = count === 0 ? "" : count === 1 ? " and its 1 message" : " and all " + count + " messages";
      if (!window.confirm("Delete \"" + a.textContent + "\"" + what + "?\n\nAnyone in the room will be told it's closed. This can't be undone.")) return;
      del.disabled = true;
      del.textContent = "Deleting…";
      rooms.remove(r.slug, pass).then(function () {
        li.remove();
        if (!$("roomList").children.length) {
          $("roomListStatus").textContent = "There are no rooms yet. Make one from the home page.";
          $("roomListStatus").hidden = false;
        }
      }, function () {
        del.disabled = false;
        del.textContent = "Delete";
        window.alert("Couldn't delete the room. Please try again.");
      });
    });
    li.appendChild(info);
    li.appendChild(del);
    return li;
  }

  // ---------- start ----------

  if (!room && params.has("manage")) {
    setUpManageScreen();
  } else if (!room) {
    setUpHomeScreen();
  } else {
    rooms.find(room).then(function (found) {
      if (!found) { showNotFound(room, prettyRoom(room)); return; }
      if (found.title) roomTitle = found.title;
      document.title = roomTitle + " · " + (config.appName || "Fox Tales");
      $("roomLabel").textContent = roomTitle;
      $("roomLabel").hidden = false;
      var savedName = store("foxtales-name");
      if (savedName) startChat(savedName); else askName(false);
    });
  }
})();
