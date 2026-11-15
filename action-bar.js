// Action bar core. At rest it is a small capsule in the corner with a live cue for everything running. Hovering it
// opens one card: a home page that sums up everything active (a section per thing), and a detail page for each
// thing, which you move between with the buttons along the bottom (or a sideways swipe). With no click for a few
// seconds, the card slides back to the home page.
//
// Each file in buttons/ registers a card (or a plain action) and fills the elements it is given:
//   register({ id, title, icon, order, side, kind, color, home, onClick, onShow, css, setup(ctx), onMessage(msg) })
//   ctx: { home, detail, root, send, toast,
//          setAvailable(on)      this card has something to show: its button and detail page exist
//          setHomeVisible(on)    show its section on the home page (default: while available)
//          setLive(on)           something is going on: its cue shows on the capsule
//          setIndicator(node)    what the capsule shows for it while live
//          setTab(node)          what its button on the pager shows
//          setEnabled(on)        switched off for this site
//          peek(ms)              open the card on its own for a moment, to announce something (negative: until 0)
//          go()                  slide to this card's detail page
//          busy(on)              keep the card from sliding home while you're in the middle of something }
(() => {
  if (window.top !== window) return;
  const previous = globalThis.__actionBar;
  if (previous) {
    if (previous.alive()) return; // already running here
    previous.destroy(); // orphan from before an extension reload
  }

  const CARD_W = 340;
  const RETURN_MS = 5000;   // with no click for this long, slide back to the home page
  const CLOSE_GRACE_MS = 250;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      @keyframes pop-in { from { opacity: 0; transform: translateY(6px) scale(.97); } }
      @media (prefers-reduced-motion: reduce) {
        * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
      }
      .bar { --ease: cubic-bezier(.2,.8,.2,1); position: relative; color: #f2f2f7; font: 13px -apple-system, system-ui, sans-serif; }

      .handle { display: flex; align-items: center; gap: 8px; min-width: 32px; height: 32px; padding: 0 7px; box-sizing: border-box;
                border-radius: 10px; background: rgba(28,28,30,.7); color: #f2f2f7; opacity: .35; cursor: pointer;
                transition: opacity .4s; }
      .handle.live { opacity: .95; }
      .handle svg { flex: none; }
      .hind { display: flex; align-items: center; gap: 10px; }
      .bar.open .handle, .bar.peek .handle { display: none; }

      .panel { display: none; width: ${CARD_W}px; border-radius: 14px; background: rgba(28,28,30,.96); overflow: hidden;
               box-shadow: 0 8px 28px rgba(0,0,0,.28); transform-origin: bottom left; }
      .bar.open .panel, .bar.peek .panel { display: block; animation: pop-in .35s var(--ease); }
      .viewport { position: relative; overflow: hidden; transition: height .45s var(--ease); }
      .viewport.instant { transition: none; }
      .strip { display: flex; align-items: flex-start; transition: transform .5s var(--ease); }
      .strip.instant { transition: none; }
      .page { flex: none; width: ${CARD_W}px; box-sizing: border-box; overflow: hidden; }

      .homepage { padding: 6px; }
      .hs { padding: 8px 6px; border-top: 1px solid rgba(255,255,255,.08); }
      .hs:first-child { border-top: 0; }
      .hs.link { cursor: pointer; border-radius: 8px; }
      .hs.link:hover { background: rgba(255,255,255,.05); }
      .none { padding: 24px 14px; color: #a1a1a8; }

      .pager { display: flex; align-items: center; gap: 4px; height: 44px; box-sizing: border-box; padding: 0 8px;
               border-top: 1px solid rgba(255,255,255,.08); }
      .pager .space { flex: 1; }
      .bar.mini .pager { display: none; }
      .tab { position: relative; display: flex; align-items: center; justify-content: center; min-width: 40px; height: 36px;
             padding: 0 6px; box-sizing: border-box; border: 0; border-radius: 10px; background: transparent; color: #f2f2f7;
             cursor: pointer; transition: background .2s; }
      .tab:hover { background: rgba(255,255,255,.07); }
      .tab.on { background: rgba(255,255,255,.1); }
      .tab.on::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 2px; height: 2px; border-radius: 1px;
                       background: var(--tc, #f2f2f7); }
      .tab.act { min-width: 36px; color: #d1d1d6; }
      .tab img { display: block; }

      .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
               background: #1c1c1e; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3); opacity: 0; pointer-events: none;
               transition: opacity .3s; }
      .toast.on { opacity: 1; }
    </style>
    <div class="toast"></div>
    <div class="bar">
      <div class="handle" title="Action bar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
        <div class="hind"></div>
      </div>
      <div class="panel">
        <div class="viewport"><div class="strip"></div></div>
        <div class="pager"></div>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  const bar = $('.bar');
  const toastEl = $('.toast');
  const handle = $('.handle');
  const hind = $('.hind');
  const track = $('.strip');
  const viewport = $('.viewport');
  const pager = $('.pager');
  let toastTimer;

  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  const settings = () => globalThis.Settings.current;
  const el = (tag, cls) => Object.assign(document.createElement(tag), { className: cls || '' });

  // After the extension is reloaded, an orphaned copy can't reach it any more: remove the bar.
  function send(msg) {
    if (alive()) return chrome.runtime.sendMessage(msg).catch(() => {});
    host.remove();
    return Promise.resolve();
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1200);
  }

  // --- the cards -------------------------------------------------------------------

  const cards = [];
  const homePage = el('div', 'page homepage');
  const homeBtn = el('button', 'tab');
  homeBtn.type = 'button';
  homeBtn.title = homeBtn.ariaLabel = 'Overview';
  homeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="7" cy="7" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>';
  homeBtn.onclick = () => go('home');
  const emptyNote = el('div', 'none');
  emptyNote.textContent = 'Nothing running right now';

  const on = c => c.siteOn && settings().buttons[c.setting] !== false;
  const byOrder = (a, b) => a.order - b.order;

  let pages = [];      // ids in track order: 'home', then a card per detail page
  let current = 'home';
  let returnTimer;

  // Put the buttons, the detail pages and the home sections in order, from what is available right now.
  function relayout() {
    const left = cards.filter(c => c.kind === 'card' && c.side === 'left' && c.available && on(c)).sort(byOrder);
    const right = cards.filter(c => c.side === 'right' && (c.kind === 'action' || c.available) && on(c)).sort(byOrder);
    const detail = [...left, ...right.filter(c => c.kind === 'card')];
    pages = ['home', ...detail.map(c => c.id)];

    const all = cards.filter(c => c.kind === 'card' && c.hasHome && on(c) && (c.homeVisible ?? c.available)).sort(byOrder);
    // While the bar has opened by itself to announce something (and isn't being hovered), it shows only the sections
    // that announced; hovering it opens the whole home page.
    const sections = bar.classList.contains('mini') ? all.filter(c => peeks.has(c.id)) : all;
    for (const c of cards) c.homeEl.hidden = !sections.includes(c);
    homePage.replaceChildren(...(sections.length ? sections.map(c => c.homeEl) : [emptyNote]));
    track.replaceChildren(homePage, ...detail.map(c => c.page));
    pager.replaceChildren(homeBtn, ...left.map(c => c.tab), Object.assign(el('span', 'space')), ...right.map(c => c.tab));

    if (!pages.includes(current)) current = 'home';
    sizer.disconnect();
    [homePage, ...detail.map(c => c.page)].forEach(p => sizer.observe(p));
    show(true);
    renderHandle();
  }

  // The card is as tall as the page it shows, and animates between heights. It is anchored at the bottom, so the
  // buttons stay under the pointer while it grows or shrinks upward.
  let fitInstant = true;
  const pageEl = id => (id === 'home' ? homePage : cards.find(c => c.id === id)?.page);
  function fit() {
    const h = pageEl(current)?.offsetHeight || 0;
    if (!h) return; // not on screen yet; measured when it is
    if (fitInstant) {
      viewport.classList.add('instant');
      requestAnimationFrame(() => { viewport.classList.remove('instant'); fitInstant = false; });
    }
    viewport.style.height = `${h}px`;
  }
  const sizer = new ResizeObserver(fit);

  function show(instant) {
    const i = Math.max(0, pages.indexOf(current));
    track.classList.toggle('instant', !!instant);
    track.style.transform = `translateX(${-i * CARD_W}px)`;
    homeBtn.classList.toggle('on', current === 'home');
    for (const c of cards) c.tab.classList.toggle('on', c.id === current);
    if (instant) { void track.offsetWidth; track.classList.remove('instant'); }
    fit();
  }

  function go(id, { instant = false } = {}) {
    if (!pages.includes(id)) id = 'home';
    current = id;
    if (!instant) fitInstant = false; // moving between pages animates the height too
    show(instant);
    cards.find(c => c.id === id)?.def.onShow?.();
    armReturn();
  }

  // With no click for a few seconds, slide back to the home page; not while something is in the middle of being used.
  function armReturn() {
    clearTimeout(returnTimer);
    if (current === 'home') return;
    returnTimer = setTimeout(() => {
      if (cards.some(c => c.busyNow)) return armReturn();
      go('home');
    }, RETURN_MS);
  }
  bar.addEventListener('pointerdown', armReturn, true);
  bar.addEventListener('keydown', armReturn, true);

  // Two-finger swipe sideways moves between pages.
  // A trackpad keeps sending scroll events for a second after the fingers lift (momentum), so a burst of events is
  // one swipe: it moves one page, and only a pause in the events starts the next swipe.
  let wheelX = 0;
  let wheelLast = 0;
  let wheelDone = false;
  let wheelLock = 0; // a short cooldown after a move, while the slide runs, covers a momentum tail with gaps in it
  viewport.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    armReturn();
    const now = Date.now();
    if (now - wheelLast > 140) { wheelX = 0; wheelDone = false; } // the last swipe's momentum has died away
    wheelLast = now;
    if (wheelDone || now < wheelLock) return;
    wheelX += e.deltaX;
    if (Math.abs(wheelX) < 50) return;
    wheelDone = true;
    const next = pages[pages.indexOf(current) + (wheelX > 0 ? 1 : -1)];
    if (next) { wheelLock = now + 400; go(next); }
  }, { passive: false });

  // --- the capsule --------------------------------------------------------------------

  // Live cues: each card can put a small indicator on the capsule while it has something live.
  const cues = new Map(); // card id -> node
  function renderHandle() {
    const nodes = cards.filter(c => c.live && on(c) && cues.get(c.id)).sort(byOrder).map(c => cues.get(c.id));
    hind.replaceChildren(...nodes);
    handle.classList.toggle('live', nodes.length > 0);
  }

  // Hovering the capsule opens the card. Leaving closes it after a short grace, so grazing the edge doesn't snap it shut.
  let closeTimer;
  const closeNow = () => {
    bar.classList.remove('open');
    go('home', { instant: true });
    clearTimeout(returnTimer);
  };
  bar.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    // Hovering an announcement takes it over: it grows to the whole card, and closes for good when you leave.
    for (const t of peeks.values()) clearTimeout(t);
    peeks.clear();
    if (!bar.classList.contains('peek')) fitInstant = true; // opening from nothing is measured at once; from the small card it animates
    bar.classList.add('open');
    bar.classList.remove('peek');
    syncMini();
    fit();
  });
  bar.addEventListener('mouseleave', () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeNow, CLOSE_GRACE_MS);
  });

  // A card can announce something by opening the bar on its own for a moment (on the home page).
  const peeks = new Map(); // card id -> timer (or true)
  function updatePeek() {
    const was = bar.classList.contains('peek');
    bar.classList.toggle('peek', peeks.size > 0);
    syncMini();
    if (!was && peeks.size > 0 && !bar.classList.contains('open')) { fitInstant = true; go('home', { instant: true }); }
  }

  // The small announcement: the bar opened by itself for a card (not from the command bar) and isn't being hovered.
  function syncMini() {
    const mini = !bar.classList.contains('open') && peeks.size > 0 && !peeks.has('command');
    if (bar.classList.contains('mini') === mini) return;
    bar.classList.toggle('mini', mini);
    relayout();
  }

  // Open the bar on one page without hovering, e.g. from the command bar. It closes by itself after a while, or as soon
  // as you hover it and leave.
  const OPEN_FOR_MS = 8000;
  function openAt(page) {
    clearTimeout(peeks.get('command'));
    peeks.set('command', setTimeout(() => { peeks.delete('command'); updatePeek(); }, OPEN_FOR_MS));
    fitInstant = true;
    updatePeek();
    go(pages.includes(page) ? page : 'home', { instant: !bar.classList.contains('open') });
  }

  // --- registering ------------------------------------------------------------------

  const messageHandlers = [];
  if (alive()) {
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type === 'toast') toast(msg.text);
      if (msg.type === 'open-action-bar') openAt(msg.page);
      messageHandlers.forEach(h => h(msg));
    });
  }

  function register(def) {
    const card = {
      id: def.id, def, kind: def.kind || 'card', side: def.side || 'left', order: def.order ?? 50,
      setting: { 'copy-url': 'copyUrl', 'command-bar': 'commandBar' }[def.id] || def.id, hasHome: def.home !== false && (def.kind || 'card') === 'card',
      available: false, homeVisible: undefined, live: false, siteOn: true, busyNow: false
    };
    card.homeEl = el('div', 'hs');
    card.homeEl.hidden = true;
    card.page = el('div', 'page');
    card.detail = card.page;
    card.tab = el('button', 'tab' + (card.kind === 'action' ? ' act' : ''));
    card.tab.type = 'button';
    card.tab.title = card.tab.ariaLabel = def.title || def.id;
    card.tab.innerHTML = def.icon || '';
    card.tab.style.setProperty('--tc', def.color || '#f2f2f7');
    card.tab.onclick = () => (def.onClick ? def.onClick() : go(card.id));
    // A section on the home page opens that card's detail page when you click it (not one of its own buttons).
    card.homeEl.addEventListener('click', e => {
      if (bar.classList.contains('mini')) return;
      if (card.kind === 'card' && card.available && def.detail !== false && !e.target.closest('button, a, input')) go(card.id);
    });
    card.homeEl.classList.toggle('link', card.kind === 'card' && def.detail !== false);

    if (def.css) {
      const style = el('style');
      style.textContent = def.css;
      root.prepend(style);
    }
    if (def.onMessage) messageHandlers.push(def.onMessage);
    cards.push(card);

    const ctx = {
      home: card.homeEl, detail: card.page, root, send, toast,
      setAvailable: v => { if (card.available !== !!v) { card.available = !!v; relayout(); } },
      setHomeVisible: v => { if (card.homeVisible !== !!v) { card.homeVisible = !!v; relayout(); } },
      setLive: v => { card.live = !!v; renderHandle(); },
      setIndicator: node => { cues.set(card.id, node); renderHandle(); },
      setTab: node => card.tab.replaceChildren(node),
      setColor: c => card.tab.style.setProperty('--tc', c),
      setEnabled: v => { card.siteOn = !!v; relayout(); },
      peek: ms => {
        clearTimeout(peeks.get(card.id));
        peeks.delete(card.id);
        if (ms !== 0) peeks.set(card.id, ms > 0 ? setTimeout(() => { peeks.delete(card.id); updatePeek(); }, ms) : true);
        updatePeek();
      },
      go: () => go(card.id),
      busy: v => { card.busyNow = !!v; },
      isOpen: () => bar.classList.contains('open') || bar.classList.contains('peek')
    };
    def.setup?.(ctx);
    relayout();
    return ctx;
  }

  // --- the host --------------------------------------------------------------------

  // Hidden until settings have loaded, when turned off, and during fullscreen video (also covers a fullscreen
  // player inside an iframe).
  let ready = false;
  function refreshHost() {
    host.style.display = !ready || !settings().bar.enabled || document.fullscreenElement ? 'none' : '';
  }
  function applySettings() {
    refreshHost();
    relayout();
  }
  document.addEventListener('fullscreenchange', refreshHost);
  globalThis.Settings.load().then(() => { ready = true; applySettings(); }).catch(() => {});
  globalThis.Settings.onChange(applySettings);
  refreshHost();

  globalThis.__actionBar = { register, toast, send, alive, destroy: () => host.remove() };
  document.documentElement.appendChild(host);
})();
