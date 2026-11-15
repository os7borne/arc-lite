// Downloads card. On the home page: the latest download (progress while it runs). Its detail page: the latest three
// downloads as full rows (open, show in folder, drag onto the page), and links to all of them. A new or finished
// download also opens the bar on its own for a moment, and its progress shows as a cue on the capsule.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  const ARROW = '<line x1="12" y1="4" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>';
  const CHECK = '<polyline points="5 12 10 17 19 7"/>';
  const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>';
  const svg = (size, paths) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const BLUE = '#0a84ff';

  const css = `
    .d-title { padding: 0 8px 4px; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: #a1a1a8; }
    .d-detail { box-sizing: border-box; padding: 10px 8px 8px; display: flex; flex-direction: column; }
    .d-links { display: flex; gap: 14px; padding: 8px 8px 0; font-size: 12px; }
    .d-links button { padding: 0; border: 0; background: none; color: #d1d1d6; font: inherit; cursor: pointer; }
    .d-links button:hover { color: #fff; text-decoration: underline; }
    .d-empty { padding: 8px; color: #a1a1a8; }
    .row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
    .row:hover { background: rgba(255,255,255,.08); }
    .row.plain { cursor: inherit; padding: 0; }
    .row.plain:hover { background: none; }
    /* the icon tile: the same size and shape as the media artwork and the focus ring beside it on the home card */
    .tile { position: relative; display: flex; align-items: center; justify-content: center; flex: none; width: 40px; height: 40px;
            border-radius: 8px; background: rgba(255,255,255,.08); color: #f2f2f7; }
    .tile.sm { width: 36px; height: 36px; }
    .tile img.icon { display: block; width: 24px; height: 24px; }
    .tile img.thumb { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .txt { min-width: 0; flex: 1; }
    .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .nm.gone { text-decoration: line-through; opacity: .6; }
    .st { font-size: 11px; color: #a1a1a8; }
    .show { display: none; flex: none; width: 26px; height: 26px; border: 0; border-radius: 6px; padding: 0; align-items: center;
            justify-content: center; color: inherit; background: rgba(255,255,255,.15); cursor: pointer; }
    .row:hover .show { display: flex; }
    .show:hover { background: rgba(255,255,255,.28); }
    progress { width: 100%; height: 3px; margin-top: 4px; appearance: none; border: 0; border-radius: 2px; overflow: hidden;
               background: rgba(255,255,255,.15); display: block; }
    progress::-webkit-progress-bar { background: rgba(255,255,255,.15); }
    progress::-webkit-progress-value { border-radius: 2px; transition: width .4s linear; background-size: 200% 100%;
                                       background-image: linear-gradient(90deg, #0a84ff 0%, #6cb6ff 50%, #0a84ff 100%);
                                       animation: dl-shimmer 1.2s linear infinite; }
    @keyframes dl-shimmer { to { background-position: -200% 0; } }
    .badge { position: absolute; right: -5px; bottom: -5px; width: 17px; height: 17px; box-shadow: 0 0 0 2px rgba(28,28,30,.96);
             animation: dl-ring 1.4s ease-out infinite; border-radius: 50%; background: #0a84ff; color: #fff; display: flex;
             align-items: center; justify-content: center; overflow: hidden; }
    .badge svg { animation: dl-arrow 1s var(--ease, ease-in-out) infinite; }
    @keyframes dl-ring { 0% { box-shadow: 0 0 0 2px rgba(28,28,30,.96), 0 0 0 2px rgba(10,132,255,.6); }
                         100% { box-shadow: 0 0 0 2px rgba(28,28,30,.96), 0 0 0 9px rgba(10,132,255,0); } }
    @keyframes dl-arrow { 0% { transform: translateY(-11px); opacity: 0; } 40% { opacity: 1; }
                          80%, 100% { transform: translateY(11px); opacity: 0; } }
    .st.live::after { content: ''; display: inline-block; width: 4px; height: 4px; margin-left: 6px; border-radius: 50%;
                      background: #0a84ff; animation: dl-pulse 1s ease-in-out infinite; }
    @keyframes dl-pulse { 50% { opacity: .25; } }
    .row { user-select: none; }
    .ghost { position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 8px; max-width: 240px; padding: 6px 10px;
             border-radius: 10px; background: rgba(28,28,30,.96); color: #f2f2f7; font: 13px -apple-system, system-ui, sans-serif;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 6px 24px rgba(0,0,0,.35);
             pointer-events: none; opacity: .92; }
    .ghost img { width: 20px; height: 20px; }
    .dcue { display: flex; align-items: center; gap: 6px; font: 600 12px -apple-system, system-ui, sans-serif;
            font-variant-numeric: tabular-nums; color: #f2f2f7; white-space: nowrap; }
    .dcue .dot { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%;
                 background: #0a84ff; color: #fff; overflow: hidden; }
    .dcue .dot.done { background: #30d158; }
    .dcue .dot svg { animation: dl-arrow 1s var(--ease, ease-in-out) infinite; }
    .dcue .dot.done svg { animation: none; }`;

  const fmt = n => {
    if (!n || n < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const status = d => {
    if (d.state === 'in_progress') return d.paused ? 'Paused' : `${fmt(d.bytesReceived)} of ${fmt(d.totalBytes) || '?'}`;
    if (d.state === 'interrupted') return 'Failed';
    return d.exists === false ? 'Deleted' : fmt(d.fileSize) || 'Done';
  };
  const pct = d => (d.totalBytes > 0 ? `${Math.floor((d.bytesReceived / d.totalBytes) * 100)}%` : '');
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text ?? '' });

  let ctx;
  let items = [];         // the latest few, deleted ones included: the downloads page
  let latest = null;      // the latest file that still exists: the home card and the cue
  let hideTimer;
  let live = false;       // a recent or running download: its cue shows on the capsule
  let signature = '';
  let cuePct;             // the percentage text in the capsule's cue
  let lastPeekKey = '';   // which download, in which state, last opened the bar on its own
  let liveRows = [];      // rows whose numbers update in place while a download runs
  let dragging = false;
  let deferred;           // a download update that arrived mid-drag; re-rendering would destroy the dragged element

  // Dragging a finished download onto the page. A native drag can't give a page a real file, so the row follows
  // the pointer itself and the background script drops the file at the release point (DevTools protocol).
  const draggable = d => d.state === 'complete' && d.exists !== false && !!d.path;
  let suppressClick = false;

  function makeGhost(d) {
    const g = el('div', 'ghost');
    const img = document.createElement('img');
    if (d.icon) img.src = d.icon;
    g.append(img, d.name || 'Download');
    ctx.root.append(g);
    return g;
  }

  function attachDrag(row, d) {
    if (!draggable(d)) return;
    row.ondragstart = e => e.preventDefault();
    row.onpointerdown = e => {
      if (e.button !== 0 || e.target.closest('.show') || Settings.current.downloads.dragToPage === false) return;
      const sx = e.clientX, sy = e.clientY;
      let ghost;
      // Listen on the window, not the row: the row can be re-rendered or hidden mid-drag, which would drop the
      // pointer capture and leave a release unseen.
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const move = ev => {
        if (!ev.buttons) return end(ev); // released outside the window: end without dropping
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
          dragging = true;
          ctx.busy(true);
          ghost = makeGhost(d);
        }
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      };
      const cancel = ev => ev.key === 'Escape' && end(ev);
      const end = ev => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', end, true);
        removeEventListener('pointercancel', end, true);
        removeEventListener('blur', end);
        removeEventListener('keydown', cancel, true);
        if (!ghost) return;
        ghost.remove();
        dragging = false;
        ctx.busy(false);
        suppressClick = true; // the release would otherwise count as a click and open the file
        setTimeout(() => { suppressClick = false; });
        if (deferred) { const m = deferred; deferred = null; apply(m); }
        // Releasing over the bar itself (or pressing Escape) cancels instead of dropping.
        if (ev.type === 'pointerup' && !ctx.root.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bar')) {
          ctx.send({ type: 'drop-file', id: d.id, x: ev.clientX, y: ev.clientY })
            .then(r => ctx.toast(r?.error || 'Dropped'));
        }
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', end, true);
      addEventListener('pointercancel', end, true);
      addEventListener('blur', end);
      addEventListener('keydown', cancel, true);
    };
  }

  // One download as a row. `full` rows (the detail page) open the file on click, show in folder, and can be dragged;
  // the home section's row is only a summary.
  function row(d, full = true) {
    const r = el('div', 'row' + (full ? '' : ' plain'));
    r._id = d.id;
    const active = d.state === 'in_progress' && !d.paused;
    const lead = el('div', 'tile' + (full ? ' sm' : ''));
    if (d.thumb && Settings.current.downloads.thumbnails !== false) {
      const img = el('img', 'thumb');
      img.src = d.thumb;
      lead.append(img);
    } else if (d.icon) {
      const img = el('img', 'icon');
      img.src = d.icon;
      lead.append(img);
    } else {
      lead.innerHTML = svg(20, FILE);
    }
    if (active) {
      const badge = el('div', 'badge');
      badge.innerHTML = svg(11, ARROW);
      lead.append(badge);
    }
    const txt = el('div', 'txt');
    const nm = el('div', 'nm' + (d.exists === false ? ' gone' : ''), d.name || 'Download');
    const st = el('div', 'st' + (active ? ' live' : ''), status(d));
    txt.append(nm, st);
    r._st = st;
    if (d.state === 'in_progress') {
      const p = document.createElement('progress'); // no value when the size is unknown: indeterminate
      if (d.totalBytes > 0) { p.max = d.totalBytes; p.value = d.bytesReceived; }
      txt.append(p);
      r._p = p;
    }
    r.append(lead, txt);
    if (full) {
      if (d.state === 'complete' && d.exists !== false) {
        const show = el('button', 'show');
        show.type = 'button';
        show.title = 'Show in folder';
        show.innerHTML = svg(16, FOLDER);
        show.onclick = e => { e.stopPropagation(); ctx.send({ type: 'show-file', id: d.id }); };
        r.append(show);
      }
      attachDrag(r, d);
      if (draggable(d)) r.title = 'Drag onto the page to drop the file';
      r.onclick = () => !suppressClick && d.state === 'complete' && d.exists !== false && ctx.send({ type: 'open-file', id: d.id });
    }
    return r;
  }

  // Numbers of a running download change every moment: update them in place so the arrow animation isn't restarted
  // and the rows under the pointer aren't rebuilt.
  function updateLive() {
    if (cuePct && latest) cuePct.textContent = pct(latest);
    for (const r of liveRows) {
      const d = [...items, latest].find(x => x && x.id === r._id);
      if (!d) continue;
      r._st.textContent = status(d) + (r._suffix || '');
      if (r._p && d.totalBytes > 0) { r._p.max = d.totalBytes; r._p.value = d.bytesReceived; }
    }
  }

  function render() {
    const sig = (live ? 'live' : 'rest') + '|' + (latest ? latest.id : '-') + '|' + items.map(d => [d.id, d.state, d.paused, d.exists, d.thumb ? 1 : 0, d.name, d.path ? 1 : 0].join(':')).join(',');
    if (signature && sig === signature) return updateLive();
    signature = sig;
    liveRows = [];
    const track = r => { if (r._p) liveRows.push(r); return r; };

    // home: the latest download that still exists, as a summary (deleted ones are only on the downloads page)
    if (latest) {
      const first = track(row(latest, false));
      const earlier = items.filter(d => d.exists !== false && d.id !== latest.id).length;
      if (earlier) {
        first._suffix = ` · +${earlier} earlier`;
        first._st.textContent += first._suffix;
      }
      ctx.home.replaceChildren(first);
    } else {
      ctx.home.replaceChildren();
    }

    // detail: the latest three
    const det = el('div', 'd-detail');
    det.append(el('div', 'd-title', 'Downloads'));
    if (!items.length) det.append(el('div', 'd-empty', 'No downloads yet'));
    for (const d of items.slice(0, 3)) det.append(track(row(d, true)));
    const links = el('div', 'd-links');
    const all = el('button', '', 'All downloads');
    all.type = 'button';
    all.onclick = () => ctx.send({ type: 'open-downloads-page' });
    const folder = el('button', '', 'Open folder');
    folder.type = 'button';
    folder.onclick = () => ctx.send({ type: 'open-folder' });
    links.append(all, folder);
    det.append(links);
    ctx.detail.replaceChildren(det);

    // the cue on the capsule: an arrow badge and the percentage, or a tick when it's done
    let cue = null;
    cuePct = null;
    if (live && latest) {
      const d = latest;
      const running = d.state === 'in_progress';
      cue = el('div', 'dcue');
      const dot = el('span', 'dot' + (running ? '' : ' done'));
      dot.innerHTML = svg(10, running ? ARROW : CHECK);
      cue.append(dot);
      if (running) {
        cuePct = el('span', '', pct(d));
        cue.append(cuePct);
      }
    }
    ctx.setIndicator(cue);
    updateLive();
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (dragging) return scheduleHide(1500);
      live = false;
      ctx.setLive(false);
      ctx.setHomeVisible(false);
      render();
    }, ms);
  }

  function apply(msg) {
    if (dragging) { deferred = msg; return; }
    const { items: next, remaining, latest: lt } = msg;
    items = next;
    latest = lt || null;
    clearTimeout(hideTimer);
    live = remaining !== 0 && !!latest;
    ctx.setAvailable(items.length > 0);   // its button and the latest-three page
    ctx.setHomeVisible(live);              // its home section only while a download is running or just finished
    ctx.setLive(live);
    render();
    // A new download, or one that just finished, opens the bar on its own for a moment.
    const key = live ? `${latest.id}:${latest.state}` : '';
    if (key && key !== lastPeekKey) {
      lastPeekKey = key;
      ctx.peek(remaining > 0 ? remaining : (Settings.current.downloads.showSeconds ?? 6) * 1000);
    } else if (!live) {
      lastPeekKey = '';
      ctx.peek(0);
    }
    if (live && remaining > 0) scheduleHide(remaining);
  }

  actionBar.register({
    id: 'downloads',
    title: 'Downloads',
    order: 20,
    color: BLUE,
    icon: `<span style="display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${BLUE};color:#fff">${svg(11, ARROW)}</span>`,
    css,
    onMessage: msg => msg.type === 'downloads' && apply(msg),
    setup(c) {
      ctx = c;
      // Switching to this tab (or loading it) picks up a download that is still showing.
      const sync = () => ctx.send({ type: 'get-downloads' }).then(s => s && apply(s)).catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
      sync();
    }
  });
})();
