(() => {
function initShellRouter() {
  const views = [...document.querySelectorAll("main .view")];
  const navLinks = document.getElementById("navLinks");
  const menuBtn = document.getElementById("menuBtn");
  if (!views.length || !navLinks || !menuBtn) return;
  const names = new Set(views.map(v => v.dataset.view));
  function pathName() {
    const path = location.pathname.replace(/\/index\.html$/, "");
    if (path === "/account" || path === "/account/") return "account";
    if (path === "/products" || path === "/products/") return "products";
    if (path === "/chat" || path === "/chat/") return "chat";
    return "";
  }
  function show(name, push) {
    if (!names.has(name)) name = document.body.dataset.start || "chat";
    views.forEach(v => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll(".nav-links [data-go]").forEach(b => {
      if (b.dataset.go === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    navLinks.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    const urls = { chat: "/chat/", products: "/products/", account: "/account/" };
    if (push) {
      const panel = new URLSearchParams(location.search).get("panel");
      const next = (urls[name] || "/chat/") + (name === "chat" && panel ? "?panel=" + encodeURIComponent(panel) : "");
      try { history.pushState(null, "", next); } catch (e) {}
      window.scrollTo(0, 0);
    }
    document.title = name === "account" ? "Sign in · Artemis AI" : name === "products" ? "Products · Artemis AI" : "Chat · Artemis AI";
  }
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => show(b.dataset.go, true)));
  menuBtn.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("popstate", () => show(pathName() || document.body.dataset.start || "chat", false));
  const hash = location.hash.slice(1);
  show(pathName() || (names.has(hash) ? hash : "") || document.body.dataset.start || "chat", false);
}
if (!document.getElementById("chipsTrack")) {
  initShellRouter();
  return;
}

const ICONS = ['<path d="M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3"/><path d="M8 3h8"/>', '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>', '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>', '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>', '<path d="M4 6h16M4 12h10M4 18h7"/>'];
document.getElementById("chipsTrack").innerHTML = ICONS.concat(ICONS).map((ic, i) => `<span class="chip${i % 5 === 3 ? " dark" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${ic}</svg></span>`).join("");
const MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 20 12 3l8 17"/><path d="M7.5 13h9"/><circle cx="12" cy="3" r="1.1" fill="currentColor"/></svg>';
const posts = [
{ date: "Sample · Cycle 3", title: "Wider attention heads beat deeper layers at 350M", body: "Kept exp-004. Eval loss fell from 3.31 to 3.12 at the same compute.", tag: "kept" },
{ date: "Sample · Cycle 2", title: "Code share raised to 30% of the data mix", body: "Small gain on code tasks, no loss on general text. Kept for the next cycle.", tag: "kept" },
{ date: "Sample · Cycle 1", title: "First 125M run: the pipeline works end to end", body: "Data, tokenizer, training, checkpoint, resume and scoring all completed without manual steps.", tag: "milestone" },
];
const exps = [
["exp-006", "Longer warmup, 350M", "350M", "3.05*", "$4,120", "run"],
["exp-005", "Learning rate ×2", "350M", "3.48", "$3,960", "drop"],
["exp-004", "Wider attention heads", "350M", "3.12", "$4,010", "kept"],
["exp-003", "Deeper network, 24 layers", "350M", "3.31", "$4,300", "drop"],
["exp-002", "30% code in data mix", "125M", "3.74", "$1,050", "kept"],
["exp-001", "Baseline 125M", "125M", "3.89", "$800", "kept"],
];
const labels = { run: "Running", kept: "Kept", drop: "Dropped", fail: "Failed", queue: "Queued" };
const reports = [
{ t: "Cycle 3 · exp-004 promoted", items: ["Wider heads lowered eval loss 3.31 → 3.12.", "Deeper network (exp-003) cost 7% more and scored worse.", "Next: test a longer warmup on the promoted design."] },
{ t: "Cycle 2 · data mix", items: ["Raising code to 30% helped code tasks and held general scores.", "Next: scale to 350M with the new mix."] },
{ t: "Cycle 1 · pipeline validated", items: ["125M baseline trained, checkpointed, resumed after a forced restart.", "Scoring suite ran on held-out data."] },
];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const postHTML = p => `<article class="post"><span class="tag">${esc(p.date)}</span><div><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p></div><span class="tag">${esc(p.tag)}</span></article>`;
document.getElementById("homePosts").innerHTML = posts.map((p, i) => `<article class="car-card"><div class="media media-sm"><canvas class="fx" data-fx="${i % 2 ? "orb" : "stars"}" aria-hidden="true"></canvas><span class="car-title">${esc(p.date.replace("Sample · ", ""))}</span></div><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p><span class="tag">Sample · ${esc(p.tag)}</span></article>`).join("");
document.getElementById("allPosts").innerHTML = posts.map(postHTML).join("");
document.getElementById("expRows").innerHTML = exps.map(r => `<tr><td class="mono">${r[0]}</td><td>${esc(r[1])}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td><td class="num">${r[4]}</td><td><span class="pill ${r[5]}">${labels[r[5]]}</span></td></tr>`).join("") + `<tr><td colspan="6" style="color:var(--muted);font-size:12px;white-space:normal">* Live value while training. Sample data.</td></tr>`;
document.getElementById("reportList").innerHTML = reports.map(r => `<div class="panel report"><div class="panel-head"><h3>${esc(r.t)}</h3><span class="eyebrow">Sample</span></div><ul>${r.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>`).join("");
(function chart() {
const svg = document.getElementById("lossChart");
const W = 640, H = 220, L = 40, R = 16, T = 12, B = 30;
const xMax = 20000, yMin = 2.5, yMax = 7;
const x = v => L + (v / xMax) * (W - L - R);
const y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
const pts = [];
for (let s = 0; s <= 18400; s += 400) pts.push([s, 3.0 + 3.8 * Math.exp(-s / 3200) + 0.04 * Math.sin(s / 900)]);
const line = pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join(" ");
const area = line + ` L${x(pts.at(-1)[0]).toFixed(1)} ${y(yMin)} L${x(0)} ${y(yMin)} Z`;
let g = "";
[3, 4, 5, 6, 7].forEach(v => { g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`; });
[0, 5000, 10000, 15000, 20000].forEach(v => { g += `<text class="axis" x="${x(v)}" y="${H - 8}" text-anchor="middle">${v / 1000}k</text>`; });
const end = pts.at(-1);
svg.innerHTML = g + `<path class="area" d="${area}"/>` + `<line class="l2" x1="${L}" x2="${W - R}" y1="${y(3.12)}" y2="${y(3.12)}"/>` + `<path class="l1" d="${line}"/>` + `<circle class="dot" cx="${x(end[0])}" cy="${y(end[1])}" r="4"/>` + `<text class="axis" x="${x(end[0]) - 8}" y="${y(end[1]) - 10}" text-anchor="end">${end[1].toFixed(2)}</text>`;
})();
const lines = [
["t", "[14:02:11]"], ["hl", " engine"], ["", "  selected exp-006 (UCB score 0.81): longer warmup on exp-004 design\n"],
["t", "[14:02:14]"], ["hl", " azure "], ["", "  vm artemis-train-01 running · 8× H100 · InfiniBand ok\n"],
["t", "[14:02:40]"], ["hl", " data  "], ["", "  shard manifest v12 · 30% code · fingerprint 9f3c…a1\n"],
["t", "[15:18:02]"], ["hl", " train "], ["", "  step 10,000 · loss 3.41 · 412k tok/s · checkpoint saved\n"],
["t", "[16:31:47]"], ["wn", " train "], ["", "  node restart detected · resuming from step 12,000\n"],
["t", "[16:33:05]"], ["ok", " train "], ["", "  resumed · loss 3.33 matches pre-restart\n"],
["t", "[17:44:20]"], ["hl", " eval  "], ["", "  held-out loss 3.05 · current model 3.12 · candidate ahead\n"],
["t", "[17:44:21]"], ["hl", " guard "], ["", "  month spend $18,240 / $2,000,000 · within cap\n"],
];
document.getElementById("term").innerHTML = `<span class="t"># Sample log</span>\n` + lines.map(([c, s]) => c ? `<span class="${c}">${esc(s)}</span>` : esc(s)).join("");
const tabs = [...document.querySelectorAll('.shell-tabs [role="tab"]')];
function selectTab(tab, focus) {
tabs.forEach(t => {
const on = t === tab;
t.setAttribute("aria-selected", on);
t.tabIndex = on ? 0 : -1;
document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
});
if (focus) tab.focus();
try { localStorage.setItem("artemis-lab-tab", tab.id); } catch (e) {}
}
tabs.forEach((t, i) => {
t.addEventListener("click", () => selectTab(t));
t.addEventListener("keydown", e => {
const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
if (e.key in keys) { e.preventDefault(); selectTab(tabs[(i + keys[e.key] + tabs.length) % tabs.length], true); }
if (e.key === "Home") { e.preventDefault(); selectTab(tabs[0], true); }
if (e.key === "End") { e.preventDefault(); selectTab(tabs.at(-1), true); }
});
});
try { const saved = document.getElementById(localStorage.getItem("artemis-lab-tab")); if (saved) selectTab(saved); } catch (e) {}
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const typed = new WeakSet();
function typeOut(el) {
if (typed.has(el) || reduce) return;
typed.add(el);
const full = el.dataset.type; let i = 0;
el.textContent = ""; el.classList.add("typing");
const step = () => {
i += Math.max(1, Math.round(full.length / 70));
el.textContent = full.slice(0, i);
if (i < full.length) setTimeout(step, 28);
else { el.textContent = full; el.classList.remove("typing"); el.classList.add("typed"); }
};
step();
}
const io = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
entries.forEach(e => {
if (!e.isIntersecting) return;
e.target.classList.remove("below");
e.target.querySelectorAll?.(".type").forEach(t => { if (!t.closest("[hidden]")) typeOut(t); });
if (e.target.classList.contains("type")) typeOut(e.target);
});
}, { threshold: 0.25 }) : null;
if (io && !reduce) {
document.querySelectorAll(".reveal").forEach(el => {
if (el.getBoundingClientRect().top > innerHeight) el.classList.add("below");
io.observe(el);
});
document.querySelectorAll(".type").forEach(el => io.observe(el));
}
const fxs = [...document.querySelectorAll("canvas.fx")];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function setup(c) {
const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr);
const kind = c.dataset.fx, n = kind === "dots" ? 0 : 140;
c._s = Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() * .8 + .2, t: Math.random() * 6 }));
c._dpr = dpr;
}
function draw(c, t) {
const g = c.getContext("2d"), W = c.width, H = c.height, k = c.dataset.fx;
g.clearRect(0, 0, W, H);
if (k === "stars") {
const grd = g.createRadialGradient(W * .5, H * 1.1, 0, W * .5, H * 1.1, H * 1.1);
grd.addColorStop(0, "rgba(50,121,249,.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
g.fillStyle = grd; g.fillRect(0, 0, W, H);
for (const s of c._s) {
const y = (s.y + t * .00002 * s.z) % 1, a = .35 + .45 * Math.sin(t * .002 + s.t);
g.fillStyle = `rgba(255,255,255,${a * s.z})`;
g.fillRect(s.x * W, y * H, 1.4 * c._dpr * s.z, 1.4 * c._dpr * s.z);
}
} else if (k === "orb") {
const cx = W / 2, cy = H / 2, R = Math.min(W, H) * .34, p = 1 + .03 * Math.sin(t * .0015);
for (let i = 0; i < 3; i++) {
g.beginPath(); g.arc(cx, cy, R * p * (1 + i * .06), 0, Math.PI * 2);
g.strokeStyle = `rgba(80,140,255,${.55 - i * .17})`; g.lineWidth = (10 - i * 3) * c._dpr;
g.shadowColor = "rgba(80,140,255,.9)"; g.shadowBlur = 40 * c._dpr; g.stroke();
}
g.shadowBlur = 0;
const inner = g.createRadialGradient(cx, cy, 0, cx, cy, R);
inner.addColorStop(0, "rgba(10,20,60,.9)"); inner.addColorStop(1, "rgba(0,0,0,0)");
g.fillStyle = inner; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
for (const s of c._s.slice(0, 50)) {
const ang = s.t + t * .0003 * s.z, rr = R * (1.15 + s.y * .5);
g.fillStyle = `rgba(160,190,255,${.3 * s.z})`;
g.fillRect(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 1.5 * c._dpr, 1.5 * c._dpr);
}
} else if (k === "dots") {
const gap = 14 * c._dpr, col = css("--muted") || "#888";
g.fillStyle = col;
for (let y = gap / 2; y < H; y += gap) for (let x = gap / 2; x < W; x += gap) {
const d = Math.hypot((x - W / 2) / W, (y - H / 2) / H);
const a = Math.max(0, .55 - d) * (.6 + .4 * Math.sin(t * .0012 + x * .02 + y * .015));
if (a <= .02) continue;
g.globalAlpha = a; g.fillRect(x, y, 1.3 * c._dpr, 1.3 * c._dpr);
}
g.globalAlpha = 1;
}
}
fxs.forEach(setup);
addEventListener("resize", () => fxs.forEach(c => { setup(c); if (c.offsetParent) draw(c, performance.now()); }));
const visible = new Set();
const fio = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? visible.add(e.target) : visible.delete(e.target))) : null;
fxs.forEach(c => fio ? fio.observe(c) : visible.add(c));
function frame(t) {
fxs.forEach(c => { if (visible.has(c) && c.offsetParent) draw(c, t); });
if (!reduce) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setTimeout(() => fxs.forEach(c => { if (c.offsetParent) { setup(c); draw(c, 1000); } }), 60);
(function showcase() {
const root = document.getElementById("showcase"); if (!root) return;
const stabs = [...root.querySelectorAll('[role="tab"]')], pauseBtn = document.getElementById("scPause");
const DUR = 6000; root.style.setProperty("--sc-dur", DUR + "ms");
let idx = 0, timer = null, userPaused = reduce, hoverPaused = false;
function select(i, focus) {
idx = (i + stabs.length) % stabs.length;
stabs.forEach((t, j) => {
const on = j === idx; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1;
const panel = document.getElementById(t.getAttribute("aria-controls")); panel.hidden = !on;
if (on) { panel.querySelectorAll("canvas.fx").forEach(c => { setup(c); draw(c, performance.now()); }); panel.querySelectorAll(".type").forEach(el => { typed.delete(el); typeOut(el); }); }
const bar = t.querySelector(".bar i"); bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = "";
});
if (focus) stabs[idx].focus();
schedule();
}
function schedule() {
clearTimeout(timer);
const paused = userPaused || hoverPaused;
root.classList.toggle("paused", paused);
if (!paused) timer = setTimeout(() => select(idx + 1), DUR);
}
stabs.forEach((t, i) => {
t.addEventListener("click", () => select(i));
t.addEventListener("keydown", e => {
if (e.key === "ArrowRight") { e.preventDefault(); select(idx + 1, true); }
if (e.key === "ArrowLeft") { e.preventDefault(); select(idx - 1, true); }
});
});
root.addEventListener("pointerenter", () => { hoverPaused = true; schedule(); });
root.addEventListener("pointerleave", () => { hoverPaused = false; schedule(); });
root.addEventListener("focusin", () => { hoverPaused = true; schedule(); });
root.addEventListener("focusout", () => { hoverPaused = false; schedule(); });
pauseBtn.addEventListener("click", () => {
userPaused = !userPaused; pauseBtn.setAttribute("aria-pressed", userPaused);
pauseBtn.setAttribute("aria-label", userPaused ? "Play tab rotation" : "Pause tab rotation");
pauseBtn.innerHTML = userPaused ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>';
schedule();
});
if (reduce) { pauseBtn.setAttribute("aria-pressed", "true"); }
select(0);
})();
document.querySelectorAll("[data-carousel]").forEach(car => {
const track = car.querySelector(".car-track");
const go = dir => { const card = track.firstElementChild; const w = card ? card.getBoundingClientRect().width + 20 : 300; track.scrollBy({ left: dir * w, behavior: reduce ? "auto" : "smooth" }); };
car.querySelector(".car-prev").addEventListener("click", () => go(-1));
car.querySelector(".car-next").addEventListener("click", () => go(1));
});
const refreshFx = () => fxs.forEach(c => { if (c.offsetParent) { setup(c); draw(c, performance.now()); } });
const views = [...document.querySelectorAll(".view")];
const navBtns = [...document.querySelectorAll("[data-go]")];
const navLinks = document.getElementById("navLinks"), menuBtn = document.getElementById("menuBtn");
function show(name, push) {
if (!views.some(v => v.dataset.view === name)) name = "home";
views.forEach(v => v.hidden = v.dataset.view !== name);
document.querySelectorAll(".nav-links [data-go]").forEach(b => b.dataset.go === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
navLinks.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false");
refreshFx();
if (push) { try { history.pushState(null, "", "#" + name); } catch (e) {} window.scrollTo(0, 0); }
}
navBtns.forEach(b => b.addEventListener("click", () => show(b.dataset.go, true)));
menuBtn.addEventListener("click", () => { const o = navLinks.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", o); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
window.addEventListener("popstate", () => show(location.hash.slice(1)));
show(location.hash.slice(1) || "home");
document.getElementById("copyEmail").addEventListener("click", async e => {
const text = document.getElementById("email").textContent;
try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; }
catch { const r = document.createRange(); r.selectNodeContents(document.getElementById("email")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); e.target.textContent = "Selected, press copy"; }
setTimeout(() => e.target.textContent = "Copy email", 2000);
});
})();
