(function () {
  "use strict";

  var config = window.FOX_TALES_CONFIG || {};
  var HISTORY_LIMIT = 300;
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

  function SupabaseBackend(room) {
    var client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
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

  document.querySelectorAll(".app-name").forEach(function (el) { el.textContent = config.appName || "Fox Tales"; });
  if (!useSupabase) $("demoBanner").hidden = false;

  function show(id) {
    ["screenHome", "screenName", "screenChat"].forEach(function (s) { $(s).hidden = s !== id; });
  }

  function setUpHomeScreen() {
    show("screenHome");
    var siteAddress = window.location.host + window.location.pathname.replace(/index\.html$/, "").replace(/\/$/, "");
    document.querySelectorAll(".site-address").forEach(function (el) { el.textContent = siteAddress; });
    $("joinNameInput").value = store("foxtales-name") || "";
    $("joinRoomInput").focus();

    $("joinForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var slug = slugify($("joinRoomInput").value);
      var name = $("joinNameInput").value.replace(/\s+/g, " ").trim().slice(0, 40);
      if (!slug) { $("joinRoomInput").value = ""; $("joinRoomInput").focus(); return; }
      if (!name) { $("joinNameInput").value = ""; $("joinNameInput").focus(); return; }
      store("foxtales-name", name);
      window.location.href = roomLink(slug);
    });

    $("createForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var slug = slugify($("roomInput").value);
      if (!slug) { $("roomInput").value = ""; $("roomInput").focus(); return; }
      var link = roomLink(slug);
      $("createdRoomName").textContent = prettyRoom(slug);
      $("linkOutput").value = link;
      $("openRoom").href = link;
      $("linkBox").hidden = false;
      $("linkOutput").select();
    });
    $("copyLink").addEventListener("click", function () {
      var btn = this, text = $("linkOutput").value;
      var done = function () { btn.textContent = "Copied!"; setTimeout(function () { btn.textContent = "Copy"; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { $("linkOutput").select(); document.execCommand("copy"); done(); });
      } else { $("linkOutput").select(); document.execCommand("copy"); done(); }
    });
  }

  var nameCallback = null;
  function askName(isChange) {
    show("screenName");
    $("joinRoomName").textContent = prettyRoom(room);
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
      empty.textContent = "No messages in " + prettyRoom(room) + " yet. Say hello! 👋";
      var hint = document.createElement("small");
      hint.textContent = "Expecting other people here? Check the room name with your teacher.";
      empty.appendChild(document.createElement("br"));
      empty.appendChild(hint);
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
      bubble.className = "bubble";
      fillWithLinks(bubble, m.body);
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
    var label = prettyRoom(room);
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
  function flash(text) {
    var el = $("notice");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  // ---------- start ----------

  if (!room) {
    setUpHomeScreen();
  } else {
    var title = prettyRoom(room);
    document.title = title + " · " + (config.appName || "Fox Tales");
    $("roomLabel").textContent = title;
    $("roomLabel").hidden = false;
    var savedName = store("foxtales-name");
    if (savedName) startChat(savedName); else askName(false);
  }
})();
