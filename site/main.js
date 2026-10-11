(function () {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hoverMQ = window.matchMedia("(hover: hover) and (pointer: fine)");
  const mobileMQ = window.matchMedia("(max-width: 880px)");
  const header = document.querySelector(".site-header");
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("primary-nav");

  const scrollBehavior = reduced ? "auto" : "smooth";

  function closeMobile() {
    header.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("nav-lock");
  }

  function openMobile() {
    header.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("nav-lock");
  }

  toggle.addEventListener("click", function () {
    if (header.classList.contains("is-open")) closeMobile();
    else openMobile();
  });

  mobileMQ.addEventListener("change", function () {
    closeMobile();
    closeMenus();
  });

  const items = Array.from(document.querySelectorAll(".nav-item"));
  let closeTimer = 0;
  let openedByHoverAt = 0;

  function menuOf(item) {
    return item.querySelector(".mega");
  }

  function buttonOf(item) {
    return item.querySelector(".nav-btn");
  }

  function isOpen(item) {
    return buttonOf(item).getAttribute("aria-expanded") === "true";
  }

  function closeMenus(except) {
    items.forEach(function (item) {
      if (item === except) return;
      buttonOf(item).setAttribute("aria-expanded", "false");
      menuOf(item).hidden = true;
    });
  }

  function openMenu(item, focusFirst) {
    window.clearTimeout(closeTimer);
    closeMenus(item);
    buttonOf(item).setAttribute("aria-expanded", "true");
    menuOf(item).hidden = false;
    if (focusFirst) {
      const link = menuOf(item).querySelector("a");
      if (link) link.focus();
    }
  }

  function scheduleClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function () {
      const active = document.activeElement;
      const inside = items.some(function (item) {
        return item.contains(active);
      });
      if (!inside) closeMenus();
    }, 160);
  }

  items.forEach(function (item) {
    const button = buttonOf(item);

    item.addEventListener("pointerenter", function (event) {
      if (event.pointerType === "touch" || mobileMQ.matches || !hoverMQ.matches) return;
      openMenu(item, false);
      openedByHoverAt = performance.now();
    });

    item.addEventListener("pointerleave", function (event) {
      if (event.pointerType === "touch" || mobileMQ.matches || !hoverMQ.matches) return;
      scheduleClose();
    });

    button.addEventListener("click", function () {
      const justHovered = performance.now() - openedByHoverAt < 450;
      if (isOpen(item)) {
        if (justHovered && !mobileMQ.matches) return;
        closeMenus();
        return;
      }
      openMenu(item, false);
      if (mobileMQ.matches && !header.classList.contains("is-open")) openMobile();
    });

    button.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openMenu(item, true);
      } else if (event.key === "Escape") {
        closeMenus();
        button.focus();
      }
    });

    menuOf(item).addEventListener("keydown", function (event) {
      const links = Array.from(menuOf(item).querySelectorAll("a"));
      const index = links.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus();
        button.focus();
      } else if (event.key === "ArrowDown" && index !== -1) {
        event.preventDefault();
        links[(index + 1) % links.length].focus();
      } else if (event.key === "ArrowUp" && index !== -1) {
        event.preventDefault();
        links[(index - 1 + links.length) % links.length].focus();
      }
    });
  });

  document.addEventListener("pointerdown", function (event) {
    if (!header.contains(event.target)) closeMenus();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeMenus();
      closeMobile();
    }
  });

  document.querySelector(".nav-direct").addEventListener("pointerenter", function () {
    if (!mobileMQ.matches && hoverMQ.matches) scheduleClose();
  });

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  let shapeName = "enterprise";

  function selectTab(name, moveFocus) {
    shapeName = name;
    tabs.forEach(function (tab) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      if (on && moveFocus) tab.focus();
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.id !== "panel-" + name;
    });
    if (cluster) cluster.setShape(name);
  }

  const tablist = document.querySelector('[role="tablist"]');
  tablist.addEventListener("click", function (event) {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    selectTab(tab.dataset.tab, false);
  });

  tablist.addEventListener("keydown", function (event) {
    const current = document.activeElement;
    const index = tabs.indexOf(current);
    if (index === -1) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next].dataset.tab, true);
  });

  function goTo(id, tab) {
    closeMenus();
    closeMobile();
    if (tab) selectTab(tab, false);
    if (id === "top") {
      window.scrollTo({ top: 0, behavior: scrollBehavior });
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: scrollBehavior, block: "start" });
    const focusEl = target.querySelector("h1, h2, h3") || target;
    if (!focusEl.hasAttribute("tabindex")) focusEl.setAttribute("tabindex", "-1");
    focusEl.focus({ preventScroll: true });
  }

  document.addEventListener("click", function (event) {
    const link = event.target.closest("[data-scroll]");
    if (!link) return;
    event.preventDefault();
    goTo(link.getAttribute("data-scroll"), link.dataset.tab || "");
  });

  const form = document.getElementById("contact-form");
  const thanks = document.getElementById("thanks");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    form.hidden = true;
    thanks.hidden = false;
    thanks.focus();
  });

  const COLORS = ["#2f6fed", "#4c8dff", "#3dbe78", "#f08a3c", "#7aa2ff"];

  function makeCanvasScene(canvas, draw) {
    const ctx = canvas.getContext("2d");
    const scene = { canvas: canvas, ctx: ctx, visible: true, draw: draw, resize: resize };
    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.width = rect.width;
      scene.height = rect.height;
    }
    resize();
    return scene;
  }

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

  const heroCanvas = document.getElementById("hero-canvas");
  const hero = makeCanvasScene(heroCanvas, function (now) {
    const ctx = hero.ctx;
    const w = hero.width;
    const h = hero.height;
    ctx.clearRect(0, 0, w, h);
    const arcs = [
      { a: { x: 0.04, y: 0.78 }, b: { x: 0.5, y: 0.06 }, c: { x: 0.96, y: 0.78 } },
      { a: { x: 0.1, y: 0.84 }, b: { x: 0.5, y: 0.22 }, c: { x: 0.9, y: 0.84 } },
      { a: { x: 0.18, y: 0.9 }, b: { x: 0.5, y: 0.4 }, c: { x: 0.82, y: 0.9 } }
    ];
    hero.particles.forEach(function (p) {
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
  });

  hero.particles = Array.from({ length: 150 }, function (_, i) {
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

  const clusterCanvas = document.getElementById("cluster-canvas");
  function canvasPointer(el) {
    const ptr = { x: -9999, y: -9999, on: false };
    if (reduced) return ptr;
    el.addEventListener("pointermove", function (event) {
      const rect = el.getBoundingClientRect();
      ptr.x = event.clientX - rect.left;
      ptr.y = event.clientY - rect.top;
      ptr.on = true;
    });
    el.addEventListener("pointerleave", function () { ptr.on = false; });
    el.addEventListener("pointerdown", function (event) {
      const rect = el.getBoundingClientRect();
      ptr.x = event.clientX - rect.left;
      ptr.y = event.clientY - rect.top;
      ptr.on = true;
      ptr.burst = performance.now();
    });
    return ptr;
  }
  const clusterPtr = canvasPointer(clusterCanvas.parentElement);
  const cluster = makeCanvasScene(clusterCanvas, function (now) {
    const ctx = cluster.ctx;
    const w = cluster.width;
    const h = cluster.height;
    ctx.clearRect(0, 0, w, h);
    const ease = reduced ? 1 : 0.075;
    const parts = cluster.particles;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2f6fed";
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      const b = parts[(i + 1) % parts.length];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 70) {
        ctx.globalAlpha = (1 - d / 70) * 0.22;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    const burst = clusterPtr.burst && now - clusterPtr.burst < 500 ? 1 - (now - clusterPtr.burst) / 500 : 0;
    cluster.particles.forEach(function (p, i) {
      p.x += (p.tx - p.x) * ease;
      p.y += (p.ty - p.y) * ease;
      let px = 0, py = 0, lit = 0;
      if (clusterPtr.on) {
        const dx = p.x - clusterPtr.x, dy = p.y - clusterPtr.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const reach = 110 + burst * 120;
        if (d < reach) {
          const f = 1 - d / reach;
          px = (dx / d) * f * (26 + burst * 40);
          py = (dy / d) * f * (26 + burst * 40);
          lit = f;
        }
      }
      p.dx = (p.dx || 0) + (px - (p.dx || 0)) * 0.18;
      p.dy = (p.dy || 0) + (py - (p.dy || 0)) * 0.18;
      const wobble = reduced ? 0 : Math.sin(now * 0.0015 + i) * 2.2;
      ctx.globalAlpha = Math.min(1, p.alpha + lit * 0.3);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + p.dx, p.y + p.dy + wobble, p.r * (1 + lit * 0.5), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  });

  function shapePoint(name, i, n, w, h) {
    const cx = w * 0.5;
    const cy = h * 0.52;
    if (name === "builders") {
      const arcCount = Math.floor(n * 0.78);
      if (i < arcCount) {
        const half = arcCount / 2;
        const which = i < half ? 0 : 1;
        const t = which === 0 ? i / half : (i - half) / half;
        const lift = which === 0 ? 0.58 : 0.36;
        return {
          x: w * (0.08 + t * 0.84),
          y: h * 0.8 - Math.sin(Math.PI * t) * h * lift
        };
      }
      const t = (i - arcCount) / Math.max(1, n - arcCount - 1);
      return { x: w * (0.08 + t * 0.84), y: h * 0.8 };
    }
    if (name === "research") {
      const centers = [
        [0.3, 0.38],
        [0.7, 0.36],
        [0.5, 0.68]
      ];
      const g = i % 3;
      const ang = i * 2.399;
      const rad = 10 + (i % 6) * 7;
      return { x: centers[g][0] * w + Math.cos(ang) * rad, y: centers[g][1] * h + Math.sin(ang) * rad * 0.85 };
    }
    if (name === "operators") {
      const cols = 8;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const rows = Math.ceil(n / cols);
      const height = 0.28 + 0.5 * Math.abs(Math.sin(col * 0.9));
      return {
        x: w * (0.16 + col * 0.09),
        y: h * (0.78 - (row / rows) * height)
      };
    }
    const ang = (i / n) * Math.PI * 2;
    const rx = w * 0.28;
    const ry = h * 0.36;
    return { x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry };
  }

  cluster.particles = Array.from({ length: 96 }, function (_, i) {
    return {
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      color: i % 13 === 0 ? "#3dbe78" : i % 17 === 0 ? "#f08a3c" : "#2f6fed",
      alpha: 0.75 + (i % 4) * 0.06,
      r: i % 5 === 0 ? 3.2 : 2.1
    };
  });

  cluster.setShape = function (name, snap) {
    const w = cluster.width;
    const h = cluster.height;
    const n = cluster.particles.length;
    cluster.particles.forEach(function (p, i) {
      const point = shapePoint(name, i, n, w, h);
      p.tx = point.x;
      p.ty = point.y;
      if (snap) {
        p.x = p.tx;
        p.y = p.ty;
      }
    });
  };

  const bandCanvas = document.getElementById("band-canvas");
  const bandPtr = canvasPointer(bandCanvas.parentElement);
  const band = makeCanvasScene(bandCanvas, function (now) {
    const ctx = band.ctx;
    const w = band.width;
    const h = band.height;
    ctx.clearRect(0, 0, w, h);
    const bp = band.particles;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#8eb0ff";
    for (let i = 0; i < bp.length; i++) {
      for (let j = i + 1; j < bp.length; j++) {
        const dx = bp[i].x - bp[j].x, dy = bp[i].y - bp[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 120 * 120) {
          ctx.globalAlpha = (1 - Math.sqrt(d2) / 120) * 0.18;
          ctx.beginPath();
          ctx.moveTo(bp[i].x, bp[i].y);
          ctx.lineTo(bp[j].x, bp[j].y);
          ctx.stroke();
        }
      }
    }
    if (bandPtr.on) {
      ctx.strokeStyle = "#7aa2ff";
      bp.forEach(function (q) {
        const dx = q.x - bandPtr.x, dy = q.y - bandPtr.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 170) {
          ctx.globalAlpha = (1 - d / 170) * 0.5;
          ctx.beginPath();
          ctx.moveTo(bandPtr.x, bandPtr.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          q.x += (bandPtr.x - q.x) * 0.004;
          q.y += (bandPtr.y - q.y) * 0.004;
        }
      });
    }
    band.particles.forEach(function (p) {
      if (!reduced) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
      }
      ctx.globalAlpha = 0.35 + 0.4 * Math.sin(now * 0.001 + p.phase);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  });

  band.particles = Array.from({ length: 56 }, function (_, i) {
    return {
      x: (i * 97) % 1000,
      y: (i * 53) % 400,
      vx: (i % 2 ? 0.22 : -0.18) * (0.4 + (i % 5) * 0.15),
      vy: (i % 3 ? 0.08 : -0.06),
      r: i % 6 === 0 ? 2.2 : 1.3,
      phase: i,
      color: i % 9 === 0 ? "#3dbe78" : i % 7 === 0 ? "#f08a3c" : i % 4 === 0 ? "#8eb0ff" : "rgba(255,255,255,0.85)"
    };
  });

  function layoutBand(snap) {
    band.particles.forEach(function (p, i) {
      if (snap || p.x > band.width || p.y > band.height) {
        p.x = ((i * 97) % 100) / 100 * band.width;
        p.y = ((i * 53) % 100) / 100 * band.height;
      }
    });
  }

  const scenes = [hero, cluster, band];

  function resizeAll() {
    scenes.forEach(function (scene) { scene.resize(); });
    cluster.setShape(shapeName, true);
    layoutBand(true);
    if (reduced) scenes.forEach(function (scene) { scene.draw(0); });
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      const scene = scenes.find(function (item) { return item.canvas === entry.target; });
      if (scene) scene.visible = entry.isIntersecting;
    });
  }, { threshold: 0.01 });
  scenes.forEach(function (scene) { observer.observe(scene.canvas); });

  window.addEventListener("resize", resizeAll);

  resizeAll();

  if (!reduced) {
    function frame(now) {
      scenes.forEach(function (scene) {
        if (scene.visible) scene.draw(now);
      });
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }
})();

const gptNotes = [
  "Neptune answers from evidence, not a guess.",
  "Mars takes the task and carries it through.",
  "Pluto covers science, medicine, and robotics.",
  "Mercury keeps what already happened.",
  "Venus checks an image, audio, or code, then audits itself.",
  "Jupiter routes the turn, then answers once."
];
const gptNote = document.querySelector(".gpt-cycle");
if (gptNote && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let i = 0;
  setInterval(() => {
    i = (i + 1) % gptNotes.length;
    gptNote.textContent = gptNotes[i];
  }, 2800);
}
