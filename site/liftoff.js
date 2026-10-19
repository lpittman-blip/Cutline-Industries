/* Artemis Liftoff homepage — particles, typing, reveals, live gateway status, nav, analytics. Loaded only by site/index.html. */
(() => {
  const root = document.documentElement;
  const DARK = root.dataset.theme !== 'light';
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  /* ---------- hero particle field ---------- */
  const cv = document.getElementById('hero-canvas');
  const ctx = cv.getContext('2d');
  const hero = document.getElementById('hero');
  let W = 0, H = 0, arcs = [], parts = [], traj = null, scrollY = 0, t0 = performance.now();
  const mouse = { x: -9999, y: -9999, sx: -9999, sy: -9999, on: false };
  const PAL = DARK
    ? [[96,140,255],[132,110,255],[176,150,255],[205,214,235],[120,170,255]]
    : [[47,91,234],[104,76,240],[124,92,255],[132,142,168],[64,120,246]];

  const bez = (a, t) => {
    const u = 1 - t;
    return [u*u*u*a[0] + 3*u*u*t*a[2] + 3*u*t*t*a[4] + t*t*t*a[6],
            u*u*u*a[1] + 3*u*u*t*a[3] + 3*u*t*t*a[5] + t*t*t*a[7]];
  };
  const bezD = (a, t) => {
    const u = 1 - t;
    return [3*u*u*(a[2]-a[0]) + 6*u*t*(a[4]-a[2]) + 3*t*t*(a[6]-a[4]),
            3*u*u*(a[3]-a[1]) + 6*u*t*(a[5]-a[3]) + 3*t*t*(a[7]-a[5])];
  };

  function build() {
    const r = hero.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const mobile = W < 700;
    const cx = W / 2, base = H * 1.06;
    // concentric Apollo arcs: [span as fraction of W, apex as fraction of H]
    const spec = mobile
      ? [[2.3,.10],[1.9,.22],[1.5,.70],[1.15,.80],[.8,.90]]
      : [[1.45,.06],[1.22,.15],[1.0,.25],[.62,.76],[.46,.84],[.3,.91]];
    arcs = spec.map(([s, ap], i) => {
      const hw = W * s / 2, apexY = H * ap;
      const cy = base + (apexY - base) / .75;
      const k = .55;
      return { a: [cx-hw, base, cx-hw*k, cy, cx+hw*k, cy, cx+hw, base], dir: i % 2 ? -1 : 1, w: s };
    });
    // launch trajectory: lower-left sweeping up to upper-right
    traj = { a: mobile ? [-.1*W, H*.98, W*.35, H*.75, W*.7, H*.32, W*1.1, -H*.04]
                       : [W*.02, H*1.02, W*.42, H*.86, W*.74, H*.42, W*1.02, -H*.06] };

    const count = Math.round(Math.min(1700, Math.max(420, W * H / (mobile ? 700 : 880))));
    parts = [];
    const total = arcs.reduce((s, a) => s + a.w, 0);
    for (let i = 0; i < count; i++) {
      const isTraj = i < count * .2;
      let arc, ai;
      if (isTraj) { arc = traj; ai = -1; }
      else {
        let pick = Math.random() * total; ai = 0;
        while (pick > arcs[ai].w && ai < arcs.length - 1) { pick -= arcs[ai].w; ai++; }
        arc = arcs[ai];
      }
      const col = PAL[(Math.random() * PAL.length) | 0];
      parts.push({
        arc, traj: isTraj, t: Math.random(),
        sp: isTraj ? .0006 + Math.random() * .0016 : (.00004 + Math.random() * .00012) * (arc.dir || 1),
        off: (Math.random() - .5) * (isTraj ? 1 : 14) * (Math.random() < .2 ? 3 : 1), spread: isTraj ? (Math.random() - .5) * 2 : 0,
        len: 2.5 + Math.random() * (isTraj ? 9 : 6),
        lw: 1.2 + Math.random() * 1.2,
        col, a: (DARK ? .35 : .5) + Math.random() * (DARK ? .65 : .5),
        dep: .4 + Math.random() * 1.1,
        ph: Math.random() * 6.28,
        x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0, ang: 0
      });
    }
  }

  function frame(now) {
    const time = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = DARK ? 'lighter' : 'source-over';
    ctx.lineCap = 'round';
    mouse.sx += (mouse.x - mouse.sx) * .12; mouse.sy += (mouse.y - mouse.sy) * .12;
    const lift = Math.min(scrollY / Math.max(H, 1), 1.4);
    const tcx = W / 2, tcy = H * .47, rx = W * (W < 700 ? .52 : .33), ry = H * .24;
    for (const p of parts) {
      let wrapped = false;
      if (!RM) { p.t += p.sp; if (p.t > 1) { p.t -= 1; wrapped = true; } else if (p.t < 0) { p.t += 1; wrapped = true; } }
      const [bx, by] = bez(p.arc.a, p.t);
      const [dx, dy] = bezD(p.arc.a, p.t);
      const dl = Math.hypot(dx, dy) || 1, nx = -dy / dl, ny = dx / dl;
      const wob = Math.sin(time * .9 + p.ph) * 3;
      const o = p.traj ? p.spread * (6 + (1 - p.t) * 70) : p.off;
      let hx = bx + nx * (o + wob), hy = by + ny * (o + wob);
      // scroll lift: particles rise and spread with depth
      hy -= lift * H * .55 * p.dep;
      hx += (hx - W / 2) * lift * .25 * p.dep;
      if (wrapped) { p.x = hx; p.y = hy; p.vx = p.vy = 0; }
      // spring toward home
      p.vx += (hx - p.x) * .035; p.vy += (hy - p.y) * .035;
      // cursor: repel + swirl
      const mx = p.x - mouse.sx, my = p.y - mouse.sy, md = Math.hypot(mx, my);
      if (md < 170 && md > .1) {
        const f = (1 - md / 170) ** 2 * 3.2;
        p.vx += (mx / md) * f - (my / md) * f * .45;
        p.vy += (my / md) * f + (mx / md) * f * .45;
      }
      p.vx *= .84; p.vy *= .84;
      p.x += p.vx; p.y += p.vy;
      // dash angle: tangent, leaning with velocity
      const target = Math.atan2(dy, dx) + Math.max(-1, Math.min(1, (p.vx * ny - p.vy * nx) * .08)) + Math.atan2(p.vy, p.vx) * 0;
      p.ang += (target - p.ang + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      let al = p.a * (1 - lift * .6);
      // keep the headline area calm
      const ex = (p.x - tcx) / rx, ey = (p.y - tcy) / ry, e = ex * ex + ey * ey;
      if (e < 1) al *= .08 + .92 * e * e;
      if (p.traj) al *= Math.min(1, p.t * 6) * Math.min(1, (1 - p.t) * 4);
      if (al < .02) continue;
      const tw = .75 + .25 * Math.sin(time * 2.2 + p.ph * 3);
      const L = p.len * (1 + Math.min(Math.hypot(p.vx, p.vy) * .25, 1.5));
      const c = Math.cos(p.ang) * L / 2, s = Math.sin(p.ang) * L / 2;
      ctx.strokeStyle = `rgba(${p.col[0]},${p.col[1]},${p.col[2]},${(al * tw).toFixed(3)})`;
      ctx.lineWidth = p.lw;
      ctx.beginPath(); ctx.moveTo(p.x - c, p.y - s); ctx.lineTo(p.x + c, p.y + s); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (!RM && heroVisible) requestAnimationFrame(frame);
    else running = false;
  }
  let heroVisible = true, running = false;
  const kick = () => { if (!running) { running = true; requestAnimationFrame(frame); } };
  build();
  if (RM) { for (const p of parts) { const [bx, by] = bez(p.arc.a, p.t); p.x = bx; p.y = by; } for (let i = 0; i < 60; i++) frame(performance.now()); }
  else kick();
  new IntersectionObserver(([en]) => { heroVisible = en.isIntersecting; if (heroVisible && !RM) kick(); }).observe(hero);
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { build(); if (RM) frame(performance.now()); }, 150); });
  hero.addEventListener('pointermove', e => { const r = hero.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; if (mouse.sx < -999) { mouse.sx = mouse.x; mouse.sy = mouse.y; } });
  hero.addEventListener('pointerleave', () => { mouse.x = mouse.y = -9999; });
  const nav = document.getElementById('nav');
  addEventListener('scroll', () => { scrollY = window.scrollY; nav.classList.toggle('scrolled', scrollY > 8); }, { passive: true });

  /* ---------- headline typing ---------- */
  const h1 = document.getElementById('headline');
  const l1 = h1.querySelector('.l1'), l2 = h1.querySelector('.l2'), caret = h1.querySelector('.caret');
  const lines = [[l1, innerWidth < 640 ? 'Talk to it.\nCode with it.' : 'Talk to it. Code with it.'], [l2, 'Build anything.']];
  const done = () => { caret.classList.add('blink'); hero.classList.add('ready'); };
  if (RM || new URLSearchParams(location.search).has('static')) { lines.forEach(([el, s]) => el.textContent = s); done(); }
  else {
    let li = 0, ci = 0;
    const step = () => {
      const [el, s] = lines[li];
      el.textContent = s.slice(0, ++ci);
      if (li === 1) l2.after(caret); else l1.after(caret);
      if (ci >= s.length) { li++; ci = 0; if (li >= lines.length) return done(); hero.classList.add('ready'); l2.after(caret); return setTimeout(step, 220); }
      const ch = s[ci - 1];
      setTimeout(step, ch === '.' ? 170 : 24 + Math.random() * 34);
    };
    setTimeout(step, 350);
  }

  /* ---------- tool strip ---------- */
  const ICONS = [
    ['Chat', '<path d="M5 6h14v9H9l-4 3.5z"/>'],
    ['Code', '<path d="M9 7 4 12l5 5M15 7l5 5-5 5"/>'],
    ['Voice', '<path d="M12 4v10M8.5 7.5v5M15.5 7.5v5M5 10v1M19 10v1M9 19h6"/>'],
    ['Search', '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>'],
    ['Memory', '<path d="M12 5c-3 0-5 2-5 4.5 0 1.3.5 2.3 1.3 3L8 18h8l-.3-5.5c.8-.7 1.3-1.7 1.3-3C17 7 15 5 12 5zM10 9.5h4"/>'],
    ['Terminal', '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m7.5 10 2.5 2-2.5 2M12.5 15h4"/>'],
    ['Sandbox', '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>'],
    ['Models', '<circle cx="12" cy="12" r="2.2"/><circle cx="5.5" cy="6.5" r="1.4"/><circle cx="18.5" cy="6.5" r="1.4"/><circle cx="6" cy="18" r="1.4"/><circle cx="18" cy="18" r="1.4"/><path d="M7 7.8 10.3 10.6M17 7.8 13.7 10.6M7.3 16.8l3.2-3.2M16.7 16.8l-3.2-3.2"/>'],
    ['Deploy', '<path d="M12 3.5c3 2 4.5 5 4.5 9l-2 3h-5l-2-3c0-4 1.5-7 4.5-9z"/><circle cx="12" cy="10" r="1.5"/><path d="M9.5 18.5 12 21l2.5-2.5"/>'],
    ['Docs', '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>']
  ];
  const track = document.getElementById('tools');
  let html = '', n = 0;
  for (let rep = 0; rep < 4; rep++) ICONS.forEach(([name, d], i) => {
    html += `<div class="tool${(i === 0 || i === 6) ? ' accent' : ''}" style="--i:${n++}"><svg viewBox="0 0 24 24">${d}</svg><span>${name}</span></div>`;
  });
  track.innerHTML = html;

  /* ---------- reveals ---------- */
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: .15, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.rv').forEach(el => io.observe(el));

  /* chat bubbles appear in sequence */
  const chatIO = new IntersectionObserver(es => es.forEach(en => {
    if (!en.isIntersecting) return; chatIO.unobserve(en.target);
    en.target.querySelectorAll('.bub').forEach((b, i) => setTimeout(() => b.classList.add('show'), RM ? 0 : 250 + i * 750));
  }), { threshold: .3 });
  document.querySelectorAll('[data-anim="chat"]').forEach(el => chatIO.observe(el));

  /* terminal typing */
  const term = document.getElementById('term');
  const SCRIPT = [
    ['cmd', 'artemis "add a waitlist page with email capture"'],
    ['out', '<span class="dim">◇ reading repo · 48 files · memory: launch palette</span>'],
    ['out', '<span class="v">◆ plan</span>'],
    ['out', '  <span class="s">1.</span> create app/waitlist/page.tsx'],
    ['out', '  <span class="s">2.</span> add server action + validation'],
    ['out', '  <span class="s">3.</span> migrate table <span class="dim">signups</span>'],
    ['out', '<span class="p">?</span> apply 3 changes? <span class="s">(y/n)</span> y'],
    ['out', '<span class="ok">✓</span> 3 files written   <span class="ok">✓</span> 12 tests passed'],
    ['out', '<span class="ok">✓</span> preview → <span class="p">preview.artemis.run/waitlist</span>'],
  ];
  let termStarted = false;
  const runTerm = async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    for (;;) {
      let out = '';
      for (const [k, s] of SCRIPT) {
        if (k === 'cmd') {
          for (let i = 1; i <= s.length; i++) { term.innerHTML = out + `<span class="p">❯</span> <span class="s">${s.slice(0, i)}</span><span class="cur"></span>`; await wait(RM ? 0 : 28 + Math.random() * 40); }
          out += `<span class="p">❯</span> <span class="s">${s}</span>\n`;
        } else { out += s + '\n'; await wait(RM ? 0 : 420); }
        term.innerHTML = out + '<span class="cur"></span>';
      }
      if (RM) return;
      await wait(9000);
    }
  };
  if (term) new IntersectionObserver(([en]) => { if (en.isIntersecting && !termStarted) { termStarted = true; runTerm(); } }, { threshold: .3 }).observe(term);

  /* voice wave + captions */
  const wave = document.getElementById('wave');
  if (wave) {
    let w = '';
    for (let i = 0; i < 38; i++) { const h = 8 + Math.abs(Math.sin(i * .55)) * 30 + Math.random() * 10; w += `<i style="--h:${h.toFixed(0)}px;animation-delay:${(-i * .07).toFixed(2)}s"></i>`; }
    wave.innerHTML = w;
    const caps = ['“Draft the launch email and schedule it for Friday morning.”', '“Summarize what changed in the repo since Monday.”', '“Spin up a sandbox and try the dark theme.”'];
    let ci = 0; const vcap = document.getElementById('vcap');
    if (!RM) setInterval(() => { ci = (ci + 1) % caps.length; vcap.style.opacity = 0; setTimeout(() => { vcap.textContent = caps[ci]; vcap.style.opacity = 1; }, 300); }, 4200);
    vcap.style.transition = 'opacity .3s';
  }

  /* ---------- starfields in space panels ---------- */
  document.querySelectorAll('canvas.stars').forEach(c => {
    const g = c.getContext('2d'); let stars = [], w = 0, h = 0, vis = false, on = false;
    const size = () => {
      const r = c.getBoundingClientRect(); w = r.width; h = r.height;
      c.width = w * DPR; c.height = h * DPR; g.setTransform(DPR, 0, 0, DPR, 0, 0);
      stars = Array.from({ length: Math.round(w * h / 1600) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() < .08 ? 1.3 + Math.random() : .4 + Math.random() * .8, p: Math.random() * 6.28, s: .5 + Math.random() * 1.6, v: .02 + Math.random() * .08, c: Math.random() < .3 ? '170,180,255' : '235,238,255' }));
    };
    const draw = now => {
      const tt = now / 1000; g.clearRect(0, 0, w, h);
      for (const s of stars) {
        if (!RM) { s.y -= s.v; if (s.y < -2) { s.y = h + 2; s.x = Math.random() * w; } }
        const a = .25 + .75 * (.5 + .5 * Math.sin(tt * s.s + s.p));
        g.fillStyle = `rgba(${s.c},${(a * (DARK ? 1 : .9)).toFixed(3)})`;
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.283); g.fill();
        if (s.r > 1.3) { g.fillStyle = `rgba(${s.c},${(a * .12).toFixed(3)})`; g.beginPath(); g.arc(s.x, s.y, s.r * 4, 0, 6.283); g.fill(); }
      }
      if (vis && !RM) requestAnimationFrame(draw); else on = false;
    };
    size(); draw(performance.now());
    new IntersectionObserver(([en]) => { vis = en.isIntersecting; if (vis && !on && !RM) { on = true; requestAnimationFrame(draw); } }).observe(c);
    addEventListener('resize', () => { size(); draw(performance.now()); });
  });

  /* ---------- mobile menu ---------- */
  const burger = document.querySelector('.burger'), mnav = document.getElementById('mnav');
  const setMenu = open => { burger.setAttribute('aria-expanded', String(open)); if (open) mnav.setAttribute('data-open', ''); else mnav.removeAttribute('data-open'); };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  mnav.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') { setMenu(false); burger.focus(); } });

  /* ---------- analytics: data-track on CTAs (Vercel Web Analytics custom events) ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-track]');
    if (!el) return;
    try { window.va && window.va('event', { name: 'cta_click', data: { id: el.dataset.track, href: el.getAttribute('href') || '' } }); } catch (_) {}
  });

  /* ---------- contact form (stays in the browser) ---------- */
  const form = document.getElementById('contact-form'), thanks = document.getElementById('thanks');
  if (form) form.addEventListener('submit', e => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    thanks.hidden = false; thanks.focus();
  });

  /* ---------- live gateway status (same-origin, proxied by vercel.json) ---------- */
  const gw = { status: null, health: null, samples: [] };
  const $ = id => document.getElementById(id);
  const timeET = d => { try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; } catch (_) { return d.toLocaleTimeString(); } };
  const getJSON = path => {
    const ctrl = 'AbortController' in window ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 6000) : 0;
    const t0 = performance.now();
    return fetch(path, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(j => { clearTimeout(t); return { json: j, ms: performance.now() - t0 }; })
      .catch(err => { clearTimeout(t); throw err; });
  };
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const LOG = [
    ['', 'POST /api/artemis/chat'],
    ['s-dim', '+ memory and knowledge snippets as context'],
    ['', 'try VLLM_BASE_URL  \u2192  SSE stream'],
    ['', 'try ARTEMIS_CORE_URL  \u2192  /v1/chat'],
    ['s-dim', 'else fallback stub']
  ];
  const statusLine = () => {
    const s = gw.status;
    if (!s) return ['s-dim', 'gateway: status not reachable from this page'];
    return [s.serving ? 's-ok' : 's-warn', 'gateway: ' + [s.configured ? 'configured' : 'not configured', s.serving ? 'serving' : 'not serving yet', 'quality ' + (s.quality || 'unknown')].join(' \u00b7 ')];
  };
  const paintCore = () => {
    const s = gw.status, state = s ? (s.serving ? 'serving' : 'online') : 'down';
    const tag = $('core-tag'), led = $('core-led'), note = $('core-note'), log = $('core-stream');
    if (tag) { tag.textContent = s ? (s.serving ? 'Serving' : 'Not serving') : 'Offline'; tag.dataset.state = state; }
    if (led) led.dataset.state = state;
    if (note) note.textContent = s ? "Read live from the gateway's /api/status at " + timeET(new Date()) + '.' : "Status comes from the gateway's /api/status. It did not answer just now.";
    if (log) log.innerHTML = LOG.concat([statusLine()]).map(([c, t]) => '<span class="' + c + '">' + esc(t) + '</span>').join('\n');
  };
  const paintMeta = () => {
    const meta = $('run-meta'); if (!meta) return;
    const s = gw.status, h = gw.health;
    const set = (cap, text, state) => { const el = meta.querySelector('[data-cap="' + cap + '"]'); if (!el) return; el.textContent = text; if (state) el.dataset.state = state; else el.removeAttribute('data-state'); };
    if (h) set('queue', 'Queue ' + (h.queued || 0) + ' \u00b7 generating ' + (h.generating || 0), h.ok ? 'on' : 'off');
    else set('queue', 'Health: no answer', 'off');
    if (s) {
      set('model', s.serving ? 'Model: serving' : 'Model: not serving yet', s.serving ? 'on' : 'off');
      const tools = (s.capabilities && s.capabilities.tools) || {};
      set('search', 'Web search: ' + (tools.web_search ? tools.web_search : 'off'), tools.web_search ? 'on' : 'off');
      set('fetch', 'Web fetch: ' + (tools.web_fetch ? 'on' : 'off'), tools.web_fetch ? 'on' : 'off');
      set('training', 'Training collection: ' + (s.training_collection ? 'on' : 'off'), null);
    } else set('model', 'Model: status unavailable', 'off');
    const led = $('gw-led'); if (led) led.dataset.state = h ? (h.ok ? 'on' : 'online') : 'off';
  };
  const spark = $('gw-spark'), read = $('gw-read');
  const drawSpark = () => {
    if (!spark) return;
    const w = spark.clientWidth, h = spark.clientHeight; if (!w || !h) return;
    spark.width = w * DPR; spark.height = h * DPR;
    const g = spark.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, w, h);
    const data = gw.samples; if (!data.length) return;
    const max = Math.max(100, ...data.map(d => d || 0)), n = 24, step = w / (n - 1), start = n - data.length;
    const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, '#3b6cf6'); grad.addColorStop(1, '#7c5cff');
    g.lineWidth = 1.6; g.strokeStyle = grad; g.beginPath();
    let lx = 0, ly = 0, on = false;
    data.forEach((v, i) => { if (v == null) return; const x = (start + i) * step, y = h - 6 - (v / max) * (h - 14); if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y); lx = x; ly = y; });
    g.stroke();
    if (on) { g.fillStyle = '#9fb4ff'; g.beginPath(); g.arc(lx, ly, 3, 0, 6.283); g.fill(); }
  };
  addEventListener('resize', drawSpark);
  const pollHealth = () => getJSON('/gateway/health').then(r => {
    gw.health = r.json; gw.samples.push(Math.round(r.ms));
    if (read) read.textContent = '/api/health ' + (r.json.ok ? 'ok' : 'not ok') + ' \u00b7 ' + Math.round(r.ms) + ' ms round trip';
  }).catch(() => {
    gw.health = null; gw.samples.push(null);
    if (read) read.textContent = '/api/health did not answer from this page';
  }).then(() => { if (gw.samples.length > 24) gw.samples.shift(); drawSpark(); paintMeta(); });
  const pollStatus = () => getJSON('/gateway/status').then(r => { gw.status = r.json; }).catch(() => { gw.status = null; }).then(() => { paintMeta(); paintCore(); });
  paintCore(); pollStatus(); pollHealth();
  let gwVisible = false;
  const gwCard = spark && spark.closest('.card');
  if (gwCard) new IntersectionObserver(([en]) => { gwVisible = en.isIntersecting; }).observe(gwCard);
  setInterval(() => { if (!document.hidden && gwVisible) pollHealth(); }, 5000);
  setInterval(() => { if (!document.hidden) pollStatus(); }, 60000);
})();
