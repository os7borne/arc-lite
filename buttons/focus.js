// Focus card: a pomodoro timer. On the home page it is one row (the time left and its main control); its detail page
// has the big timer and every control. The state lives in chrome.storage.local, written by focus.js.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const svg = (size, paths, fill = 'none') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const TARGET = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>';
  const CHECK = '<polyline points="5 12 10 17 19 7"/>';
  const PAUSE = '<line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/>';
  const GUARD_MS = 10000;
  const OFFER_MS = 30 * 60000; // a "start next" offer is forgotten after half an hour
  const ANNOUNCE_MS = 8000;    // how long the bar opens on its own when a phase ends
  const RED = '#ff6b57';
  const GREEN = '#30d158';

  const css = `
    .f-row { display: flex; align-items: center; gap: 10px; }
    .f-txt { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; flex: 1; }
    .f-label { font-size: 10px; color: #a1a1a8; text-transform: uppercase; letter-spacing: .06em; }
    .f-big { font-size: 21px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
    .f-sub { font-size: 12px; color: #a1a1a8; margin-top: 2px; }
    .f-paused .f-big { opacity: .55; }
    .f-title { font-weight: 600; }
    .f-pill { height: 28px; padding: 0 11px; border: 0; border-radius: 14px; background: rgba(255,255,255,.12); color: #f2f2f7;
              font: 600 12px -apple-system, system-ui, sans-serif; cursor: pointer; white-space: nowrap; flex: none; }
    .f-pill:hover:not(:disabled) { background: rgba(255,255,255,.2); }
    .f-pill.primary { background: var(--fc); color: #fff; }
    .f-pill.primary:hover:not(:disabled) { background: var(--fc); filter: brightness(1.08); }
    .f-pill.danger { background: rgba(255,107,87,.18); color: #ff9a8b; }
    .f-pill:disabled { opacity: .55; cursor: default; }
    .f-pill.confirm { box-shadow: 0 0 0 1.5px #ff6b57 inset; }
    .f-detail { box-sizing: border-box; padding: 18px 16px 16px; display: flex; flex-direction: column; align-items: center;
                gap: 12px; text-align: center; }
    .f-dots { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #a1a1a8; }
    .f-dots i { display: block; width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,.22); }
    .f-dots i.on { background: var(--fc); }
    .f-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .f-btns .f-pill { height: 30px; padding: 0 14px; border-radius: 15px; }
    .f-ring { position: relative; flex: none; display: flex; align-items: center; justify-content: center; color: var(--fc); }
    .f-ring svg.r { position: absolute; inset: 0; transform: rotate(-90deg); }
    .f-ring circle { fill: none; }
    .f-ring .rt { stroke: rgba(255,255,255,.16); }
    .f-ring .arc { stroke: var(--fc); stroke-linecap: round; transition: stroke-dashoffset .9s linear; }
    .f-ring .mid { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; color: #f2f2f7; }
    .f-cue { display: flex; align-items: center; gap: 6px; font: 600 12px -apple-system, system-ui, sans-serif;
             font-variant-numeric: tabular-nums; color: #f2f2f7; white-space: nowrap; }`;

  let ctx;
  let state = { phase: 'off' };
  let timer;
  let rings = []; // { arc, circ } for every progress ring on screen: they all move together
  let times = []; // elements showing the time left
  let signature = '';
  let guard = null; // a pending "wait, then confirm" for one control: { type, readyAt, timeout, ticker }
  let dead = false;

  const cfg = () => Settings.current.focus;
  const send = msg => ctx.send(msg);
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text ?? '' });
  const fmt = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const leftMs = () => (state.paused ? state.remainingMs : Math.max(0, state.endsAt - Date.now()));
  const offered = () => state.phase === 'off' && !!state.next && Date.now() - (state.endedAt || 0) < OFFER_MS;
  const nextMinutes = () => {
    const c = cfg();
    if (state.next === 'focus') return c.focusMin;
    return (state.cycle || 0) > 0 && state.cycle % c.longEvery === 0 ? c.longBreakMin : c.breakMin;
  };

  // After the extension is reloaded, this copy is orphaned: its timers keep firing but any chrome.* call throws.
  // Every entry point checks first and shuts down.
  function shutdown() {
    dead = true;
    clearInterval(timer);
    clearGuard();
    document.removeEventListener('visibilitychange', onVisible);
  }
  const alive = () => {
    if (dead) return false;
    if (actionBar.alive()) return true;
    shutdown();
    return false;
  };

  // --- pieces --------------------------------------------------------------------------

  // A progress ring with something in the middle (an icon path, or a list of nodes). Its arc is kept in `rings`
  // so the tick can move it.
  function ring(size, stroke, inner, iconSize) {
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const wrap = el('div', 'f-ring');
    wrap.style.cssText = `width:${size}px;height:${size}px`;
    wrap.innerHTML = `<svg class="r" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle class="rt" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/><circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/></svg>${typeof inner === 'string' && inner ? svg(iconSize, inner) : ''}`;
    if (Array.isArray(inner)) { const mid = el('div', 'mid'); mid.append(...inner); wrap.append(mid); }
    const arc = wrap.querySelector('.arc');
    arc.style.strokeDasharray = circ;
    arc.style.strokeDashoffset = circ;
    rings.push({ arc, circ });
    return wrap;
  }
  const fullRing = () => { rings[rings.length - 1].arc.style.strokeDashoffset = 0; };

  function dots() {
    const n = cfg().longEvery;
    const done = (state.cycle || 0) % n;
    const d = el('div', 'f-dots');
    d.title = `${done} of ${n} sessions before a long break`;
    d.append(...Array.from({ length: n }, (_, i) => el('i', i < done ? 'on' : '')));
    return d;
  }

  function pill(label, onClick, cls = '') {
    const b = el('button', `f-pill ${cls}`.trim(), label);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  }

  function clearGuard() {
    if (!guard) return;
    clearInterval(guard.ticker);
    clearTimeout(guard.timeout);
    guard = null;
    ctx?.busy(false);
  }

  // Pausing, skipping or stopping a focus session: ask, wait 10 seconds, then confirm. The wait is enforced by
  // focus.js; this is just the countdown. Breaks and idle states act immediately.
  function guarded(label, msg) {
    const needsWait = state.phase === 'focus' && cfg().friction !== false;
    const b = pill(label, async () => {
      if (!needsWait) return void send(msg);
      if (guard?.type === msg.type && Date.now() >= guard.readyAt) {
        clearGuard();
        return void send(msg).then(r => r?.ok === false && ctx.toast('Not yet, wait a moment'));
      }
      if (guard) return;
      await send({ type: 'focus-guard' });
      guard = { type: msg.type, readyAt: Date.now() + GUARD_MS };
      ctx.busy(true);
      b.disabled = true;
      const update = () => {
        const left = Math.ceil((guard.readyAt - Date.now()) / 1000);
        if (left > 0) { b.textContent = `Wait ${left}s…`; return; }
        b.disabled = false;
        b.classList.add('confirm');
        b.textContent = `Confirm: ${label.toLowerCase()}`;
        clearInterval(guard.ticker);
      };
      update();
      guard.ticker = setInterval(update, 250);
      guard.timeout = setTimeout(() => { clearGuard(); render(true); }, 55000); // the request expires after a minute
    }, msg.type === 'focus-stop' ? 'danger' : '');
    return b;
  }

  // --- rendering -----------------------------------------------------------------------

  function render(force) {
    if (!alive()) return;
    const ended = offered();
    const mode = ended ? 'ended' : state.phase === 'off' ? 'idle' : state.paused ? 'paused' : state.phase;
    const c = cfg();
    const sig = [mode, state.cycle, state.next, state.durationMs, state.paused, c.longEvery, c.friction, c.focusMin, c.breakMin].join('|');
    if (!force && sig === signature) return;
    signature = sig;
    clearGuard();
    rings = [];
    times = [];

    const color = mode === 'break' || (ended && state.next === 'break') ? GREEN : RED;
    for (const node of [ctx.home, ctx.detail]) node.style.setProperty('--fc', color);
    ctx.setColor(color);
    const running = mode === 'focus' || mode === 'break' || mode === 'paused';
    const label = state.paused ? 'Paused' : mode === 'break' ? 'Break' : 'Focus session';

    // --- the home section: one row
    const row = el('div', 'f-row' + (state.paused ? ' f-paused' : ''));
    if (running) {
      const big = el('span', 'f-big');
      times.push(big);
      const txt = el('div', 'f-txt');
      txt.append(el('span', 'f-label', label), big);
      row.append(ring(40, 3.5, state.paused ? PAUSE : TARGET, 16), txt);
      if (state.paused) row.append(pill('Resume', () => send({ type: 'focus-resume' }), 'primary'));
      else if (mode === 'break') row.append(pill('Start focus', () => send({ type: 'focus-skip' }), 'primary'));
      else row.append(guarded('Pause', { type: 'focus-pause' }));
    } else if (ended) {
      const txt = el('div', 'f-txt');
      txt.append(el('span', 'f-title', state.next === 'break' ? 'Focus complete' : 'Break over'), el('span', 'f-sub', `Next: ${nextMinutes()} min ${state.next}`));
      row.append(ring(40, 3.5, CHECK, 16), txt, pill(`Start ${state.next}`, () => send({ type: 'focus-start', phase: state.next }), 'primary'));
      fullRing();
    } else {
      const txt = el('div', 'f-txt');
      txt.append(el('span', 'f-title', 'Focus mode'), el('span', 'f-sub', `${c.focusMin} min focus`));
      row.append(ring(40, 3.5, TARGET, 16), txt,
        pill('Start focus', () => send({ type: 'focus-start', phase: 'focus' }), 'primary'),
        pill('Break', () => send({ type: 'focus-start', phase: 'break' })));
    }
    ctx.home.replaceChildren(row);

    // --- the detail page: the big timer and every control
    const det = el('div', 'f-detail' + (state.paused ? ' f-paused' : ''));
    if (running) {
      const big = el('span', 'f-big');
      big.style.fontSize = '24px';
      times.push(big);
      det.append(ring(96, 6, [big, el('span', 'f-label', mode === 'break' ? 'Break' : state.paused ? 'Paused' : 'Focus')], 0));
      const info = dots();
      info.append(el('span', '', `Session ${((state.cycle || 0) % c.longEvery) + 1} of ${c.longEvery}`));
      det.append(info);
      const btns = el('div', 'f-btns');
      if (state.paused) btns.append(pill('Resume', () => send({ type: 'focus-resume' }), 'primary'), guarded('Stop', { type: 'focus-stop' }));
      else if (mode === 'focus') btns.append(guarded('Pause', { type: 'focus-pause' }), guarded('Skip to break', { type: 'focus-skip' }), pill('+5', () => send({ type: 'focus-extend' })), guarded('Stop', { type: 'focus-stop' }));
      else btns.append(pill('Start focus', () => send({ type: 'focus-skip' }), 'primary'), pill('+5', () => send({ type: 'focus-extend' })), pill('Stop', () => send({ type: 'focus-stop' }), 'danger'));
      det.append(btns);
    } else if (mode === 'idle') {
      det.append(ring(96, 6, TARGET, 34), el('div', 'f-title', 'Focus mode'),
        el('div', 'f-sub', `${c.focusMin} min focus, ${c.breakMin} min break`));
      const btns = el('div', 'f-btns');
      btns.append(pill(`Start focus · ${c.focusMin} min`, () => send({ type: 'focus-start', phase: 'focus' }), 'primary'),
        pill(`Start break · ${c.breakMin} min`, () => send({ type: 'focus-start', phase: 'break' })));
      det.append(btns);
    } else if (ended) {
      const other = state.next === 'break' ? 'focus' : 'break';
      det.append(ring(96, 6, CHECK, 34), el('div', 'f-title', state.next === 'break' ? 'Focus complete' : 'Break over'));
      fullRing();
      const btns = el('div', 'f-btns');
      btns.append(pill(`Start ${state.next} · ${nextMinutes()} min`, () => send({ type: 'focus-start', phase: state.next }), 'primary'),
        pill(`Start ${other} instead`, () => send({ type: 'focus-start', phase: other })),
        pill('Not now', () => send({ type: 'focus-dismiss' })));
      det.append(btns);
    }
    ctx.detail.replaceChildren(det);

    // --- the pager button and the cue on the capsule
    let tabRing = el('span');
    if (mode === 'idle') tabRing.innerHTML = svg(20, TARGET);
    if (mode !== 'idle') {
      tabRing = ring(22, 2.5, '', 0);
      tabRing.style.setProperty('--fc', color);
      if (ended) fullRing();
    }
    ctx.setTab(tabRing);
    let cue = null;
    if (mode !== 'idle') {
      cue = el('div', 'f-cue');
      cue.style.setProperty('--fc', color);
      if (ended) {
        cue.append(ring(20, 2.5, CHECK, 10), el('span', '', `Start ${state.next}`));
        fullRing();
      } else {
        const t = el('span', 't');
        times.push(t);
        cue.append(ring(20, 2.5, state.paused ? PAUSE : '', 9), t);
      }
    }
    ctx.setIndicator(cue);
    tick();
  }

  function tick() {
    if (!alive() || state.phase === 'off') return;
    const left = leftMs();
    times.forEach(t => { t.textContent = fmt(left); });
    const frac = state.durationMs ? Math.min(1, left / state.durationMs) : 0;
    rings.forEach(r => { r.arc.style.strokeDashoffset = r.circ * (1 - frac); });
  }

  // --- state ---------------------------------------------------------------------------------

  function apply(next) {
    if (!alive()) return;
    const wasOffered = offered();
    state = next || { phase: 'off' };
    const active = state.phase !== 'off' || offered();
    ctx.setAvailable(true);      // its button and page are always there: when idle, the page starts a session
    ctx.setHomeVisible(active);  // its home section only during a session, or while the next phase is offered
    ctx.setLive(active);
    clearInterval(timer);
    if (state.phase !== 'off' && !state.paused) timer = setInterval(() => document.visibilityState === 'visible' && tick(), 1000);
    render();
    // A phase just ended: open the bar on its own for a few seconds so the offer isn't missed.
    if (!wasOffered && offered()) ctx.peek(ANNOUNCE_MS);
  }

  // chrome.* can throw synchronously once orphaned, which a promise .catch doesn't see: hence the try.
  function load() {
    if (!alive()) return;
    try {
      chrome.storage.local.get('focusState').then(r => apply(r.focusState)).catch(() => {});
    } catch (_) { shutdown(); }
  }
  function onVisible() {
    if (document.visibilityState === 'visible' && alive()) { tick(); load(); }
  }

  actionBar.register({
    id: 'focus',
    title: 'Focus mode',
    order: 30,
    color: RED,
    icon: svg(20, TARGET),
    css,
    setup(c) {
      ctx = c;
      apply(null);
      load();
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.focusState && alive()) apply(changes.focusState.newValue);
        });
      } catch (_) {} // orphaned after an extension reload
      document.addEventListener('visibilitychange', onVisible);
    }
  });
})();
