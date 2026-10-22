// Artemis AI homepage: live layer for sections below the hero. The hero and header are not touched here.
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var main = document.getElementById("content");
  if (!main) return;
  var below = Array.prototype.slice.call(main.querySelectorAll(":scope > section:not(.hero)"));
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function onVisible(el, cb, opts) {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { cb(true); return; }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { cb(e.isIntersecting); });
    }, opts || { threshold: 0.15 }).observe(el);
  }
  function timeET(d) {
    try { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"; }
    catch (e) { return d.toLocaleTimeString(); }
  }

  /* ---- scroll reveal ---- */
  if (!reduced && "IntersectionObserver" in window) {
    var revealSel = [".section-head", ".tablist", ".cluster-frame", ".product-copy", ".stage", ".run-card", ".resource-list li", ".close-inner", ".contact-wrap > h2", ".contact-wrap > .contact-lead", "#contact-form"];
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    below.forEach(function (section) {
      revealSel.forEach(function (sel) {
        $$(sel, section).forEach(function (el, i) {
          var r = el.getBoundingClientRect();
          if (r.top < window.innerHeight * 0.9) return; // already on screen: leave as is
          el.classList.add("reveal");
          el.style.setProperty("--rd", Math.min(i, 4) * 90 + "ms");
          io.observe(el);
        });
      });
    });
  }

  /* ---- pointer glow + press ripple (below the hero only) ---- */
  function track(el) {
    el.addEventListener("pointermove", function (ev) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (ev.clientX - r.left) + "px");
      el.style.setProperty("--my", (ev.clientY - r.top) + "px");
    });
  }
  below.forEach(function (section) {
    $$(".pill, .stage, .resource-list a", section).forEach(track);
    if (reduced) return;
    $$(".pill", section).forEach(function (pill) {
      pill.addEventListener("pointerdown", function (ev) {
        var r = pill.getBoundingClientRect();
        var dot = document.createElement("span");
        dot.className = "ripple";
        dot.style.left = (ev.clientX - r.left) + "px";
        dot.style.top = (ev.clientY - r.top) + "px";
        pill.appendChild(dot);
        setTimeout(function () { dot.remove(); }, 650);
      });
    });
  });

  /* ---- Artemis engine card: prompt, skills, memory come alive ---- */
  var engine = $("#artemis .stage");
  if (engine) {
    var sheets = $$(".sheet", engine);
    var skills = $$(".minis span", engine);
    var promptEl = $(".sheet p", engine);
    var promptText = promptEl ? promptEl.textContent : "";
    var step = 0, engineTimer = 0, typing = 0;
    function typePrompt() {
      if (!promptEl || reduced) return;
      clearInterval(typing);
      var i = 0;
      promptEl.textContent = "";
      typing = setInterval(function () {
        i += 2;
        promptEl.textContent = promptText.slice(0, i);
        if (i >= promptText.length) { promptEl.textContent = promptText; clearInterval(typing); }
      }, 28);
    }
    function engineTick() {
      sheets.forEach(function (s, i) { s.classList.toggle("is-live", i === step % 3); });
      skills.forEach(function (s, i) { s.classList.toggle("is-live", step % 3 === 1 && i === Math.floor(step / 3) % skills.length); });
      if (step % 3 === 0) typePrompt();
      step++;
    }
    skills.forEach(function (chip) {
      chip.addEventListener("pointerenter", function () { skills.forEach(function (c) { c.classList.toggle("is-live", c === chip); }); });
    });
    if (!reduced) onVisible(engine, function (vis) {
      clearInterval(engineTimer);
      if (vis) { engineTick(); engineTimer = setInterval(engineTick, 1700); }
    });
  }

  /* ---- Apollo mesh: route cycling, packets, tap/hover to pick a route ---- */
  var mesh = $("#apollo .mesh");
  if (mesh) {
    var NS = "http://www.w3.org/2000/svg";
    var lines = $$(".flows line", mesh);
    var nodes = $$(".nodes circle", mesh);
    var names = ["A", "B", "C", "D"];
    var readout = document.createElement("p");
    readout.className = "mesh-route";
    readout.setAttribute("aria-live", "polite");
    mesh.insertAdjacentElement("afterend", readout);
    var packets = lines.map(function (line, i) {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "3.2");
      c.setAttribute("fill", i % 2 ? "#3dbe78" : "#7aa2ff");
      c.setAttribute("class", "packet");
      mesh.insertBefore(c, mesh.querySelector(".hub"));
      return { el: c, line: line, t: i * 0.25 };
    });
    var active = 0, hold = 0;
    function setRoute(i, manual) {
      active = i;
      lines.forEach(function (l, j) { l.classList.toggle("is-live", j === i); });
      nodes.forEach(function (n, j) { n.classList.toggle("is-live", j === i); });
      readout.innerHTML = "Apollo routing the agent to <strong>Route " + names[i] + "</strong>" + (manual ? " (picked)" : "");
      if (manual) hold = performance.now() + 6000;
    }
    nodes.forEach(function (n, i) {
      n.addEventListener("pointerenter", function () { setRoute(i, true); });
      n.addEventListener("click", function () { setRoute(i, true); });
    });
    setRoute(0, false);
    var meshVisible = false;
    onVisible(mesh, function (v) { meshVisible = v; });
    var lastSwitch = 0;
    function meshFrame(now) {
      if (meshVisible) {
        if (now > hold && now - lastSwitch > 2400) { lastSwitch = now; setRoute((active + 1) % 4, false); }
        packets.forEach(function (p, j) {
          var speed = j === active ? 0.018 : 0.006;
          p.t = (p.t + speed) % 1;
          var x1 = +p.line.getAttribute("x1"), y1 = +p.line.getAttribute("y1");
          var x2 = +p.line.getAttribute("x2"), y2 = +p.line.getAttribute("y2");
          p.el.setAttribute("cx", (x1 + (x2 - x1) * p.t).toFixed(1));
          p.el.setAttribute("cy", (y1 + (y2 - y1) * p.t).toFixed(1));
          p.el.setAttribute("opacity", j === active ? "1" : "0.45");
        });
      }
      requestAnimationFrame(meshFrame);
    }
    if (!reduced) requestAnimationFrame(meshFrame);
    else packets.forEach(function (p) { p.el.remove(); });
  }

  /* ---- The Bow console: runs move through states ---- */
  var consoleEl = $("#the-bow .console");
  if (consoleEl && !reduced) {
    var rows = $$(".console-row:not(.head)", consoleEl);
    var states = ["Idle", "In run", "Routed", "Streaming"];
    var idx = rows.map(function (r) { return Math.max(0, states.indexOf(r.lastElementChild.textContent.trim())); });
    var paused = false, bowTimer = 0, cursor = 0;
    var ticksEl = consoleEl.parentElement.querySelector(".run-ticks");
    var ticks = [];
    if (ticksEl) for (var k = 0; k < 28; k++) { var tk = document.createElement("i"); ticksEl.appendChild(tk); ticks.push(tk); }
    rows.forEach(function (r, j) { r.lastElementChild.classList.toggle("ok", idx[j] === 1 || idx[j] === 3); });
    consoleEl.addEventListener("pointerenter", function () { paused = true; });
    consoleEl.addEventListener("pointerleave", function () { paused = false; });
    function bowTick() {
      if (paused) return;
      var r = cursor % rows.length;
      idx[r] = (idx[r] + 1) % states.length;
      var cell = rows[r].lastElementChild;
      cell.textContent = states[idx[r]];
      cell.classList.toggle("ok", idx[r] === 1 || idx[r] === 3);
      rows.forEach(function (row, j) { row.classList.toggle("is-live", j === r); });
      if (ticks.length) {
        var tk = ticks.shift(); ticksEl.appendChild(tk); ticks.push(tk);
        tk.className = "t" + idx[r];
      }
      cursor++;
    }
    onVisible(consoleEl, function (vis) {
      clearInterval(bowTimer);
      if (vis) bowTimer = setInterval(bowTick, 1400);
    });
  }

  /* ---- live gateway data (proxied same-origin by vercel.json; falls back gracefully) ---- */
  var gw = { status: null, health: null, samples: [] };
  function getJSON(path) {
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : 0;
    var t0 = performance.now();
    return fetch(path, { cache: "no-store", credentials: "include", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { clearTimeout(t); return { json: j, ms: performance.now() - t0 }; })
      .catch(function (e) { clearTimeout(t); throw e; });
  }

  /* Artemis Core card */
  var core = $("#core .core-stage");
  var coreStream = $("#core-stream");
  var coreTag = $("#core-tag"), coreLed = $("#core-led"), coreNote = $("#core-note");
  var routeNodes = $$("#core .route-node");
  var packet = $("#core .route-packet");
  var HOP_X = [34, 131, 229, 326];
  function statusWords() {
    var s = gw.status;
    if (!s) return { cls: "s-dim", text: "gateway: status not reachable from this page" };
    var parts = [s.configured ? "configured" : "not configured", s.serving ? "serving" : "not serving yet", "quality " + (s.quality || "unknown")];
    return { cls: s.serving ? "s-ok" : "s-warn", text: "gateway: " + parts.join(" \u00b7 ") };
  }
  function paintCoreStatus() {
    var s = gw.status;
    var state = s ? (s.serving ? "serving" : "online") : "down";
    if (coreTag) { coreTag.textContent = s ? (s.serving ? "Serving" : "Not serving") : "Offline"; coreTag.dataset.state = state; }
    if (coreLed) coreLed.dataset.state = state;
    if (coreNote) coreNote.textContent = s
      ? "Read live from the gateway's /api/status at " + timeET(new Date()) + "."
      : "Status comes from the gateway's /api/status. It did not answer just now.";
  }
  var LOG = [
    { hop: 0, text: "POST /api/artemis/chat", cls: "" },
    { hop: 0, text: "+ memory and knowledge snippets as context", cls: "s-dim" },
    { hop: 1, text: "try VLLM_BASE_URL  \u2192  SSE stream", cls: "" },
    { hop: 2, text: "try ARTEMIS_CORE_URL  \u2192  /v1/chat", cls: "" },
    { hop: 3, text: "else fallback stub", cls: "s-dim" },
    { hop: -1, text: null, cls: "" }
  ];
  function esc(t) { return t.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function renderLog(n, partial) {
    if (!coreStream) return;
    var html = "";
    for (var i = 0; i < n && i < LOG.length; i++) {
      var line = LOG[i].text === null ? statusWords() : LOG[i];
      var text = i === n - 1 && partial != null ? line.text.slice(0, partial) : line.text;
      html += '<span class="' + line.cls + '">' + esc(text) + "</span>\n";
    }
    coreStream.innerHTML = html.replace(/\n$/, "") + (reduced ? "" : '<span class="caret"></span>');
  }
  function lightHop(h) {
    routeNodes.forEach(function (n, i) { n.classList.toggle("is-live", i === h); });
    if (packet && h >= 0) packet.setAttribute("cx", HOP_X[h]);
  }
  if (core) {
    if (reduced) { renderLog(LOG.length); lightHop(-1); }
    else {
      var coreRun = 0, coreVisible = false;
      var line = 0, ch = 0, pause = 0, px = HOP_X[0];
      onVisible(core, function (v) { coreVisible = v; });
      var lastT = 0;
      (function coreFrame(now) {
        if (coreVisible && now - lastT > 32) {
          lastT = now;
          if (pause > 0) { pause -= 1; }
          else {
            var entry = LOG[line];
            var full = entry.text === null ? statusWords().text : entry.text;
            ch += 2;
            if (entry.hop >= 0) routeNodes.forEach(function (n, i) { n.classList.toggle("is-live", i === entry.hop); });
            renderLog(line + 1, Math.min(ch, full.length));
            if (ch >= full.length) {
              line++; ch = 0; pause = 12;
              if (line >= LOG.length) { line = 0; pause = 90; }
            }
          }
          var targetHop = LOG[line].hop >= 0 ? LOG[line].hop : 3;
          px += (HOP_X[targetHop] - px) * 0.12;
          if (packet) packet.setAttribute("cx", px.toFixed(1));
        }
        coreRun = requestAnimationFrame(coreFrame);
      })(0);
    }
    $$(".core-chips li", core).forEach(function (chip) {
      chip.addEventListener("pointerenter", function () { chip.classList.add("is-live"); });
      chip.addEventListener("pointerleave", function () { chip.classList.remove("is-live"); });
    });
  }

  /* Running: gateway card */
  var meta = $("#run-meta");
  function paintMeta() {
    if (!meta) return;
    var s = gw.status, h = gw.health;
    function set(cap, text, state) {
      var el = meta.querySelector('[data-cap="' + cap + '"]');
      if (!el) return;
      el.textContent = text;
      if (state) el.dataset.state = state; else el.removeAttribute("data-state");
    }
    if (h) set("queue", "Queue " + (h.queued || 0) + " \u00b7 generating " + (h.generating || 0), h.ok ? "on" : "off");
    else set("queue", "Health: no answer", "off");
    if (s) {
      set("model", s.serving ? "Model: serving" : "Model: not serving yet", s.serving ? "on" : "off");
      var tools = (s.capabilities && s.capabilities.tools) || {};
      set("search", "Web search: " + (tools.web_search ? tools.web_search : "off"), tools.web_search ? "on" : "off");
      set("fetch", "Web fetch: " + (tools.web_fetch ? "on" : "off"), tools.web_fetch ? "on" : "off");
      set("training", "Training collection: " + (s.training_collection ? "on" : "off"), null);
    } else {
      set("model", "Model: status unavailable", "off");
    }
  }

  var spark = $("#gw-spark"), read = $("#gw-read");
  function drawSpark() {
    if (!spark) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = spark.clientWidth, h = spark.clientHeight;
    if (!w || !h) return;
    spark.width = w * dpr; spark.height = h * dpr;
    var ctx = spark.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var data = gw.samples;
    if (!data.length) return;
    var max = Math.max.apply(null, data.map(function (d) { return d || 0; }).concat([100]));
    var n = 24, step = w / (n - 1);
    var start = n - data.length;
    ctx.lineWidth = 1.6;
    var grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#2f6fed"); grad.addColorStop(1, "#3dbe78");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    var lastX = 0, lastY = 0, started = false;
    data.forEach(function (v, i) {
      if (v == null) return;
      var x = (start + i) * step, y = h - 4 - (v / max) * (h - 10);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      lastX = x; lastY = y;
    });
    ctx.stroke();
    if (started) {
      ctx.fillStyle = "#3dbe78";
      ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.arc(lastX, lastY, 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  window.addEventListener("resize", drawSpark);

  function pollHealth() {
    return getJSON("https://api.artemisai-bycutlineindustries.studio/api/health").then(function (r) {
      gw.health = r.json;
      gw.samples.push(Math.round(r.ms));
      if (read) read.textContent = "/api/health " + (r.json.ok ? "ok" : "not ok") + " \u00b7 " + Math.round(r.ms) + " ms round trip";
    }).catch(function () {
      gw.health = null;
      gw.samples.push(null);
      if (read) read.textContent = "/api/health did not answer from this page";
    }).then(function () {
      if (gw.samples.length > 24) gw.samples.shift();
      drawSpark(); paintMeta();
    });
  }
  function pollStatus() {
    return getJSON("https://api.artemisai-bycutlineindustries.studio/api/status").then(function (r) { gw.status = r.json; })
      .catch(function () { gw.status = null; })
      .then(function () { paintMeta(); paintCoreStatus(); });
  }
  pollStatus(); pollHealth();
  var gwCard = spark ? spark.closest(".run-card") : null;
  var gwVisible = false;
  onVisible(gwCard, function (v) { gwVisible = v; });
  setInterval(function () { if (!document.hidden && gwVisible) pollHealth(); }, 5000);
  setInterval(function () { if (!document.hidden) pollStatus(); }, 60000);
})();
