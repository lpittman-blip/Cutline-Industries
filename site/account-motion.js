(function () {
  const canvas = document.getElementById("account-canvas");
  if (!canvas) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  const COLORS = ["#2f6fed", "#4c8dff", "#3dbe78", "#f08a3c", "#7aa2ff"];
  const particles = Array.from({ length: 150 }, function (_, i) {
    return {
      arc: i % 3,
      t: (i * 0.017) % 1,
      speed: 0.00035 + (i % 7) * 0.00012,
      phase: i * 0.7,
      color: COLORS[i % COLORS.length],
      alpha: 0.55 + (i % 5) * 0.09,
      dash: i % 3 !== 0,
      len: 7 + (i % 5) * 2,
      r: 1.4 + (i % 3) * 0.7
    };
  });
  const arcs = [
    { a: { x: 0.04, y: 0.78 }, b: { x: 0.5, y: 0.06 }, c: { x: 0.96, y: 0.78 } },
    { a: { x: 0.1, y: 0.84 }, b: { x: 0.5, y: 0.22 }, c: { x: 0.9, y: 0.84 } },
    { a: { x: 0.18, y: 0.9 }, b: { x: 0.5, y: 0.4 }, c: { x: 0.82, y: 0.9 } }
  ];
  function quad(a, b, c, t) {
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
      y: u * u * a.y + 2 * u * t * b.y + t * t * c.y
    };
  }
  function quadTangent(a, b, c, t) {
    return {
      x: 2 * (1 - t) * (b.x - a.x) + 2 * t * (c.x - b.x),
      y: 2 * (1 - t) * (b.y - a.y) + 2 * t * (c.y - b.y)
    };
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._w = rect.width;
    canvas._h = rect.height;
  }
  resize();
  window.addEventListener("resize", resize);
  function frame(now) {
    const w = canvas._w;
    const h = canvas._h;
    ctx.clearRect(0, 0, w, h);
    particles.forEach(function (p) {
      if (!reduced) p.t = (p.t + p.speed) % 1;
      const arc = arcs[p.arc];
      const pos = quad(arc.a, arc.b, arc.c, p.t);
      const tan = quadTangent(arc.a, arc.b, arc.c, p.t);
      const x = pos.x * w;
      const y = pos.y * h + Math.sin(now * 0.001 + p.phase) * 6;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(tan.y, tan.x));
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      if (p.dash) {
        ctx.beginPath();
        ctx.roundRect(-p.len / 2, -1.1, p.len, 2.2, 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    if (!reduced) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
