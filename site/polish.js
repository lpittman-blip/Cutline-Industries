// Hide carousel arrows when every card already fits on screen.
(() => {
  const update = () => document.querySelectorAll("[data-carousel]").forEach(car => {
    const track = car.querySelector(".car-track"), nav = car.querySelector(".car-nav");
    if (track && nav) nav.hidden = track.scrollWidth <= track.clientWidth + 2;
  });
  addEventListener("resize", update);
  addEventListener("load", update);
  update();
})();

// Waitlist: save sign-ups through the Artemis API. If the API is unreachable, the page's built-in message is shown instead.
(() => {
  const API = "https://api.artemisai-bycutlineindustries.studio";
  const form = document.getElementById("waitlist"), email = document.getElementById("wl-email"), done = document.getElementById("wlDone");
  if (!form || !email || !done) return;
  const fallback = done.textContent;
  document.addEventListener("submit", async e => {
    if (e.target !== form) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    let msg = fallback, ok = false;
    try {
      const r = await fetch(API + "/v1/waitlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value.trim() }) });
      const body = await r.json();
      if (r.ok) { ok = true; msg = body.already_joined ? "You're already on the list. We'll email you when Artemis is live." : "You're on the list. We'll email you when Artemis is live."; }
      else if (r.status === 400) msg = body.error || "Please enter a valid email address.";
      else if (r.status === 429) msg = "Too many sign-ups from this connection today. Please try again tomorrow.";
    } catch {}
    btn.disabled = false;
    if (!ok && msg !== fallback) { email.setCustomValidity(msg); email.reportValidity(); email.addEventListener("input", () => email.setCustomValidity(""), { once: true }); return; }
    done.textContent = msg; form.hidden = ok; done.hidden = false;
  }, true);
})();
