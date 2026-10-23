// Media button: one mini pill per playing source, stacked above the bar corner. Paused sources only
// show while the bar is hovered. New media expands to its full player for a few seconds; hovering a pill
// expands it into the full player in place.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const fullMs = () => (Settings.current.media.announceSeconds || 0) * 1000;
  const siteBlocked = () => Settings.hostMatches(location.hostname, Settings.current.media.hideOnSites);

  const svg = (size, inner, fill = 'none') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const NOTE = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
  const playIcon = size => svg(size, '<polygon points="5 3 19 12 5 21 5 3"/>', 'currentColor');
  const pauseIcon = size => svg(size, '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', 'currentColor');
  const SPEAKER = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>';
  const volumeIcon = size => svg(size, SPEAKER + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>');
  const mutedIcon = size => svg(size, SPEAKER + '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>');
  const PIP = size => svg(size, '<rect x="2" y="4" width="20" height="14" rx="2"/><rect x="12" y="10" width="7" height="5" fill="currentColor"/>');
  const PREV = svg(16, '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>', 'currentColor');
  const NEXT = svg(16, '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>', 'currentColor');

  const css = `
    .media .btn { display: flex; flex-direction: column-reverse; align-items: flex-start; gap: 6px;
                  width: auto; height: auto; padding: 0; background: none; border-radius: 0; opacity: 1; }
    @keyframes pill-in { from { opacity: 0; transform: translateY(8px) scale(.96); } }
    .media .pill { position: relative; display: block; overflow: hidden; height: 32px; width: var(--mw, auto);
                   border-radius: 10px; background: rgba(28,28,30,.7); opacity: .9; transform-origin: bottom left;
                   animation: pill-in .3s var(--ease);
                   transition: width .32s var(--ease), height .32s var(--ease), border-radius .32s var(--ease),
                               background .25s, box-shadow .32s, opacity .2s, transform .2s; }
    .media .pill.leave { opacity: 0; transform: translateY(6px) scale(.96); pointer-events: none;
                         transition: opacity .2s, transform .2s; }
    .media .pill.paused { display: none; }
    .bar:hover .media .pill.paused { display: block; }
    /* Open (hovered) or announcing: the pill grows into the full player, the mini controls fade out. */
    .media .pill:hover { opacity: 1; }
    .media .pill.open, .media .pill.announce { width: 380px; height: var(--ph, 54px); border-radius: 12px; opacity: 1;
                                                background: rgba(28,28,30,.96); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    .media .mini { display: flex; align-items: center; gap: 6px; width: max-content; height: 32px; padding: 0 6px;
                   transition: opacity .15s, transform .32s var(--ease); }
    .media .pill.open .mini, .media .pill.announce .mini { opacity: 0; transform: scale(.94); pointer-events: none; }
    .media .mini-art { width: 22px; height: 22px; border-radius: 6px; object-fit: cover; flex: none; cursor: pointer; }
    .media .mini-note { display: flex; flex: none; }
    .media .pwrap { position: absolute; left: 0; bottom: 0; opacity: 0; pointer-events: none;
                    transform: translateY(6px); transform-origin: bottom left;
                    transition: opacity .15s, transform .32s var(--ease); }
    .media .pill.open .pwrap, .media .pill.announce .pwrap { opacity: 1; pointer-events: auto; transform: none;
                                                              transition-delay: .06s; }
    .media .player { position: relative; display: flex; align-items: center; gap: 10px; width: 380px;
                     box-sizing: border-box; padding: 8px 12px 10px; cursor: default; }
    .media .art { width: 36px; height: 36px; border-radius: 8px; object-fit: cover; flex: none;
                  background: rgba(255,255,255,.1); cursor: pointer; }
    .media .txt { min-width: 0; flex: 1; cursor: pointer; }
    .media .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .media .st { font-size: 11px; color: #98989f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .media .ctl { display: flex; gap: 2px; align-items: center; flex: none; }
    .media .cb { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
                 border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
                 font: 10px -apple-system, system-ui, sans-serif; }
    .media .cb:hover { background: rgba(255,255,255,.15); }
    .media .cb.main { background: rgba(255,255,255,.15); }
    .media .prog { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: #f2f2f7;
                   transition: width 1s linear; }`;

  let ctx;
  let lastViews = [];
  let timer;
  let closeTimer;
  const pills = new Map(); // "tabId:frameId" -> pill

  // A pill opens when hovered and stays open while the cursor is anywhere on the bar, so moving on to the
  // neighbouring buttons doesn't collapse it (which would slide them away from the cursor).
  function openPill(pill) {
    clearTimeout(closeTimer);
    for (const p of pills.values()) p.root.classList.toggle('open', p === pill);
  }

  function createPill() {
    const pill = { view: null, els: {} };
    const control = (action, delta) =>
      ctx.send({ type: 'media-control', action, delta, tabId: pill.view.tabId, frameId: pill.view.frameId });

    const button = (label, title, action, delta, extra = '') => {
      const b = document.createElement('button');
      b.className = 'cb ' + extra;
      b.title = title;
      b.innerHTML = label;
      b.onclick = e => { e.stopPropagation(); control(action, delta); };
      return b;
    };
    const pipButton = size => {
      const b = button(PIP(size), 'Picture-in-picture', 'pip');
      b.onclick = ev => {
        ev.stopPropagation();
        if (pill.view.local && globalThis.__mediaPip) globalThis.__mediaPip();
        else control('pip');
      };
      return b;
    };
    const el = (tag, className) => Object.assign(document.createElement(tag), { className });

    const e = pill.els = {
      miniArt: el('img', 'mini-art'),
      miniNote: el('span', 'mini-note'),
      miniPlay: button(playIcon(14), 'Play', 'toggle'),
      miniMute: button(volumeIcon(14), 'Mute', 'mute'),
      miniPip: pipButton(14),
      art: el('img', 'art'),
      nm: el('div', 'nm'),
      st: el('div', 'st'),
      prog: el('div', 'prog'),
      prev: button(PREV, 'Previous', 'prev'),
      back: button('−10', 'Back 10 seconds', 'seek', -10),
      play: button(playIcon(16), 'Play', 'toggle', undefined, 'main'),
      fwd: button('+10', 'Forward 10 seconds', 'seek', 10),
      next: button(NEXT, 'Next', 'next'),
      pip: pipButton(16)
    };
    e.miniNote.innerHTML = svg(18, NOTE);

    const txt = el('div', 'txt');
    txt.title = 'Go to tab';
    txt.append(e.nm, e.st);
    txt.onclick = e.art.onclick = e.miniArt.onclick = () => control('focus');
    const ctl = el('div', 'ctl');
    ctl.append(e.prev, e.back, e.play, e.fwd, e.next, e.pip);
    const player = el('div', 'player');
    player.append(e.art, txt, ctl, e.prog);
    const wrap = el('div', 'pwrap');
    wrap.append(player);

    const mini = el('div', 'mini');
    mini.append(e.miniArt, e.miniNote, e.miniPlay, e.miniMute, e.miniPip);
    pill.root = el('div', 'pill');
    pill.root.addEventListener('mouseenter', () => openPill(pill));
    pill.root.append(mini, wrap);

    // The pill animates between the mini and full sizes, so it needs both as numbers.
    const measure = new ResizeObserver(() => {
      pill.root.style.setProperty('--mw', `${mini.offsetWidth}px`);
      pill.root.style.setProperty('--ph', `${player.offsetHeight}px`);
    });
    measure.observe(mini);
    measure.observe(player);
    return pill;
  }

  const artCache = new Map(); // url -> Promise<string>
  function resolveArt(src) {
    if (!src) return Promise.resolve('');
    if (src.startsWith('data:') || src.startsWith('blob:')) return Promise.resolve(src);
    try { if (new URL(src).origin === location.origin) return Promise.resolve(src); } catch (_) { return Promise.resolve(''); }
    if (!artCache.has(src)) {
      artCache.set(src, ctx.send({ type: 'fetch-image', url: src }).then(r => r || '').catch(() => ''));
    }
    return artCache.get(src);
  }

  function setArt(pill, url) {
    const e = pill.els;
    for (const img of [e.art, e.miniArt]) {
      if (url) img.src = url; else img.removeAttribute('src');
      img.style.display = url ? '' : 'none';
    }
    e.miniNote.style.display = url ? 'none' : '';
  }

  // Returns when the full-player phase ends (0 if it isn't in it).
  function update(pill, view) {
    pill.view = view;
    const e = pill.els;
    e.nm.textContent = view.title || 'Playing media';
    e.st.textContent = view.artist || view.host || '';
    // Artwork may live on another site (media from another tab): the extension fetches it and hands over
    // the picture, instead of this page loading a third-party URL.
    const src = view.artwork || view.favicon || '';
    if (pill.artSrc !== src) {
      pill.artSrc = src;
      setArt(pill, '');
      resolveArt(src).then(url => { if (pill.artSrc === src) setArt(pill, url); });
    }
    e.play.innerHTML = view.playing ? pauseIcon(16) : playIcon(16);
    e.play.title = view.playing ? 'Pause' : 'Play';
    e.miniPlay.innerHTML = view.playing ? pauseIcon(14) : playIcon(14);
    e.miniPlay.title = e.play.title;
    e.miniMute.innerHTML = view.muted ? mutedIcon(14) : volumeIcon(14);
    e.miniMute.title = view.muted ? 'Unmute' : 'Mute';
    e.pip.style.display = e.miniPip.style.display = view.canPip ? '' : 'none';
    e.pip.classList.toggle('main', !!view.pip);
    e.pip.title = e.miniPip.title = view.pip ? 'Exit picture-in-picture' : 'Picture-in-picture';
    const seekable = view.duration > 0;
    e.back.style.display = e.fwd.style.display = seekable ? '' : 'none';
    e.prev.style.display = view.canSkip?.prev ? '' : 'none';
    e.next.style.display = view.canSkip?.next ? '' : 'none';
    e.prog.style.width = seekable ? `${Math.min(100, (view.currentTime / view.duration) * 100)}%` : '0';

    const fullUntil = (view.announceAt || 0) + fullMs();
    const announce = view.playing && fullMs() > 0 && Date.now() < fullUntil;
    pill.root.classList.toggle('paused', !view.playing);
    pill.root.classList.toggle('announce', announce);
    return announce ? fullUntil : 0;
  }

  function apply(views) {
    clearTimeout(timer);
    views = lastViews = views || [];
    const seen = new Set();
    let expiry = 0;
    for (const view of views) {
      const key = `${view.tabId}:${view.frameId}`;
      seen.add(key);
      let pill = pills.get(key);
      if (!pill) { pill = createPill(); pills.set(key, pill); }
      const until = update(pill, view);
      if (until) expiry = expiry ? Math.min(expiry, until) : until;
    }
    for (const [key, pill] of pills) {
      if (!seen.has(key)) {
        pill.root.classList.add('leave');
        setTimeout(() => pill.root.remove(), 220);
        pills.delete(key);
      }
    }
    // First view = main source = bottom of the stack (the container stacks bottom-up).
    views.forEach((view, i) => {
      const root = pills.get(`${view.tabId}:${view.frameId}`).root;
      if (ctx.btn.children[i] !== root) ctx.btn.insertBefore(root, ctx.btn.children[i] || null);
    });

    ctx.setVisible(views.length > 0);
    ctx.setLive(views.some(v => v.playing));
    if (expiry) timer = setTimeout(() => apply(views), expiry - Date.now() + 50);
  }

  actionBar.register({
    id: 'media',
    title: '',
    icon: '',
    css,
    onMessage: msg => msg.type === 'media' && apply(msg.views),
    setup(c) {
      ctx = c;
      ctx.setVisible(false);
      const applyPrefs = () => { ctx.setEnabled(!siteBlocked()); apply(lastViews); };
      applyPrefs();
      Settings.onChange(applyPrefs);
      const bar = ctx.btn.closest('.bar');
      bar.addEventListener('mouseenter', () => clearTimeout(closeTimer));
      bar.addEventListener('mouseleave', () => {
        closeTimer = setTimeout(() => pills.forEach(p => p.root.classList.remove('open')), 200);
      });
      const sync = () => ctx.send({ type: 'get-media' }).then(v => apply(v)).catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
      sync();
    }
  });
})();
