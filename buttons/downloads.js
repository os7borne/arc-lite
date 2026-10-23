// Downloads button: shows the latest download as a chip while it's new, then collapses to a folder icon.
// Hover shows the 3 most recent downloads and a button that opens the Downloads folder.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  const svg = (size, paths) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  const css = `
    .card { background: rgba(28,28,30,.96); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
            padding: 6px; width: 280px; }
    .empty { padding: 8px; color: #98989f; }
    .row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
    .row:hover { background: rgba(255,255,255,.1); }
    .row img, .chip img { width: 24px; height: 24px; flex: none; }
    .txt { min-width: 0; flex: 1; }
    .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nm.gone { text-decoration: line-through; opacity: .6; }
    .st { font-size: 11px; color: #98989f; }
    .show { display: none; flex: none; width: 26px; height: 26px; border: 0; border-radius: 6px; padding: 0;
            align-items: center; justify-content: center; color: inherit; background: rgba(255,255,255,.15);
            cursor: pointer; }
    .row:hover .show, .chip:hover .show { display: flex; }
    .show:hover { background: rgba(255,255,255,.28); }
    progress { width: 100%; height: 3px; margin-top: 3px; appearance: none; border: 0; border-radius: 2px;
               overflow: hidden; background: rgba(255,255,255,.15); }
    progress::-webkit-progress-bar { background: rgba(255,255,255,.15); }
    progress::-webkit-progress-value { border-radius: 2px; transition: width .4s linear; background-size: 200% 100%;
                                       background-image: linear-gradient(90deg, #0a84ff 0%, #6cb6ff 50%, #0a84ff 100%);
                                       animation: dl-shimmer 1.2s linear infinite; }
    @keyframes dl-shimmer { to { background-position: -200% 0; } }
    .ico { position: relative; flex: none; width: 24px; height: 24px; }
    .ico img { display: block; }
    .badge { position: absolute; right: -6px; bottom: -6px; width: 17px; height: 17px;
             box-shadow: 0 0 0 2px rgba(28,28,30,.96); animation: dl-ring 1.4s ease-out infinite; border-radius: 50%;
             background: #0a84ff; color: #fff; display: flex; align-items: center; justify-content: center;
             overflow: hidden; }
    .badge svg { animation: dl-arrow 1s var(--ease, ease-in-out) infinite; }
    @keyframes dl-ring { 0% { box-shadow: 0 0 0 2px rgba(28,28,30,.96), 0 0 0 2px rgba(10,132,255,.6); }
                         100% { box-shadow: 0 0 0 2px rgba(28,28,30,.96), 0 0 0 9px rgba(10,132,255,0); } }
    @keyframes dl-arrow { 0% { transform: translateY(-11px); opacity: 0; } 40% { opacity: 1; }
                          80%, 100% { transform: translateY(11px); opacity: 0; } }
    .st.live::after { content: ''; display: inline-block; width: 4px; height: 4px; margin-left: 6px;
                      border-radius: 50%; background: #0a84ff; animation: dl-pulse 1s ease-in-out infinite; }
    @keyframes dl-pulse { 50% { opacity: .25; } }
    .folder { display: block; width: 100%; margin-top: 4px; padding: 7px; border: 0; border-radius: 8px;
              background: rgba(255,255,255,.12); color: inherit; font: inherit; cursor: pointer; }
    .folder:hover { background: rgba(255,255,255,.2); }`;

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

  let ctx;
  let items = [];
  let hideTimer;
  let running = false;
  let rows;
  let chipId;

  function row(d) {
    const el = document.createElement('div');
    el.className = 'row';
    const img = document.createElement('img');
    if (d.icon) img.src = d.icon;
    const active = d.state === 'in_progress' && !d.paused;
    let lead = img;
    if (active) {
      lead = document.createElement('div');
      lead.className = 'ico';
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.innerHTML = svg(11, '<line x1="12" y1="4" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>');
      lead.append(img, badge);
    }
    const txt = document.createElement('div');
    txt.className = 'txt';
    const nm = document.createElement('div');
    nm.className = 'nm' + (d.exists === false ? ' gone' : '');
    nm.textContent = d.name || 'Download';
    const st = document.createElement('div');
    st.className = 'st';
    st.textContent = status(d);
    if (active) st.classList.add('live');
    txt.append(nm, st);
    if (d.state === 'in_progress') {
      const p = document.createElement('progress'); // no value when the size is unknown: indeterminate
      if (d.totalBytes > 0) { p.max = d.totalBytes; p.value = d.bytesReceived; }
      txt.append(p);
    }
    el.append(lead, txt);
    if (d.state === 'complete' && d.exists !== false) {
      const show = document.createElement('button');
      show.className = 'show';
      show.title = 'Show in folder';
      show.innerHTML = svg(16, FOLDER);
      show.onclick = e => { e.stopPropagation(); ctx.send({ type: 'show-file', id: d.id }); };
      el.append(show);
    }
    el.onclick = () => d.state === 'complete' && d.exists !== false &&
      ctx.send({ type: 'open-file', id: d.id });
    return el;
  }

  function render() {
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'empty';
      none.textContent = 'No downloads yet';
      rows.replaceChildren(none);
      return;
    }
    const d = items[0];
    const latest = row(d);
    const live = d.state === 'in_progress' && !d.paused;
    // Same download still running: update the numbers in place so the arrow animation isn't restarted.
    if (live && chipId === d.id && ctx.chip.querySelector('.badge')) {
      ctx.chip.querySelector('.st').textContent = status(d);
      const p = ctx.chip.querySelector('progress');
      if (p && d.totalBytes > 0) { p.max = d.totalBytes; p.value = d.bytesReceived; }
    } else {
      ctx.chip.replaceChildren(...latest.childNodes);
    }
    chipId = d.id;
    ctx.chip.onclick = latest.onclick;
    rows.replaceChildren(...items.map(row));
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (ctx.isHovered()) return scheduleHide(1500);
      ctx.setActive(false);
    }, ms);
  }

  function apply({ items: next, remaining }) {
    items = next;
    running = remaining < 0;
    render();
    clearTimeout(hideTimer);
    if (remaining === 0 || !items.length) return ctx.setActive(false);
    ctx.setActive(true);
    if (remaining > 0) scheduleHide(remaining);
  }

  actionBar.register({
    id: 'downloads',
    title: 'Downloads',
    icon: svg(18, FOLDER),
    css,
    onMessage: msg => msg.type === 'downloads' && apply(msg),
    setup(c) {
      ctx = c;
      const card = document.createElement('div');
      card.className = 'card';
      rows = document.createElement('div');
      const folder = document.createElement('button');
      folder.className = 'folder';
      folder.textContent = 'Open Downloads folder';
      folder.onclick = () => ctx.send({ type: 'open-folder' });
      card.append(rows, folder);
      ctx.pop.append(card);
      render();

      ctx.btn.parentElement.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      ctx.btn.parentElement.addEventListener('mouseleave', () => !running && scheduleHide(1500));

      // Switching to this tab (or loading it) picks up a download that is still showing.
      const sync = () => ctx.send({ type: 'get-downloads' }).then(s => s && apply(s)).catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
      sync();
    }
  });
})();
