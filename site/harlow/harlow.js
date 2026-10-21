/* Apollo page (/harlow): nav state, mobile menu, CTA analytics. Same behavior as the homepage's liftoff.js, without the hero effects. */
(() => {
  const nav = document.getElementById('nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 8), { passive: true });

  const burger = document.querySelector('.burger'), mnav = document.getElementById('mnav');
  const setMenu = open => { burger.setAttribute('aria-expanded', String(open)); if (open) mnav.setAttribute('data-open', ''); else mnav.removeAttribute('data-open'); };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  mnav.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') { setMenu(false); burger.focus(); } });

  /* analytics: data-track on CTAs (Vercel Web Analytics custom events) */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-track]');
    if (!el) return;
    try { window.va && window.va('event', { name: 'cta_click', data: { id: el.dataset.track, href: el.getAttribute('href') || '' } }); } catch (_) {}
  });
})();
