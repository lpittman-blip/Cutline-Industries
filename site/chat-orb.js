// Artemis chat: full-screen orb layout. Presentation only. It moves the existing chat controls
// into drawers and draws a live orb; chat logic, API calls and auth stay in workspace.js.
(() => {
  const view = document.getElementById('view-chat'), box = document.getElementById('workspace-panel-chat') || document.getElementById('msgs');
  const form = document.getElementById('composer'), input = document.getElementById('prompt');
  if (!view || !box || !form || !input) return;
  const body = document.body, convo = view.querySelector('.convo'), composer = view.querySelector('.composer');
  const sidebar = view.querySelector('.chat aside'), header = view.querySelector('.workspace-header');
  const send = form.querySelector('.send');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html) n.innerHTML = html; return n; };
  const ICON = {
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 9h14M5 15h9"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/></svg>',
    stopSq: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/></svg>'
  };

  // ---- Shell: top bar, drawers, orb canvas ----
  const stage = el('canvas', 'orb-canvas'); stage.setAttribute('aria-hidden', 'true');
  const ARC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17c2.2-9 13.8-9 16 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const top = el('header', 'orb-top'); const bar = el('div', 'orb-bar'); top.append(bar);
  const menuBtn = el('button', 'orb-pill', ICON.menu + '<span>Chats</span>'); menuBtn.type = 'button'; menuBtn.setAttribute('aria-label', 'Open chats and menu'); menuBtn.setAttribute('aria-controls', 'orbMenu'); menuBtn.setAttribute('aria-expanded', 'false');
  const setBtn = el('button', 'orb-pill orb-pill-icon', ICON.sliders); setBtn.type = 'button'; setBtn.setAttribute('aria-label', 'Open settings'); setBtn.setAttribute('aria-controls', 'orbSettings'); setBtn.setAttribute('aria-expanded', 'false');
  const title = el('a', 'orb-wordmark'); title.href = '../'; title.setAttribute('aria-label', 'Artemis AI home');
  const slot = el('span', 'orb-slot', ARC); const titleName = el('span', 'orb-title-name', 'Artemis AI'); const titleDot = el('span', 'orb-title-dot');
  title.append(slot, titleName); const brand = el('div', 'orb-brand'); brand.append(title, titleDot);
  const actions = el('div', 'orb-actions'); actions.append(menuBtn, setBtn); bar.append(brand, actions);
  const scrim = el('div', 'orb-scrim');
  function sheet(id, side, label) {
    const s = el('aside', 'orb-sheet orb-sheet-' + side); s.id = id; s.setAttribute('role', 'dialog'); s.setAttribute('aria-label', label); s.inert = true;
    const head = el('div', 'orb-sheet-head'); const h = el('h2', '', label); const x = el('button', 'orb-round orb-sheet-x', ICON.close); x.type = 'button'; x.setAttribute('aria-label', 'Close ' + label.toLowerCase());
    x.addEventListener('click', closeSheets); head.append(h, x); s.append(head); return s;
  }
  const menu = sheet('orbMenu', 'left', 'Chats'), settings = sheet('orbSettings', 'right', 'Settings');
  const section = (parent, label) => { const s = el('section', 'orb-sec'); if (label) s.append(el('h3', '', label)); parent.append(s); return s; };

  // Menu: site links (proxy the existing nav so app.js routing stays in charge), views, conversations.
  const links = section(menu, '');
  const home = el('a', 'orb-link', ARC + '<span>Artemis AI home</span>'); home.href = '../';
  const proxy = (go, text) => { const b = el('button', 'orb-link', '<span>' + text + '</span>'); b.type = 'button'; b.addEventListener('click', () => { closeSheets(); const t = document.querySelector('#navLinks [data-go=' + go + ']'); if (t) t.click(); }); return b; };
  const accountLink = proxy('account', 'Sign in');
  links.append(home, proxy('products', 'Products'), accountLink);
  const accountNav = document.getElementById('accountNav');
  const syncAccount = () => { if (accountNav) accountLink.querySelector('span').textContent = accountNav.textContent; };
  if (accountNav) new MutationObserver(syncAccount).observe(accountNav, { childList: true, characterData: true, subtree: true }); syncAccount();
  const tabs = header && header.querySelector('.workspace-tabs');
  if (tabs) { section(menu, 'View').append(tabs); tabs.addEventListener('click', e => { if (e.target.closest('button')) closeSheets(); }); }
  const convSec = section(menu, 'Conversations');
  const branches = header && header.querySelector('.workspace-branches'), mobile = header && header.querySelector('.session-mobile');
  if (sidebar) { convSec.append(sidebar); sidebar.addEventListener('click', e => { if (e.target.closest('button.c')) closeSheets(); }); }
  if (branches) convSec.append(branches);
  if (mobile) { mobile.classList.add('orb-hidden-dup'); convSec.append(mobile); }

  // Settings: model status + account, read-aloud voice, voice mode note.
  const wsTop = header && header.querySelector('.workspace-top');
  if (wsTop) section(settings, 'Model & account').append(wsTop);
  const voiceSec = section(settings, 'Voice');
  const voiceBar = composer.querySelector('.workspace-voice');
  if (voiceBar) voiceSec.append(voiceBar);
  voiceSec.append(el('p', 'orb-note', 'The mic button turns on voice mode: new replies are read aloud and the Apollo core follows your mic level. Audio stays in this browser; nothing is recorded or sent.'));
  const backSec = section(settings, '');
  const back = el('a', 'orb-link', ARC + '<span>Back to the Artemis AI homepage</span>'); back.href = '../'; backSec.append(back);
  if (header) header.classList.add('orb-hidden-dup');

  // Composer dock: + (new chat) | pill input with send | mic | stop
  const dock = el('div', 'orb-dock');
  const plus = el('button', 'orb-plus', ICON.plus); plus.type = 'button'; plus.setAttribute('aria-label', 'New chat'); plus.dataset.tip = 'New chat';
  plus.addEventListener('click', () => {
    const b = sidebar && sidebar.querySelector('.new'), signedIn = /Account/.test(document.querySelector('.workspace-account')?.textContent || '');
    if (b && !b.disabled) b.click(); else if (!signedIn) document.querySelector('#navLinks [data-go=account]')?.click();
    kick(0.5);
  });
  form.prepend(plus);
  const mic = el('button', 'orb-ctl orb-mic', ICON.micOff); mic.type = 'button'; mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-label', 'Voice mode off'); mic.title = 'Voice mode: read replies aloud, orb follows your mic';
  const stop = el('button', 'orb-ctl orb-stop', ICON.close); stop.type = 'button'; stop.setAttribute('aria-label', 'Stop reply and voice'); stop.title = 'Stop reply / stop voice';
  composer.insertBefore(dock, form); dock.append(form, mic, stop);
  input.placeholder = 'Message Artemis';

  body.append(stage, top, scrim, menu, settings);

  // ---- Drawers ----
  let openSheet = null;
  function openS(s, btn) { closeSheets(); openSheet = s; s.inert = false; s.classList.add('open'); scrim.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); body.classList.add('orb-sheet-open'); setTimeout(() => (s.querySelector('.orb-sheet-x') || s).focus(), 30); }
  function closeSheets() { for (const [s, b] of [[menu, menuBtn], [settings, setBtn]]) { s.classList.remove('open'); s.inert = true; b.setAttribute('aria-expanded', 'false'); } scrim.classList.remove('open'); body.classList.remove('orb-sheet-open'); openSheet = null; }
  menuBtn.addEventListener('click', () => openSheet === menu ? closeSheets() : openS(menu, menuBtn));
  setBtn.addEventListener('click', () => openSheet === settings ? closeSheets() : openS(settings, setBtn));
  scrim.addEventListener('click', closeSheets);
  addEventListener('keydown', e => { if (e.key === 'Escape' && openSheet) closeSheets(); });
  // The account button opens a dialog or the sign-in view; close the drawer first.
  if (wsTop) wsTop.addEventListener('click', e => { if (e.target.closest('.workspace-account')) closeSheets(); });

  // ---- Status mirror ----
  const status = wsTop && wsTop.querySelector('.model-status'), modelName = wsTop && wsTop.querySelector('.workspace-name');
  function syncStatus() { if (!status) return; titleDot.dataset.state = status.dataset.state || ''; titleDot.title = status.textContent; titleDot.setAttribute('aria-label', status.textContent); }
  if (status) new MutationObserver(syncStatus).observe(status, { childList: true, attributes: true, characterData: true, subtree: true });
  titleDot.setAttribute('role', 'img'); syncStatus();
  if (modelName) { const syncName = () => { title.dataset.model = modelName.textContent; }; new MutationObserver(syncName).observe(modelName, { childList: true, characterData: true, subtree: true }); syncName(); }

  // ---- Page state: orb mode only on the chat view; empty vs content ----
  let hasContent = false;
  function syncMode() {
    const on = !view.hidden; body.classList.toggle('orb-mode', on); if (!on) closeSheets();
    const welcome = box.querySelector('.workspace-welcome');
    hasContent = !box.hidden ? !!box.querySelector('.msg') && !welcome : true;
    body.classList.toggle('orb-has-content', hasContent); body.classList.toggle('orb-empty', !hasContent);
  }
  new MutationObserver(syncMode).observe(view, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { syncMode(); if (busy) kick(0.25); }).observe(box, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  syncMode();

  // ---- Status line becomes a toast above the dock (auto-hides unless it holds an action) ----
  const notice = composer.querySelector('.workspace-notice'); let toastTimer;
  if (notice) {
    notice.classList.add('orb-toast');
    new MutationObserver(() => {
      notice.classList.remove('is-hidden'); clearTimeout(toastTimer);
      if (notice.textContent.trim() && !notice.querySelector('button')) toastTimer = setTimeout(() => { if (!busy) notice.classList.add('is-hidden'); }, 4200);
    }).observe(notice, { childList: true, subtree: true, characterData: true });
  }
  // ---- Animate only messages that are new (render() rebuilds the list on every token) ----
  const seen = new Set(); let lastFirst = null;
  new MutationObserver(list => {
    let i = 0; const first = box.querySelector('.msg')?.dataset.messageId || null, firstPaint = first !== lastFirst; lastFirst = first;
    for (const m of list) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.classList.contains('msg')) { const id = n.dataset.messageId || ''; if (!seen.has(id)) { seen.add(id); n.classList.add('orb-new'); n.style.setProperty('--d', (firstPaint ? Math.min(i++, 6) * 60 : 0) + 'ms'); } }
      else if (n.classList.contains('workspace-welcome')) n.classList.add('orb-new');
    }
  }).observe(box, { childList: true });

  // ---- Activity signals ----
  let busy = false, energy = 0.2, burst = 0, level = 0;
  const kick = v => { burst = Math.min(1.4, burst + v); };
  new MutationObserver(() => { const was = busy; busy = form.getAttribute('aria-busy') === 'true'; if (was && !busy) { kick(0.8); ripple(null, '#3dbe78'); autoRead(); toastTimer = setTimeout(() => notice?.classList.add('is-hidden'), 4200); } if (!was && busy) ripple(null, '#2f6fed'); }).observe(form, { attributes: true, attributeFilter: ['aria-busy'] });
  input.addEventListener('input', () => { kick(0.18); if (Math.random() < 0.3) ripple(null, '#4c8dff', 0.5); if (Math.random() < 0.5) packets.push({ n: (Math.random() * 9) | 0, t: 0, out: true }); });
  input.addEventListener('focus', () => kick(0.3));
  const speaking = () => 'speechSynthesis' in window && speechSynthesis.speaking && !speechSynthesis.paused;

  // ---- Voice mode (mic level visual + auto read-aloud using the existing Read aloud button) ----
  let voiceOn = false, micStream = null, audioCtx = null, analyser = null, buf = null, lastRead = null;
  async function startMic() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)(); const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; buf = new Uint8Array(analyser.fftSize); src.connect(analyser);
    } catch { micStream = null; analyser = null; }
  }
  function stopMic() { micStream?.getTracks().forEach(t => t.stop()); audioCtx?.close().catch(() => {}); micStream = audioCtx = analyser = null; level = 0; }
  function setVoice(on) {
    voiceOn = on; mic.setAttribute('aria-pressed', String(on)); mic.setAttribute('aria-label', on ? 'Voice mode on' : 'Voice mode off'); mic.innerHTML = on ? ICON.mic : ICON.micOff; mic.classList.toggle('is-on', on);
    if (on) { const last = [...box.querySelectorAll('.msg.sys')].pop(); lastRead = last?.dataset.messageId || null; startMic(); kick(0.8); ripple(null, '#3dbe78'); } else stopMic();
  }
  mic.addEventListener('click', () => setVoice(!voiceOn));
  function autoRead() {
    if (!voiceOn) return;
    setTimeout(() => { const last = [...box.querySelectorAll('.msg.sys')].pop(); if (!last || last.dataset.messageId === lastRead) return;
      const b = [...last.querySelectorAll('.message-actions button')].find(x => x.textContent === 'Read aloud'); if (b) { lastRead = last.dataset.messageId; b.click(); } }, 400);
  }
  stop.addEventListener('click', () => {
    if (send && send.getAttribute('aria-label') === 'Stop') send.click();
    if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) { const b = voiceBar && [...voiceBar.querySelectorAll('button')].find(x => x.textContent === 'Stop / mute'); if (b) b.click(); else speechSynthesis.cancel(); }
    if (voiceOn) setVoice(false);
    ripple(null, '#f08a3c'); kick(0.4);
  });

  // ---- Apollo core renderer: landing hero arches + Apollo mesh, layered with depth, bloom and a starfield ----
  const ctx = stage.getContext('2d');
  const COLORS = ['#2f6fed', '#4c8dff', '#3dbe78', '#f08a3c', '#7aa2ff'];
  let W = 0, H = 0, dpr = 1;
  const starCv = el('canvas', 'orb-stars'); starCv.setAttribute('aria-hidden', 'true'); body.prepend(starCv); const sctx = starCv.getContext('2d');
  let sdpr = 1;
  function resize() {
    W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1); sdpr = Math.min(1.5, devicePixelRatio || 1);
    stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr); starCv.width = Math.round(W * sdpr); starCv.height = Math.round(H * sdpr);
  }
  addEventListener('resize', resize); resize();
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const STARS = Array.from({ length: 150 }, () => ({ x: rnd(), y: rnd(), z: 0.2 + rnd() * 0.8, r: 0.4 + rnd() * 0.9, ph: rnd() * 6.28, sp: 0.4 + rnd() * 1.2, c: rnd() < 0.12 ? '#7aa2ff' : rnd() < 0.06 ? '#f08a3c' : '#ffffff' }));
  const DUST = Array.from({ length: 22 }, () => ({ x: rnd() * 2.4 - 1.2, y: rnd() * 1.8 - 1.1, z: 1.2 + rnd() * 0.8, r: 1 + rnd() * 1.8, vy: 0.00004 + rnd() * 0.00008, ph: rnd() * 6.28, c: COLORS[(rnd() * 5) | 0] }));
  // Arches in unit space (S = scale). Back layer (faint, larger) + three main arches like the landing hero.
  const ARCHES = [[[-1.05, 0.62], [0, -1.18], [1.05, 0.62]], [[-0.8, 0.66], [0, -0.7], [0.8, 0.66]], [[-0.55, 0.7], [0, -0.22], [0.55, 0.7]]];
  const BACK = [[[-1.5, 0.7], [0, -1.75], [1.5, 0.7]], [[-1.3, 0.75], [0, -1.45], [1.3, 0.75]]];
  const parts = Array.from({ length: 84 }, (_, i) => ({ arc: i % 3, t: (i * 0.0731) % 1, sp: 0.00055 + (i % 7) * 0.00016, color: COLORS[i % COLORS.length], dash: i % 3 !== 0, len: 0.03 + (i % 5) * 0.012, a: 0.55 + (i % 5) * 0.09 }));
  const NODES = 9, nodes = Array.from({ length: NODES }, (_, i) => ({ a: i / NODES * Math.PI * 2 + (i % 2) * 0.2, ring: i % 3 === 0 ? 0.92 : 0.68, lift: (i % 3 - 1) * 0.08 }));
  const packets = [], ripples = [], sparks = [];
  let route = 0, routeAt = 0;
  function ripple(pt, color, strength = 1) {
    if (reduced.matches) return; ripples.push({ x: pt?.x, y: pt?.y, t: 0, color, s: strength }); if (ripples.length > 12) ripples.shift();
    if (pt && strength >= 1) for (let i = 0; i < 14; i++) { const a = rnd() * 6.28, v = 0.08 + rnd() * 0.22; sparks.push({ x: pt.x, y: pt.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, c: COLORS[(rnd() * 5) | 0] }); }
    if (sparks.length > 80) sparks.splice(0, sparks.length - 80);
  }
  let hover = null;
  let tx = 0, ty = 0, ttx = 0, tty = 0, spin = 0, spinV = 0, drag = null, lastPointer = 0;
  let cur = { x: 0, y: 0, r: 100, vx: 0, vy: 0, vr: 0 };
  const interactive = t => t.closest && t.closest('button, a, input, textarea, select, label, summary, .orb-sheet, .msg, .orb-dock, .workspace-welcome, dialog');
  addEventListener('pointermove', e => {
    if (!body.classList.contains('orb-mode')) return; lastPointer = performance.now();
    ttx = Math.max(-1, Math.min(1, (e.clientX - cur.x) / Math.max(W, 1) * 2.2)); tty = Math.max(-1, Math.min(1, (e.clientY - cur.y) / Math.max(H, 1) * 2.2));
    if (drag) { spinV += (e.clientX - drag.x) * 0.0012; drag.x = e.clientX; }
  }, { passive: true });
  addEventListener('pointerdown', e => {
    if (!body.classList.contains('orb-mode') || openSheet || interactive(e.target)) return;
    if (Math.hypot(e.clientX - cur.x, e.clientY - cur.y) < cur.r * 1.35) {
      drag = { x: e.clientX }; ripple({ x: e.clientX, y: e.clientY }, COLORS[(rnd() * 4) | 0]); kick(0.7); if (navigator.vibrate) try { navigator.vibrate(8); } catch {}
      route = (route + 1 + ((rnd() * (NODES - 1)) | 0)) % NODES; routeAt = performance.now(); for (let i = 0; i < 3; i++) packets.push({ n: route, t: -i * 0.18, out: true });
    }
  }, { passive: true });
  addEventListener('pointerup', () => { drag = null; }, { passive: true });
  addEventListener('pointercancel', () => { drag = null; }, { passive: true });
  // Tilt from device motion (iOS asks for permission on the first tap).
  addEventListener('deviceorientation', e => { if (e.gamma == null || drag || performance.now() - lastPointer < 1500) return; ttx = Math.max(-1, Math.min(1, e.gamma / 30)); tty = Math.max(-1, Math.min(1, (e.beta - 45) / 30)); }, { passive: true });
  let motionAsked = false;
  addEventListener('touchend', () => {
    if (motionAsked) return; motionAsked = true;
    const D = window.DeviceOrientationEvent; if (D && typeof D.requestPermission === 'function') D.requestPermission().catch(() => {});
  }, { passive: true });

  function quad(a, b, c, t) { const u = 1 - t; return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]; }
  function strokeQuad(P) { ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.quadraticCurveTo(P[1][0], P[1][1], P[2][0], P[2][1]); ctx.stroke(); }
  const A0 = performance.now(); let ignited = false;
  const clamp01 = v => Math.max(0, Math.min(1, v)), easeOut = v => 1 - Math.pow(1 - v, 3), easeBack = v => 1 + 2.7 * Math.pow(v - 1, 3) + 1.7 * Math.pow(v - 1, 2);
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `${n >> 16},${(n >> 8) & 255},${n & 255}`; };
  function strokePart(P, prog) {
    if (prog >= 1) return strokeQuad(P); if (prog <= 0) return;
    ctx.beginPath(); const steps = 28; for (let i = 0; i <= steps * prog; i++) { const [x, y] = quad(P[0], P[1], P[2], i / steps); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  }
  let last = performance.now(), clock = 0, lastPaint = 0, wasLive = null;
  const glowN = new Float32Array(9); let scrollY = 0, starTick = false, prevB = null;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!body.classList.contains('orb-mode') || document.hidden) return;
    const rm = reduced.matches; if (rm && now - lastPaint < 150) return; lastPaint = now;
    const dt = Math.min(40, now - last); last = now; clock += rm ? 0 : dt; const f = dt / 16.7;
    if (analyser && buf) { analyser.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i += 4) { const v = (buf[i] - 128) / 128; s += v * v; } level += (Math.min(1, Math.sqrt(s / (buf.length / 4)) * 6) - level) * 0.3; mic.style.setProperty('--lvl', level.toFixed(3)); }
    const talk = speaking(), live = busy || talk;
    const stopState = live ? 'live' : voiceOn ? 'armed' : 'idle';
    if (stopState !== wasLive) { wasLive = stopState; stop.classList.toggle('is-live', live); stop.classList.toggle('is-armed', !live && voiceOn); stop.innerHTML = ICON.stopSq; const shown = stopState !== 'idle'; stop.tabIndex = shown ? 0 : -1; stop.setAttribute('aria-hidden', String(!shown)); }
    energy += (((busy ? 0.85 : 0.22) + (talk ? 0.45 : 0) + level * 0.8 + burst) - energy) * 0.05 * f; burst *= Math.pow(0.94, f);
    tx += (ttx - tx) * 0.04 * f; ty += (tty - ty) * 0.04 * f; spin += spinV * f + (rm ? 0 : dt * 0.0001 * (1 + energy * 2)); spinV *= Math.pow(0.95, f);
    // Framing: ~40% of the viewport width on desktop, most of the width on phones.
    const topH = 64, wide = W > 700;
    const big = wide ? Math.min(W * 0.2, H * 0.27, 320) : Math.min(W * 0.4, H * 0.19, 200);
    const cyE = Math.max(H * (wide ? 0.27 : 0.27), topH + big * 0.62 + 12);
    const sr = slot.getBoundingClientRect();
    const goal = hasContent ? { x: sr.left + sr.width / 2, y: sr.top + sr.height * 0.62, r: sr.width * 0.5 } : { x: W / 2, y: cyE, r: big };
    if (!cur.init) cur = { ...goal, vx: 0, vy: 0, vr: 0, init: true };
    if (rm) { cur.x = goal.x; cur.y = goal.y; cur.r = goal.r; }
    else { const k = 0.045, d = Math.pow(0.8, f);
      cur.vx = cur.vx * d + (goal.x - cur.x) * k * f; cur.vy = cur.vy * d + (goal.y - cur.y) * k * f; cur.vr = cur.vr * d + (goal.r - cur.r) * k * f;
      cur.x += cur.vx * f; cur.y += cur.vy * f; cur.r = Math.max(4, cur.r + cur.vr * f); }
    body.style.setProperty('--orb-r', Math.round(big) + 'px'); body.style.setProperty('--orb-top', Math.round(cyE + big * 0.8 + 8) + 'px');
    const arrive = rm ? 1 : clamp01((now - A0) / 2200), hubP = clamp01((arrive - 0.3) / 0.3), meshP = clamp01((arrive - 0.5) / 0.35);
    const archP = i => easeOut(clamp01(arrive * 1.9 - i * 0.22));
    if (!ignited && hubP > 0.5) { ignited = true; ripple(null, '#4c8dff'); kick(0.6); }
    body.classList.toggle('orb-docked', hasContent && cur.r < 20);
    const t = clock / 1000, small = cur.r < 30, morph = clamp01((cur.r - 11) / (big - 11 || 1));
    const S = cur.r * (1 + Math.sin(t * 0.9) * 0.012 + level * 0.1 + Math.min(0.2, burst * 0.04) + (busy ? Math.sin(t * 5) * 0.015 : 0));
    const cx = cur.x + tx * S * 0.04, cy = cur.y + ty * S * 0.04, hubY = cy + S * 0.3;

    // ---- Starfield canvas (behind everything): twinkle, slow drift, parallax on scroll + pointer ----
    scrollY += (((hasContent && !box.hidden) ? box.scrollTop : 0) - scrollY) * 0.2;
    starTick = !starTick; const drawStars = !hasContent || starTick || rm;
    if (drawStars) { sctx.setTransform(sdpr, 0, 0, sdpr, 0, 0); sctx.clearRect(0, 0, W, H); }
    const sDim = easeOut(arrive) * (hasContent ? 0.75 : 1);
    if (drawStars) for (const st of STARS) {
      const x = ((st.x * W + t * 2.2 * st.z - tx * 12 * st.z) % W + W) % W, y = ((st.y * H - scrollY * 0.06 * st.z - ty * 8 * st.z) % H + H) % H;
      const tw = 0.55 + 0.45 * Math.sin(t * st.sp + st.ph);
      sctx.globalAlpha = sDim * (0.16 + 0.42 * st.z) * tw; sctx.fillStyle = st.c;
      const r = st.r * st.z + 0.35; sctx.beginPath(); sctx.arc(x, y, r, 0, 6.283); sctx.fill();
      if (st.z > 0.88 && tw > 0.9) { sctx.globalAlpha *= 0.35; sctx.fillRect(x - r * 3, y - 0.3, r * 6, 0.6); sctx.fillRect(x - 0.3, y - r * 3, 0.6, r * 6); }
    }
    sctx.globalAlpha = 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    { // Only clear what was drawn: when docked and quiet, that's a small box around the mark.
      const quiet = small && !ripples.length && !sparks.length, pad = Math.max(60, cur.r * 4);
      const nb = quiet ? [cx - pad, cy - pad, pad * 2, pad * 2] : [0, 0, W, H];
      if (prevB) ctx.clearRect(prevB[0], prevB[1], prevB[2], prevB[3]); ctx.clearRect(nb[0], nb[1], nb[2], nb[3]); prevB = nb;
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (!small) {
      // Ground glow + ambient bloom
      ctx.save(); ctx.translate(cx, cy + S * 0.68); ctx.scale(1, 0.14);
      let g = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 1.35); g.addColorStop(0, `rgba(76,141,255,${(0.32 + energy * 0.2) * hubP * morph})`); g.addColorStop(0.45, `rgba(61,190,120,${0.08 * hubP * morph})`); g.addColorStop(1, 'rgba(14,14,16,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, S * 1.35, 0, 6.283); ctx.fill(); ctx.restore();
      g = ctx.createRadialGradient(cx, hubY, 0, cx, hubY, S * (1.3 + energy * 0.35));
      g.addColorStop(0, `rgba(47,111,237,${(0.16 + energy * 0.18) * morph * hubP})`); g.addColorStop(0.55, `rgba(61,190,120,${(0.03 + energy * 0.04) * morph * hubP})`); g.addColorStop(1, 'rgba(14,14,16,0)');
      ctx.fillStyle = g; ctx.fillRect(cx - S * 2, hubY - S * 2, S * 4, S * 4);
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(255,255,255,${0.055 * morph})`;
      BACK.forEach((arc, i) => strokePart(arc.map(([x, y]) => [cx + (x + tx * 0.02) * S, cy + (y + ty * 0.02 + Math.sin(t * 0.35 + i) * 0.008) * S]), archP(i)));
    }
    // Main arches: gradient strokes that fade at the feet, with a soft bloom pass
    const archPts = ARCHES.map((arc, i) => arc.map(([x, y]) => [cx + (x + tx * 0.06 * (3 - i)) * S, cy + (y + ty * 0.05 * (3 - i) + Math.sin(t * 0.5 + i) * 0.01) * S]));
    const archGrad = (i, a) => {
      const P = archPts[i], g = ctx.createLinearGradient(P[0][0], 0, P[2][0], 0);
      const c = i === 0 ? ['255,255,255', '200,215,255', '255,255,255'] : i === 1 ? ['47,111,237', '122,162,255', '47,111,237'] : ['76,141,255', '61,190,120', '240,138,60'];
      g.addColorStop(0, `rgba(${c[0]},0)`); g.addColorStop(0.18, `rgba(${c[0]},${a})`); g.addColorStop(0.5, `rgba(${c[1]},${a})`); g.addColorStop(0.82, `rgba(${c[2]},${a})`); g.addColorStop(1, `rgba(${c[2]},0)`); return g;
    };
    if (!small) { ctx.globalCompositeOperation = 'lighter'; archPts.forEach((P, i) => { ctx.strokeStyle = archGrad(i, (i === 0 ? 0.05 : 0.11) + energy * 0.06); ctx.lineWidth = Math.max(5, S * 0.035); strokePart(P, archP(i)); }); ctx.globalCompositeOperation = 'source-over'; }
    archPts.forEach((P, i) => { ctx.strokeStyle = small ? (i === 1 ? '#4c8dff' : 'rgba(255,255,255,.7)') : archGrad(i, (i === 0 ? 0.32 : 0.75) + energy * 0.2); ctx.lineWidth = small ? 1.4 : Math.max(1.3, S * 0.0075); strokePart(P, archP(i)); });
    // Flowing particles with fading tails
    const speed = 1 + energy * 2.6;
    for (const p of parts) {
      if (!rm) p.t = (p.t + p.sp * speed * dt / 16) % 1;
      if (small && p.dash) continue;
      const ap = archP(p.arc); if (p.t > ap) continue;
      const A = archPts[p.arc], [x1, y1] = quad(A[0], A[1], A[2], p.t), edge = Math.min(1, p.t * 7, (1 - p.t) * 7) * ap;
      ctx.strokeStyle = ctx.fillStyle = p.color;
      if (p.dash) {
        const lw = Math.max(1.6, S * 0.011);
        for (let k = 0; k < 3; k++) { const a0 = Math.max(0, p.t - p.len * (k + 1)), a1 = Math.max(0, p.t - p.len * k); const [ax, ay] = quad(A[0], A[1], A[2], a0), [bx, by] = quad(A[0], A[1], A[2], a1);
          ctx.globalAlpha = edge * p.a * (0.55 + energy * 0.45) * (1 - k * 0.38); ctx.lineWidth = lw * (1 - k * 0.22); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
      } else { ctx.globalAlpha = edge * p.a * (0.6 + energy * 0.5); ctx.beginPath(); ctx.arc(x1, y1, small ? 1.1 : Math.max(1.2, S * 0.01), 0, 6.283); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    if (!small) {
      const tiltY = 0.28 + ty * 0.1;
      const proj = nodes.map((n, i) => { const a = n.a + spin + tx * 0.35; const z = Math.sin(a); return { x: cx + Math.cos(a) * n.ring * S * 0.95, y: hubY + (z * tiltY * n.ring + n.lift) * S, z, i }; });
      let liveCol = '#4c8dff', nodeCol = '#3dbe78', target = null;
      if (hover && document.contains(hover.el)) {
        const r = hover.el.getBoundingClientRect(); target = { x: r.left + r.width / 2, y: r.top + 4 };
        let best = 0, bd = 1e9; for (const p of proj) { const d = Math.hypot(p.x - target.x, p.y - target.y); if (d < bd) { bd = d; best = p.i; } }
        route = best; liveCol = nodeCol = hover.color;
        if (!rm && now - routeAt > 260) { routeAt = now; packets.push({ n: route, t: 0, out: true, c: hover.color }); }
      } else {
        const interval = busy ? 560 : talk ? 850 : 2100;
        if (!rm && now - routeAt > interval) { route = (route + 3) % NODES; routeAt = now; packets.push({ n: route, t: 0, out: !busy }); if (busy) packets.push({ n: (route + 4) % NODES, t: 0, out: true }); }
      }
      for (let i = 0; i < NODES; i++) glowN[i] += ((i === route ? 1 : 0) - glowN[i]) * (rm ? 1 : 0.07 * f);
      const vis = morph * meshP; ctx.globalAlpha = vis;
      for (const p of proj) {
        const gl = glowN[p.i];
        ctx.strokeStyle = `rgba(255,255,255,${0.05 + (p.z + 1) * 0.045})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, hubY); ctx.lineTo(p.x, p.y); ctx.stroke();
        if (gl > 0.02) {
          const lg = ctx.createLinearGradient(cx, hubY, p.x, p.y); lg.addColorStop(0, `rgba(${rgb(liveCol)},${0.2 * gl})`); lg.addColorStop(1, `rgba(${rgb(liveCol)},${0.95 * gl})`);
          ctx.strokeStyle = lg; ctx.lineWidth = 2; ctx.stroke();
          ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(${rgb(liveCol)},${0.18 * gl})`; ctx.lineWidth = 8; ctx.stroke(); ctx.globalCompositeOperation = 'source-over';
        }
      }
      if (target) { const p = proj[route]; ctx.save(); ctx.setLineDash([4, 7]); ctx.lineDashOffset = -t * 40; ctx.strokeStyle = `rgba(${rgb(liveCol)},.45)`; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo((p.x + target.x) / 2 + (target.x - cx) * 0.2, (p.y + target.y) / 2, target.x, target.y); ctx.stroke(); ctx.restore(); }
      // Packets: eased travel with a gradient tail
      for (let i = packets.length - 1; i >= 0; i--) {
        const pk = packets[i]; pk.t += dt / (busy ? 560 : 950); if (pk.t > 1) { packets.splice(i, 1); continue; } if (pk.t < 0) continue;
        const p = proj[pk.n], ease = q => q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
        const qh = pk.out ? pk.t : 1 - pk.t, qt = pk.out ? Math.max(0, pk.t - 0.16) : Math.min(1, 1 - pk.t + 0.16), eh = ease(qh), et = ease(qt);
        const hx = cx + (p.x - cx) * eh, hy = hubY + (p.y - hubY) * eh, tx2 = cx + (p.x - cx) * et, ty2 = hubY + (p.y - hubY) * et;
        const col = pk.c ? rgb(pk.c) : busy ? '61,190,120' : '240,138,60', fade = Math.sin(pk.t * Math.PI);
        const tg = ctx.createLinearGradient(tx2, ty2, hx, hy); tg.addColorStop(0, `rgba(${col},0)`); tg.addColorStop(1, `rgba(${col},${0.9 * fade})`);
        ctx.strokeStyle = tg; ctx.lineWidth = Math.max(2, S * 0.014); ctx.beginPath(); ctx.moveTo(tx2, ty2); ctx.lineTo(hx, hy); ctx.stroke();
        const hg2 = ctx.createRadialGradient(hx, hy, 0, hx, hy, S * 0.05); hg2.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`); hg2.addColorStop(0.35, `rgba(${col},${0.8 * fade})`); hg2.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = hg2; ctx.beginPath(); ctx.arc(hx, hy, S * 0.05, 0, 6.283); ctx.fill();
      }
      // Glowing dot nodes (depth-sorted)
      proj.sort((a, b) => a.z - b.z).forEach(p => {
        const gl = glowN[p.i], depth = (p.z + 1) / 2, r = Math.max(2.2, S * (0.016 + depth * 0.012)) * (1 + gl * 0.35);
        const base = gl > 0.5 ? nodeCol : '#7aa2ff';
        const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * (3 + gl * 2)); halo.addColorStop(0, `rgba(${rgb(base)},${0.25 + 0.35 * gl + depth * 0.15})`); halo.addColorStop(1, `rgba(${rgb(base)},0)`);
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(p.x, p.y, r * (3 + gl * 2), 0, 6.283); ctx.fill();
        const core = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, 0, p.x, p.y, r); core.addColorStop(0, '#ffffff'); core.addColorStop(0.45, base); core.addColorStop(1, `rgba(${rgb(base)},${0.5 + depth * 0.4})`);
        ctx.fillStyle = core; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill();
      });
      ctx.globalAlpha = 1;
      for (const d of DUST) {
        if (!rm) { d.y -= d.vy * dt; if (d.y < -1.3) d.y = 0.9; }
        const x = cx + (d.x + tx * 0.16 * d.z) * S, y = cy + (d.y + ty * 0.12 * d.z) * S;
        ctx.globalAlpha = morph * (0.1 + 0.08 * Math.sin(t + d.ph)) * (0.6 + energy * 0.6); ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(x, y, d.r * d.z, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // Layered breathing hub
    const hb = small ? 1 : Math.max(0.001, easeBack(hubP)), hr = (small ? 2.4 : S * (0.06 + energy * 0.022)) * hb;
    if (!small) {
      const br1 = 1 + Math.sin(t * 0.8) * 0.08, br2 = 1 + Math.sin(t * 1.7 + 1) * 0.06;
      let g = ctx.createRadialGradient(cx, hubY, 0, cx, hubY, hr * 5.2 * br1); g.addColorStop(0, `rgba(76,141,255,${0.35 * hubP})`); g.addColorStop(0.5, `rgba(47,111,237,${0.1 * hubP})`); g.addColorStop(1, 'rgba(47,111,237,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, hubY, hr * 5.2 * br1, 0, 6.283); ctx.fill();
      ctx.strokeStyle = `rgba(122,162,255,${(0.25 + 0.15 * Math.sin(t * 1.7)) * hubP})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, hubY, hr * 2.1 * br2, 0, 6.283); ctx.stroke();
    }
    let hg = ctx.createRadialGradient(cx, hubY, 0, cx, hubY, hr * 2.6);
    hg.addColorStop(0, `rgba(255,255,255,${Math.min(1, hubP * 1.5 + (small ? 1 : 0))})`); hg.addColorStop(0.3, `rgba(170,198,255,${0.85})`); hg.addColorStop(0.62, `rgba(76,141,255,${0.45 + energy * 0.25})`); hg.addColorStop(1, 'rgba(47,111,237,0)');
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(cx, hubY, hr * 2.6, 0, 6.283); ctx.fill();
    if (live && !small) {
      ctx.save(); ctx.translate(cx, hubY); ctx.rotate(t * (busy ? 2.4 : 1.1)); ctx.strokeStyle = busy ? '#3dbe78' : '#f08a3c'; ctx.lineWidth = 2;
      ctx.setLineDash([S * 0.12, S * 0.22]); ctx.beginPath(); ctx.arc(0, 0, hr * 3, 0, 6.283); ctx.stroke(); ctx.restore();
    }
    // Ripples + sparks
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i]; r.t += dt / 1100; if (r.t >= 1) { ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - r.t, 3), x = r.x ?? cx, y = r.y ?? hubY, reach = (small ? 22 : S * 0.95) * r.s;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = (1 - r.t) * 0.75 * r.s; ctx.lineWidth = 2 * (1 - r.t) + 0.5; ctx.beginPath(); ctx.arc(x, y, 4 + e * reach, 0, 6.283); ctx.stroke();
      if (r.t > 0.12) { const e2 = 1 - Math.pow(1 - (r.t - 0.12) / 0.88, 3); ctx.globalAlpha = (1 - r.t) * 0.4 * r.s; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 4 + e2 * reach * 0.7, 0, 6.283); ctx.stroke(); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i]; sp.life -= dt / 700; if (sp.life <= 0) { sparks.splice(i, 1); continue; }
      sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vx *= Math.pow(0.95, f); sp.vy *= Math.pow(0.95, f);
      ctx.globalAlpha = sp.life; ctx.fillStyle = sp.c; ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.8 * sp.life + 0.4, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ===================== Alive layer: arrival, hero prompt, chip cards, micro-interactions =====================
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const goSignIn = () => document.querySelector('#navLinks [data-go=account]')?.click();
  const SVG = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const CHIPS = {
    'Write & explain code': { color: '#4c8dff', icon: SVG('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>') },
    'Research a question': { color: '#3dbe78', icon: SVG('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>') },
    'Work through a problem': { color: '#f08a3c', icon: SVG('<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="18" cy="6" r="2"/>') },
    'Run a calculation': { color: '#7aa2ff', icon: SVG('<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7h7M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/>') }
  };
  const PREVIEW = { 'Write & explain code': 'Help me write and explain a Python function.', 'Research a question': 'Search for current Python documentation and cite your sources.', 'Work through a problem': 'Help me break down a problem into clear steps.', 'Run a calculation': 'Use Python to calculate the sum of squares from 1 to 20.' };
  const ROTATE = [
    ['write and explain code', 'Help me write and explain a Python function.'],
    ['research a question with sources', 'Search for current Python documentation and cite your sources.'],
    ['plan a project', 'Help me plan a project: the goal, milestones and next steps.'],
    ['draft an email', 'Help me draft a clear, friendly email about '],
    ['debug an error', 'Help me debug this error. Here is the message: ']
  ];
  function fillComposer(text, from, color) {
    if (input.disabled) { if (!busy) goSignIn(); return; }
    input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    try { input.setSelectionRange(text.length, text.length); } catch {}
    if (from) fly(from, color);
  }
  function fly(from, color = '#4c8dff') {
    if (reduced.matches) return;
    const a = from.getBoundingClientRect(), b = form.getBoundingClientRect();
    const ghost = el('div', 'orb-fly'); ghost.style.cssText = `left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;--c:${color}`; body.append(ghost);
    const dx = b.left + 60 - a.left, dy = b.top + b.height / 2 - (a.top + a.height / 2);
    ghost.animate([{ transform: 'none', opacity: 0.95 }, { transform: `translate(${dx * 0.6}px, ${dy * 0.5 - 30}px) scale(.7)`, opacity: 0.7, offset: 0.55 }, { transform: `translate(${dx}px, ${dy}px) scale(.25)`, opacity: 0 }], { duration: 620, easing: 'cubic-bezier(.5,0,.3,1)' }).onfinish = () => { ghost.remove(); form.classList.add('orb-catch'); setTimeout(() => form.classList.remove('orb-catch'), 500); };
  }
  // Hero prompt rotator (one active at a time)
  let rot = null, rotI = 0, rotTimer = 0;
  function runRotator() {
    clearTimeout(rotTimer); if (!rot || !document.contains(rot.el)) { rot = null; return; }
    const [say] = ROTATE[rotI], span = rot.typed;
    if (reduced.matches) { rot.el.classList.add('swap'); setTimeout(() => { span.textContent = say; rot.el.dataset.i = rotI; rot.el.classList.remove('swap'); }, 200); rotI = (rotI + 1) % ROTATE.length; rotTimer = setTimeout(runRotator, 3200); return; }
    let n = 0; rot.el.dataset.i = rotI;
    const type = () => { if (!rot || !document.contains(rot.el)) return; span.textContent = say.slice(0, ++n); if (n < say.length) rotTimer = setTimeout(type, 38 + Math.random() * 40); else rotTimer = setTimeout(erase, 2200); };
    const erase = () => { if (!rot || !document.contains(rot.el)) return; span.textContent = say.slice(0, --n); if (n > 0) rotTimer = setTimeout(erase, 18); else { rotI = (rotI + 1) % ROTATE.length; rotTimer = setTimeout(runRotator, 260); } };
    span.textContent = ''; type();
  }
  function enhanceWelcome(w) {
    if (w.dataset.orbAlive) return; w.dataset.orbAlive = '1';
    const fresh = performance.now() - A0 < 2600 && !reduced.matches; if (fresh) w.classList.add('orb-arrive');
    const h2 = w.querySelector('h2');
    if (h2) { const words = h2.textContent.split(' '); h2.textContent = ''; words.forEach((wd, i) => { const sp = el('span', 'orb-w', ''); sp.textContent = wd; sp.style.setProperty('--i', i); h2.append(sp, document.createTextNode(i < words.length - 1 ? ' ' : '')); }); h2.setAttribute('aria-label', words.join(' ')); }
    const r = el('button', 'orb-rotator'); r.type = 'button';
    const lead = el('span', 'orb-rot-lead'); lead.textContent = 'Artemis can '; const typed = el('span', 'orb-rot-typed'); const caret = el('span', 'orb-rot-caret');
    const go = el('span', 'orb-rot-go', SVG('<path d="M5 12h14M13 6l6 6-6 6"/>'));
    r.append(lead, typed, caret, go); r.setAttribute('aria-label', 'Use an example prompt');
    r.addEventListener('click', () => { const i = Number(r.dataset.i || 0); fillComposer(ROTATE[i][1], r, '#4c8dff'); });
    if (h2) h2.after(r);
    rot = { el: r, typed }; rotI = 0; setTimeout(runRotator, fresh ? 1500 : 200);
    w.querySelectorAll('.workspace-prompts button').forEach((b, i) => {
      const label = b.textContent.trim(), meta = CHIPS[label] || { color: '#4c8dff', icon: SVG('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>') };
      b.classList.add('orb-card'); b.style.setProperty('--c', meta.color); b.style.setProperty('--crgb', rgb(meta.color)); b.style.setProperty('--i', i);
      b.innerHTML = ''; const ico = el('span', 'orb-card-ico', meta.icon), txt = el('span', 'orb-card-txt'), strong = el('strong'), small = el('small');
      strong.textContent = label; small.textContent = PREVIEW[label] || ''; txt.append(strong, small); b.append(ico, txt); b.setAttribute('aria-label', label + ': ' + (PREVIEW[label] || ''));
      const on = () => { hover = { el: b, color: meta.color }; kick(0.15); }, off = () => { if (hover?.el === b) hover = null; b.style.removeProperty('--rx'); b.style.removeProperty('--ry'); };
      b.addEventListener('pointerenter', on); b.addEventListener('focus', on); b.addEventListener('pointerleave', off); b.addEventListener('blur', off);
      b.addEventListener('pointermove', e => { if (reduced.matches || e.pointerType !== 'mouse') return; const q = b.getBoundingClientRect(); b.style.setProperty('--rx', (((e.clientX - q.left) / q.width - 0.5) * 12).toFixed(1) + 'deg'); b.style.setProperty('--ry', (-((e.clientY - q.top) / q.height - 0.5) * 10).toFixed(1) + 'deg'); b.style.setProperty('--gx', ((e.clientX - q.left) / q.width * 100).toFixed(0) + '%'); });
      // workspace.js already filled the composer (or opened sign-in) on click; add the flight + auto-grow.
      b.addEventListener('click', () => { if (input.disabled || !input.value) return; input.dispatchEvent(new Event('input', { bubbles: true })); fly(b, meta.color); kick(0.5); });
    });
    const cta = w.querySelector(':scope > .btn-primary'); if (cta) cta.classList.add('orb-cta');
  }
  new MutationObserver(() => { const w = box.querySelector('.workspace-welcome'); if (w) enhanceWelcome(w); }).observe(box, { childList: true });
  { const w = box.querySelector('.workspace-welcome'); if (w) enhanceWelcome(w); }

  // Cycling composer placeholder (only while idle and empty)
  const PH = ['Message Artemis', 'Ask Artemis to explain some code…', 'Plan a project with Artemis…', 'Draft an email with Artemis…', 'Paste an error for Artemis to debug…'];
  let phI = 0;
  setInterval(() => {
    if (!body.classList.contains('orb-mode') || document.activeElement === input || input.value || document.hidden) return;
    input.classList.add('orb-ph-out'); setTimeout(() => { phI = (phI + 1) % PH.length; input.placeholder = PH[phI]; input.classList.remove('orb-ph-out'); }, 260);
  }, 3800);

  // Send launch: a spark with a trail leaves the send button toward the centerpiece
  form.addEventListener('submit', () => {
    if (!input.value.trim() || input.disabled || reduced.matches) return;
    const a = send.getBoundingClientRect(), s2 = el('div', 'orb-launch'); s2.style.left = a.left + a.width / 2 + 'px'; s2.style.top = a.top + 'px'; body.append(s2);
    s2.animate([{ transform: 'translate(-50%,0) scale(1)', opacity: 1 }, { transform: `translate(-50%, ${-Math.min(320, a.top - 80)}px) scale(.6)`, opacity: 0 }], { duration: 650, easing: 'cubic-bezier(.3,.6,.3,1)' }).onfinish = () => s2.remove();
    kick(1); for (let i = 0; i < 4; i++) packets.push({ n: (Math.random() * 9) | 0, t: -i * 0.12, out: true, c: '#4c8dff' });
  }, true);

  // Keep the composer height in sync when the chat clears the box after sending
  const fitInput = () => { if (!input.value) input.style.height = ''; };
  new MutationObserver(fitInput).observe(form, { attributes: true, attributeFilter: ['aria-busy'] });
  form.addEventListener('submit', () => setTimeout(fitInput, 50));

  // Reply finished: a burst ring from the latest Artemis mark
  new MutationObserver(list => {
    if (form.getAttribute('aria-busy') === 'true' || !list.some(m => m.oldValue === 'true')) return;
    setTimeout(() => { const who = [...box.querySelectorAll('.msg.sys .who')].pop(); if (!who || reduced.matches) return; who.classList.remove('orb-burst'); void who.offsetWidth; who.classList.add('orb-burst'); }, 120);
  }).observe(form, { attributes: true, attributeOldValue: true, attributeFilter: ['aria-busy'] });

  // Magnetic controls + cursor glow (desktop pointers only)
  const glow = el('div', 'orb-cursor'); body.append(glow);
  const magnets = [send, mic, stop, plus, menuBtn, setBtn].filter(Boolean);
  addEventListener('pointermove', e => {
    if (!fine.matches || reduced.matches || !body.classList.contains('orb-mode')) return;
    glow.style.transform = `translate3d(${e.clientX - 220}px, ${e.clientY - 220}px, 0)`; glow.classList.add('on');
    for (const m of magnets) {
      const q = m.getBoundingClientRect(), dx = e.clientX - (q.left + q.width / 2), dy = e.clientY - (q.top + q.height / 2), d = Math.hypot(dx, dy), reach = q.width / 2 + 34;
      if (d < reach) { const k = (1 - d / reach) * 0.35; m.style.translate = `${(dx * k).toFixed(1)}px ${(dy * k).toFixed(1)}px`; m.dataset.mag = '1'; }
      else if (m.dataset.mag) { m.style.translate = ''; delete m.dataset.mag; }
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => glow.classList.remove('on'));


  // ===================== Typing indicator + message states =====================
  const makeDots = () => { const d = el('div', 'orb-typing-dots'); d.innerHTML = '<i></i><i></i><i></i><span>Artemis is typing…</span>'; return d; };
  let pendingTyping = false, pendingEl = null, pendingN = 0;
  const morphStart = new Map(), wasTyping = new Set();
  let decorate = function () {
    let realTyping = null;
    box.querySelectorAll(':scope > .msg.sys').forEach(m => {
      if (m === pendingEl) return;
      const id = m.dataset.messageId, b = m.querySelector(':scope > .body'), st = m.querySelector(':scope > .message-state');
      const waiting = b && !b.textContent.trim() && st && !st.classList.contains('message-error');
      if (waiting) { realTyping = m; m.classList.add('orb-typing'); if (!m.querySelector(':scope > .orb-typing-dots')) b.after(makeDots()); if (id && !wasTyping.has(id)) { wasTyping.add(id); requestAnimationFrame(() => { if (window.__orbStick) window.__orbStick(); }); } }
      else if (id && wasTyping.has(id) && b && b.textContent.trim() && !morphStart.has(id)) morphStart.set(id, performance.now());
      if (id && morphStart.has(id)) { const age = performance.now() - morphStart.get(id); if (age < 700) { m.classList.add('orb-morph'); m.style.setProperty('--md', -Math.round(age) + 'ms'); } }
    });
    if (realTyping && pendingEl) { realTyping.classList.remove('orb-new'); pendingEl.remove(); pendingEl = null; pendingTyping = false; }
    if (pendingTyping && !realTyping && (!pendingEl || !box.contains(pendingEl))) {
      if (!pendingEl) { pendingEl = el('div', 'msg sys orb-typing orb-pending'); pendingEl.dataset.messageId = 'orb-pending-' + (++pendingN); pendingEl.setAttribute('role', 'status');
        const who = el('span', 'who'); who.textContent = 'Artemis'; const b = el('div', 'body'); const st = el('p', 'message-state'); st.textContent = 'Artemis is typing';
        pendingEl.append(who, b, makeDots(), st); }
      box.append(pendingEl); if (window.__orbStick) window.__orbStick();
    }
    box.querySelectorAll(':scope > .orb-latest').forEach(n => n.classList.remove('orb-latest'));
    const lastMsg = [...box.querySelectorAll(':scope > .msg')].pop(); if (lastMsg) lastMsg.classList.add('orb-latest');
  };
  new MutationObserver(decorate).observe(box, { childList: true });
  form.addEventListener('submit', () => { if (!input.value.trim() || input.disabled || busy) return; pendingTyping = true; setTimeout(decorate, 0); }, true);
  const clearPending = () => { pendingTyping = false; if (pendingEl) { pendingEl.remove(); pendingEl = null; } };
  new MutationObserver(() => { if (form.getAttribute('aria-busy') !== 'true') setTimeout(() => { if (form.getAttribute('aria-busy') !== 'true' && !box.querySelector('.msg.sys.orb-typing:not(.orb-pending)')) clearPending(); }, 900); }).observe(form, { attributes: true, attributeFilter: ['aria-busy'] });
  stop.addEventListener('click', () => setTimeout(() => { if (!busy) clearPending(); }, 300));
  // ===================== v5 polish: icons, time, dates, scroll, copy feedback =====================
  const SVI = (d, extra = '') => `<svg class="orb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const CHECK = SVI('<path d="M5 12.5l4.2 4.2L19 7"/>', ' data-check');
  const ACT = {
    'Copy': SVI('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>'),
    'Edit': SVI('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>'),
    'Regenerate': SVI('<path d="M20 11a8 8 0 0 0-14.7-4.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.7 4.3L20 16"/><path d="M20 20v-4h-4"/>'),
    'Retry': SVI('<path d="M20 11a8 8 0 0 0-14.7-4.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.7 4.3L20 16"/><path d="M20 20v-4h-4"/>'),
    'Helpful': SVI('<path d="M7 11v9H4.5A1.5 1.5 0 0 1 3 18.5v-6A1.5 1.5 0 0 1 4.5 11zM7 11l4-7a2 2 0 0 1 2.6 2.4L12.8 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/>'),
    'Not helpful': SVI('<path d="M17 13V4h2.5A1.5 1.5 0 0 1 21 5.5v6a1.5 1.5 0 0 1-1.5 1.5zM17 13l-4 7a2 2 0 0 1-2.6-2.4l.8-3.6H5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17"/>'),
    'Read aloud': SVI('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>')
  };
  // Message timestamps: read from the conversation responses the page already fetches (no extra requests).
  const times = new Map();
  try {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const pr = of.apply(this, arguments);
      try {
        const url = String(typeof input === 'string' ? input : input && input.url || '').split('?')[0];
        if (/\/api\/conversations\/[^/]+$/.test(url) && (!init || !init.method || init.method === 'GET'))
          pr.then(r => r.clone().json()).then(d => { if (d && Array.isArray(d.messages)) { for (const m of d.messages) if (m.id && m.created) times.set(m.id, m.created); decorate(); } }).catch(() => {});
      } catch {}
      return pr;
    };
  } catch {}
  const dayKey = d => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  function dayLabel(d) {
    const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return 'Today'; if (dayKey(d) === dayKey(y)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  // Light markdown extras the renderer leaves as text: **bold** and > quotes (visual only; Copy still uses the original text).
  function richen(bodyEl) {
    for (const p of bodyEl.querySelectorAll(':scope > p, :scope > ul > li, :scope > ol > li, :scope > h2, :scope > h3')) {
      if (p.dataset.orbRich === p.textContent) continue;
      if (p.tagName === 'P' && /^>\s?/.test(p.textContent) && p.firstChild && p.firstChild.nodeType === 3) { p.firstChild.textContent = p.firstChild.textContent.replace(/^>\s?/, ''); p.classList.add('orb-quote'); }
      for (const tn of [...p.childNodes]) {
        if (tn.nodeType !== 3 || !tn.textContent.includes('**')) continue;
        const parts = tn.textContent.split(/\*\*(.+?)\*\*/g); if (parts.length < 3) continue;
        const frag = document.createDocumentFragment(); parts.forEach((t, i) => { if (!t) return; if (i % 2) { const b = document.createElement('strong'); b.textContent = t; frag.append(b); } else frag.append(t); });
        tn.replaceWith(frag);
      }
      p.dataset.orbRich = p.textContent;
    }
  }
  function polish() {
    const msgs = [...box.querySelectorAll(':scope > .msg')];
    let prevDay = null, prev = null;
    for (const m of msgs) {
      const id = m.dataset.messageId, ts = id && times.get(id);
      // Date separators
      if (ts) {
        const d = new Date(ts * 1000), k = dayKey(d);
        const sep = m.previousElementSibling && m.previousElementSibling.classList.contains('orb-date') ? m.previousElementSibling : null;
        if (k !== prevDay) { if (!sep || sep.dataset.k !== k) { sep?.remove(); const s2 = el('div', 'orb-date'); s2.dataset.k = k; s2.setAttribute('role', 'separator'); s2.innerHTML = '<span></span>'; s2.firstChild.textContent = dayLabel(d); m.before(s2); } }
        else sep?.remove();
        prevDay = k;
      }
      // Grouping consecutive messages from the same side
      const role = m.classList.contains('user') ? 'user' : 'sys';
      const joined = prev && prev.role === role && m.previousElementSibling === prev.el;
      m.classList.toggle('orb-g-after', !!joined); if (prev) prev.el.classList.toggle('orb-g-before', !!joined);
      prev = { el: m, role };
      // Compact icon actions (original buttons, relabelled visually; accessible names kept)
      const acts = m.querySelector(':scope > .message-actions');
      if (acts) {
        for (const b of acts.querySelectorAll('button:not([data-orb])')) {
          const label = b.textContent.trim(), icon = ACT[label]; if (!icon) continue;
          b.dataset.orb = label === 'Copy' ? 'copy' : '1'; b.setAttribute('aria-label', label); b.dataset.tip = label === 'Read aloud' ? 'Read aloud' : label; b.classList.add('orb-act');
          b.innerHTML = icon + (label === 'Copy' ? CHECK : '');
        }
        if (ts && !acts.querySelector('.orb-time')) { const d = new Date(ts * 1000), tm = el('time', 'orb-time'); tm.dateTime = d.toISOString(); tm.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); tm.title = d.toLocaleString(); acts.append(tm); }
      }
      if (role === 'sys') { const b = m.querySelector(':scope > .body'); if (b && b.firstChild) richen(b); }
    }
    // stray separators (e.g. after a branch switch)
    box.querySelectorAll(':scope > .orb-date').forEach(s2 => { if (!s2.nextElementSibling || !s2.nextElementSibling.classList.contains('msg')) s2.remove(); });
    if (stick && !glide && hasContent && distBottom() > 1) ST.set.call(box, box.scrollHeight);
    updateFab();
  }
  // Tap a message to reveal its time + actions on touch
  box.addEventListener('click', e => {
    const m = e.target.closest('.msg'); if (!m || e.target.closest('button, a, pre, code, input, textarea, select')) return;
    if (getSelection && String(getSelection()).length) return;
    const was = m.classList.contains('orb-reveal'); box.querySelectorAll('.orb-reveal').forEach(n => n.classList.remove('orb-reveal')); if (!was) m.classList.add('orb-reveal');
  });
  // Copy feedback (message + code blocks)
  box.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const isMsgCopy = b.dataset.orb === 'copy', isCode = b.parentElement && b.parentElement.classList.contains('code-bar');
    if (!isMsgCopy && !isCode) return;
    setTimeout(() => {
      const ok = isCode ? /Copied/.test(b.textContent) : /^Copied/.test((composer.querySelector('.workspace-notice') || view.querySelector('.workspace-notice'))?.textContent || '');
      if (!ok) return; b.classList.remove('orb-done'); void b.offsetWidth; b.classList.add('orb-done'); setTimeout(() => b.classList.remove('orb-done'), 1600);
    }, 80);
  });

  // Scroll: smooth follow while streaming, never fights a reader who scrolled up.
  const ST = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  let stick = true, unread = false, glide = 0, convFirst = null, userAt = 0;
  const distBottom = () => box.scrollHeight - ST.get.call(box) - box.clientHeight;
  const fab = el('button', 'orb-fab', SVI('<path d="M12 5v14M6 13l6 6 6-6"/>') + '<span class="orb-fab-dot" aria-hidden="true"></span>');
  fab.type = 'button'; fab.setAttribute('aria-label', 'Scroll to latest message'); fab.dataset.tip = 'Jump to latest'; view.append(fab);
  function updateFab() { const away = hasContent && !box.hidden && distBottom() > 140; fab.classList.toggle('show', away); fab.classList.toggle('has-new', away && unread); fab.tabIndex = away ? 0 : -1; if (!away) unread = false; }
  function glideTo(force) {
    if (force || reduced.matches) { cancelAnimationFrame(glide); glide = 0; ST.set.call(box, box.scrollHeight); updateFab(); return; }
    if (glide) return;
    const step = () => {
      const d = distBottom();
      if (!stick || d < 1) { glide = 0; updateFab(); return; }
      ST.set.call(box, ST.get.call(box) + Math.max(1.5, d * 0.2)); glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }
  window.__orbStick = () => { if (stick) glideTo(); else { unread = true; updateFab(); } };
  try {
    Object.defineProperty(box, 'scrollTop', { configurable: true, get() { return ST.get.call(this); }, set(v) {
      const first = this.querySelector(':scope > .msg')?.dataset.messageId || null;
      if (first !== convFirst) { convFirst = first; stick = true; unread = false; return glideTo(true); }
      if (v < this.scrollHeight - this.clientHeight - 2) { ST.set.call(this, v); return; }
      if (!stick) { unread = true; updateFab(); return; }
      glideTo();
    } });
  } catch {}
  const userScroll = () => { userAt = performance.now(); cancelAnimationFrame(glide); glide = 0; };
  box.addEventListener('wheel', userScroll, { passive: true }); box.addEventListener('touchstart', userScroll, { passive: true }); box.addEventListener('keydown', userScroll);
  box.addEventListener('scroll', () => { if (glide && performance.now() - userAt > 250) return; stick = distBottom() < 90; if (stick) unread = false; updateFab(); }, { passive: true });
  fab.addEventListener('click', () => { stick = true; unread = false; if (reduced.matches) glideTo(true); else box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); setTimeout(updateFab, 500); });
  form.addEventListener('submit', () => { stick = true; }, true);
  addEventListener('resize', updateFab, { passive: true });

  // Status toast: lives under the top bar (never over the typing card), with a state icon.
  const note = composer.querySelector('.workspace-notice');
  if (note) {
    view.append(note); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    const kind = t => /connecting|generating|queued|stopping|sending|loading/i.test(t) ? 'busy' : /saved|copied|signed in|feedback|ready/i.test(t) ? 'ok' : /error|unable|could not|failed|uncertain|unavailable|denied|not /i.test(t) ? 'err' : 'info';
    const tag = () => { note.dataset.kind = kind(note.textContent || ''); };
    new MutationObserver(tag).observe(note, { childList: true, subtree: true, characterData: true }); tag();
  }
  const dc = decorate; decorate = function () { dc(); polish(); };
  new MutationObserver(() => polish()).observe(box, { childList: true });

  decorate();

  requestAnimationFrame(frame);
})();
