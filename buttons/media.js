// Media card. On the home page: the source that's playing (the latest to start), with play/pause. Its detail page: the
// full player for one source, with a small pager to move between sources when more than one is playing or paused.
// New media also opens the bar on its own for a few seconds, and its artwork and moving bars show on the capsule.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const fullMs = () => (Settings.current.media.announceSeconds || 0) * 1000;
  const siteBlocked = () => Settings.hostMatches(location.hostname, Settings.current.media.hideOnSites);

  const svg = (size, inner, fill = 'none') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const NOTE = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
  const playIcon = size => svg(size, '<polygon points="5 3 19 12 5 21 5 3"/>', 'currentColor');
  const pauseIcon = size => svg(size, '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', 'currentColor');
  const SPEAKER = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>';
  const volumeIcon = size => svg(size, SPEAKER + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>');
  const mutedIcon = size => svg(size, SPEAKER + '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>');
  const PIP = size => svg(size, '<rect x="2" y="4" width="20" height="14" rx="2"/><rect x="12" y="10" width="7" height="5" fill="currentColor"/>');
  const PREV = svg(16, '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>', 'currentColor');
  const NEXT = svg(16, '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>', 'currentColor');
  const CHEV_L = svg(14, '<polyline points="15 18 9 12 15 6"/>');
  const CHEV_R = svg(14, '<polyline points="9 18 15 12 9 6"/>');

  const css = `
    .m-row { display: flex; align-items: center; gap: 10px; }
    .m-art { display: block; flex: none; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,.1); }
    .m-note { display: flex; align-items: center; justify-content: center; flex: none; width: 40px; height: 40px; border-radius: 8px;
              background: rgba(255,255,255,.1); color: #d1d1d6; }
    .m-txt { min-width: 0; flex: 1; line-height: 1.25; }
    .m-nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-st { font-size: 11px; color: #a1a1a8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-bar { margin-top: 8px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.14); overflow: hidden; }
    .m-bar i { display: block; height: 3px; width: 0; border-radius: 2px; background: #f2f2f7; transition: width 1s linear; }
    .m-btn { display: flex; align-items: center; justify-content: center; flex: none; min-width: 28px; height: 28px; padding: 0; border: 0;
             border-radius: 14px; background: transparent; color: #f2f2f7; cursor: pointer; font: 600 11px -apple-system, system-ui, sans-serif; }
    .m-btn:hover { background: rgba(255,255,255,.14); }
    .m-btn.main { background: #f2f2f7; color: #1c1c1e; width: 40px; height: 40px; border-radius: 20px; }
    .m-btn.main:hover { background: #fff; }
    .m-btn.round { background: rgba(255,255,255,.14); width: 28px; }
    .m-btn.on { background: rgba(255,255,255,.22); }
    .m-detail { box-sizing: border-box; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 12px; }
    .m-detail .m-art, .m-detail .m-note { width: 72px; height: 72px; border-radius: 10px; }
    .m-big { font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-times { display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: #a1a1a8; font-variant-numeric: tabular-nums; }
    .m-ctl { display: flex; align-items: center; justify-content: center; gap: 6px; }
    .m-pager { display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 12px; color: #a1a1a8; }
    .m-link { cursor: pointer; }
    .mcue { display: flex; align-items: center; gap: 6px; }
    .mcue img { display: block; width: 20px; height: 20px; border-radius: 5px; object-fit: cover; }
    .mbars { display: flex; align-items: flex-end; gap: 2px; height: 12px; }
    .mbars i { width: 3px; height: 100%; border-radius: 1px; background: #f2f2f7; transform-origin: bottom; animation: mcue 1s ease-in-out infinite; }
    .mbars i:nth-child(2) { animation-delay: -.35s; }
    .mbars i:nth-child(3) { animation-delay: -.7s; }
    @keyframes mcue { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }`;

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const keyOf = v => `${v.tabId}:${v.frameId}`;
  const mmss = s => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

  let ctx;
  let views = [];
  let selKey = '';      // which source the detail page shows
  let timer;
  const arts = new Map();       // source key -> { src, url }
  const artCache = new Map();   // url -> Promise<string>

  // --- the capsule cue: artwork and moving bars -------------------------------------------

  const cue = el('div', 'mcue');
  const cueArt = el('img');
  cueArt.alt = '';
  cueArt.style.display = 'none';
  cue.append(cueArt, el('div', 'mbars', '<i></i><i></i><i></i>'));

  // --- artwork ---------------------------------------------------------------------------

  // Artwork may live on another site (media from another tab): the extension fetches it and hands over the picture,
  // instead of this page loading a third-party URL.
  function resolveArt(src) {
    if (!src) return Promise.resolve('');
    if (src.startsWith('data:') || src.startsWith('blob:')) return Promise.resolve(src);
    try { if (new URL(src).origin === location.origin) return Promise.resolve(src); } catch (_) { return Promise.resolve(''); }
    if (!artCache.has(src)) artCache.set(src, ctx.send({ type: 'fetch-image', url: src }).then(r => r || '').catch(() => ''));
    return artCache.get(src);
  }
  function loadArt(view) {
    const key = keyOf(view);
    const src = view.artwork || view.favicon || '';
    const cur = arts.get(key);
    if (cur && cur.src === src) return;
    arts.set(key, { src, url: '' });
    resolveArt(src).then(url => { if (arts.get(key)?.src === src) { arts.get(key).url = url; paint(); } });
  }
  const artOf = view => (view && arts.get(keyOf(view))?.url) || '';

  // --- the home section and the detail page: built once, then repainted in place ----------

  const control = (view, action, delta) => view && ctx.send({ type: 'media-control', action, delta, tabId: view.tabId, frameId: view.frameId });
  const button = (html, label, cls, onClick) => {
    const b = el('button', 'm-btn ' + (cls || ''), html);
    b.type = 'button';
    b.title = b.ariaLabel = label;
    b.onclick = e => { e.stopPropagation(); onClick(); };
    return b;
  };
  const lead = () => views.find(v => v.playing) || views[0];
  const selected = () => views.find(v => keyOf(v) === selKey) || lead();

  const H = {}; // the home section's pieces
  const D = {}; // the detail page's pieces

  function build() {
    // home
    H.art = el('img', 'm-art'); H.art.alt = '';
    H.note = el('div', 'm-note', svg(20, NOTE));
    H.nm = el('div', 'm-nm'); H.st = el('div', 'm-st');
    const txt = el('div', 'm-txt'); txt.append(H.nm, H.st);
    H.play = button('', 'Play', 'main', () => control(lead(), 'toggle'));
    H.play.style.cssText = 'width:28px;height:28px;border-radius:14px';
    const row = el('div', 'm-row'); row.append(H.art, H.note, txt, H.play);
    H.fill = el('i');
    const bar = el('div', 'm-bar'); bar.append(H.fill);
    ctx.home.append(row, bar);

    // detail
    D.art = el('img', 'm-art'); D.art.alt = '';
    D.note = el('div', 'm-note', svg(28, NOTE));
    D.nm = el('div', 'm-big'); D.artist = el('div', 'm-st'); D.meta = el('div', 'm-st');
    D.artist.style.fontSize = '13px';
    const info = el('div', 'm-txt'); info.append(D.nm, D.artist, D.meta);
    info.title = 'Go to tab';
    info.classList.add('m-link');
    info.onclick = () => control(selected(), 'focus');
    D.art.onclick = D.note.onclick = () => control(selected(), 'focus');
    const top = el('div', 'm-row'); top.style.gap = '12px'; top.append(D.art, D.note, info);

    D.fill = el('i');
    const bar2 = el('div', 'm-bar'); bar2.style.marginTop = '0'; bar2.append(D.fill);
    D.cur = el('span'); D.dur = el('span');
    const times = el('div', 'm-times'); times.append(D.cur, D.dur);
    const prog = el('div'); prog.append(bar2, times);

    D.back = button('−10', 'Back 10 seconds', '', () => control(selected(), 'seek', -10));
    D.prev = button(PREV, 'Previous', '', () => control(selected(), 'prev'));
    D.play = button('', 'Play', 'main', () => control(selected(), 'toggle'));
    D.next = button(NEXT, 'Next', '', () => control(selected(), 'next'));
    D.fwd = button('+10', 'Forward 10 seconds', '', () => control(selected(), 'seek', 10));
    D.mute = button('', 'Mute', '', () => control(selected(), 'mute'));
    D.pip = button(PIP(16), 'Picture-in-picture', '', () => {
      const v = selected();
      if (v?.local && globalThis.__mediaPip) globalThis.__mediaPip(); else control(v, 'pip');
    });
    const ctl = el('div', 'm-ctl'); ctl.append(D.back, D.prev, D.play, D.next, D.fwd, D.mute, D.pip);

    D.left = button(CHEV_L, 'Previous source', '', () => step(-1));
    D.right = button(CHEV_R, 'Next source', '', () => step(1));
    D.label = el('span');
    D.pager = el('div', 'm-pager'); D.pager.append(D.left, D.label, D.right);

    const det = el('div', 'm-detail'); det.append(top, prog, ctl, D.pager);
    ctx.detail.append(det);
  }

  function step(dir) {
    const i = views.findIndex(v => keyOf(v) === keyOf(selected()));
    const next = views[(i + dir + views.length) % views.length];
    if (next) { selKey = keyOf(next); paint(); }
  }

  function setArtEl(img, note, url) {
    if (url) img.src = url; else img.removeAttribute('src');
    img.style.display = url ? '' : 'none';
    note.style.display = url ? 'none' : '';
  }

  function paint() {
    const l = lead();
    const s = selected();
    if (!l) return;

    // home: the lead source
    H.nm.textContent = l.title || 'Playing media';
    const more = views.length - 1;
    H.st.textContent = [l.artist || l.host || '', more > 0 ? `+${more} more` : ''].filter(Boolean).join(' · ');
    setArtEl(H.art, H.note, artOf(l));
    H.play.innerHTML = l.playing ? pauseIcon(12) : playIcon(12);
    H.play.title = H.play.ariaLabel = l.playing ? 'Pause' : 'Play';
    H.fill.style.width = l.duration > 0 ? `${Math.min(100, (l.currentTime / l.duration) * 100)}%` : '0';
    H.fill.parentElement.style.visibility = l.duration > 0 ? '' : 'hidden';

    // detail: the selected source
    D.nm.textContent = s.title || 'Playing media';
    D.artist.textContent = s.artist || '';
    D.artist.style.display = s.artist ? '' : 'none';
    D.meta.textContent = [s.host, s.local ? 'this tab' : ''].filter(Boolean).join(' · ');
    setArtEl(D.art, D.note, artOf(s));
    const seekable = s.duration > 0;
    D.fill.style.width = seekable ? `${Math.min(100, (s.currentTime / s.duration) * 100)}%` : '0';
    D.cur.textContent = seekable ? mmss(s.currentTime) : '';
    D.dur.textContent = seekable ? mmss(s.duration) : '';
    D.back.style.display = D.fwd.style.display = seekable ? '' : 'none';
    D.prev.style.display = s.canSkip?.prev ? '' : 'none';
    D.next.style.display = s.canSkip?.next ? '' : 'none';
    D.play.innerHTML = s.playing ? pauseIcon(16) : playIcon(16);
    D.play.title = D.play.ariaLabel = s.playing ? 'Pause' : 'Play';
    D.mute.innerHTML = s.muted ? mutedIcon(16) : volumeIcon(16);
    D.mute.title = D.mute.ariaLabel = s.muted ? 'Unmute' : 'Mute';
    D.mute.classList.toggle('on', !!s.muted);
    D.pip.style.display = s.canPip ? '' : 'none';
    D.pip.classList.toggle('on', !!s.pip);
    D.pager.style.display = views.length > 1 ? '' : 'none'; // gone entirely with one source: no empty gap
    D.label.textContent = `${views.findIndex(v => keyOf(v) === keyOf(s)) + 1} of ${views.length} sources`;

    // the tab on the pager: the lead's artwork, else a note; the cue on the capsule follows the one that's playing
    const t = el('span');
    const url = artOf(l);
    t.innerHTML = url ? '' : svg(20, NOTE);
    if (url) { const img = el('img'); img.alt = ''; img.src = url; img.style.cssText = 'width:22px;height:22px;border-radius:5px;object-fit:cover'; t.append(img); }
    ctx.setTab(t);
    const playing = views.find(v => v.playing);
    const cueUrl = playing ? artOf(playing) : '';
    if (cueUrl) cueArt.src = cueUrl; else cueArt.removeAttribute('src');
    cueArt.style.display = cueUrl ? '' : 'none';
  }

  // Returns when the announcement of new media ends (0 if there isn't one).
  function announceUntil(view) {
    const until = (view.announceAt || 0) + fullMs();
    return view.playing && fullMs() > 0 && Date.now() < until ? until : 0;
  }

  function apply(next) {
    clearTimeout(timer);
    views = next || [];
    views.forEach(loadArt);
    if (!views.some(v => keyOf(v) === selKey)) selKey = views[0] ? keyOf(lead()) : '';
    ctx.setAvailable(views.length > 0);
    ctx.setLive(views.some(v => v.playing));
    ctx.setIndicator(cue);
    if (views.length) paint();
    // New media announces itself: open the bar on its own for a few seconds.
    let expiry = 0;
    for (const v of views) { const u = announceUntil(v); if (u) expiry = expiry ? Math.min(expiry, u) : u; }
    ctx.peek(expiry ? Math.max(1, expiry - Date.now()) : 0);
    if (expiry) timer = setTimeout(() => apply(views), expiry - Date.now() + 50);
  }

  actionBar.register({
    id: 'media',
    title: 'Media',
    order: 10,
    icon: svg(20, NOTE),
    css,
    onMessage: msg => msg.type === 'media' && apply(msg.views),
    setup(c) {
      ctx = c;
      build();
      const applyPrefs = () => { ctx.setEnabled(!siteBlocked()); apply(views); };
      applyPrefs();
      Settings.onChange(applyPrefs);
      const sync = () => ctx.send({ type: 'get-media' }).then(v => apply(v)).catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
      sync();
    }
  });
})();
