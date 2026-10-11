// Chat page backdrop: the landing hero's Apollo arc particles, drawn behind the chat at low opacity.
// Visual only; it does not touch chat state, requests, or controls.
(() => {
  const canvas = document.getElementById("chat-hero-canvas"), view = document.getElementById("view-chat");
  if (!canvas || !view || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLORS = ["#2f6fed", "#4c8dff", "#3dbe78", "#f08a3c", "#7aa2ff"];
  const arcs = [
    { a: { x: 0.04, y: 0.78 }, b: { x: 0.5, y: 0.06 }, c: { x: 0.96, y: 0.78 } },
    { a: { x: 0.1, y: 0.84 }, b: { x: 0.5, y: 0.22 }, c: { x: 0.9, y: 0.84 } },
    { a: { x: 0.18, y: 0.9 }, b: { x: 0.5, y: 0.4 }, c: { x: 0.82, y: 0.9 } }
  ];
  const particles = Array.from({ length: 150 }, (_, i) => ({
    arc: i % 3, t: (i * 0.017) % 1, speed: 0.00035 + (i % 7) * 0.00012, phase: i * 0.7,
    color: COLORS[i % COLORS.length], alpha: 0.55 + (i % 5) * 0.09, dash: i % 3 !== 0, len: 7 + (i % 5) * 2, r: 1.4 + (i % 3) * 0.7
  }));
  let w = 0, h = 0;
  const quad = (a, b, c, t) => { const u = 1 - t; return { x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y }; };
  const tangent = (a, b, c, t) => ({ x: 2 * (1 - t) * (b.x - a.x) + 2 * t * (c.x - b.x), y: 2 * (1 - t) * (b.y - a.y) + 2 * t * (c.y - b.y) });
  function resize() {
    const rect = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr)); canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); w = rect.width; h = rect.height;
  }
  function draw(now) {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      if (!reduced) p.t = (p.t + p.speed) % 1;
      const arc = arcs[p.arc], pos = quad(arc.a, arc.b, arc.c, p.t), tan = tangent(arc.a, arc.b, arc.c, p.t);
      ctx.save(); ctx.translate(pos.x * w, pos.y * h + Math.sin(now * 0.001 + p.phase) * 6); ctx.rotate(Math.atan2(tan.y, tan.x));
      ctx.fillStyle = p.color; ctx.globalAlpha = p.alpha; ctx.beginPath();
      if (p.dash) { if (ctx.roundRect) ctx.roundRect(-p.len / 2, -1.1, p.len, 2.2, 2); else ctx.rect(-p.len / 2, -1.1, p.len, 2.2); }
      else ctx.arc(0, 0, p.r, 0, Math.PI * 2);
      ctx.fill(); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  window.addEventListener("resize", () => { resize(); if (reduced) draw(0); });
  resize();
  if (reduced) { draw(0); new MutationObserver(() => { if (!view.hidden) { resize(); draw(0); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] }); return; }
  let lastW = 0;
  (function frame(now) {
    if (!view.hidden && !document.hidden) {
      if (canvas.clientWidth !== lastW) { resize(); lastW = canvas.clientWidth; }
      draw(now);
    }
    requestAnimationFrame(frame);
  })(performance.now());
})();
