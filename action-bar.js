// Action bar core: a row of buttons pinned bottom-left. Each file in buttons/ registers its own button.
(() => {
  if (window.top !== window) return;
  const previous = globalThis.__actionBar;
  if (previous) {
    if (previous.alive()) return; // already running here
    previous.destroy(); // orphan from before an extension reload
  }

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      @keyframes pop-in { from { opacity: 0; transform: translateY(6px); } }
      @media (prefers-reduced-motion: reduce) {
        * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
      }
      .bar { --ease: cubic-bezier(.2,.8,.2,1); position: relative;
             font: 13px -apple-system, system-ui, sans-serif; color: #f2f2f7;
             display: flex; align-items: flex-end; gap: 6px; }
      .slot { position: relative; display: none; flex-direction: column; align-items: flex-start; }
      .slot.on, .slot.live, .bar:hover .slot { display: flex; animation: pop-in .2s var(--ease); }
      .handle { display: none; align-items: center; justify-content: center; width: 32px; height: 32px;
                border-radius: 10px; background: rgba(28,28,30,.7); color: #f2f2f7; opacity: .35;
                cursor: pointer; transition: opacity .15s; }
      .bar.idle .handle { display: flex; }
      .bar:hover .handle { display: none; }
      .btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px;
             border-radius: 10px; background: rgba(28,28,30,.7); color: #f2f2f7; opacity: .35;
             cursor: pointer; transition: opacity .15s; }
      .slot:hover .btn { opacity: 1; }
      .slot.on .btn { display: none; }
      .chip { display: none; align-items: center; gap: 10px; width: 280px; padding: 8px 12px; cursor: pointer;
              background: rgba(28,28,30,.96); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
      .slot.on .chip { display: flex; animation: pop-in .25s var(--ease); }
      .pop { display: none; position: absolute; bottom: 100%; left: 0; padding-bottom: 6px; }
      .slot:hover .pop:not(:empty) { display: block; animation: pop-in .18s var(--ease); }
      /* While a chip is open, a lifting slot (media) moves above the bar instead of pushing the chip aside.
         The padding bridges the gap so the bar stays hovered. It hides while another slot's popover is open. */
      .slot.lift { transition: opacity .15s; }
      .bar.stack .slot.lift { position: absolute; left: 0; bottom: 100%; padding-bottom: 6px; }
      .bar.stack:has(.slot:not(.lift):hover .pop:not(:empty)) .slot.lift { opacity: 0; pointer-events: none; }
      .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px;
               border-radius: 10px; background: #1c1c1e; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3);
               opacity: 0; pointer-events: none; transition: opacity .3s; }
      .toast.on { opacity: 1; }
    </style>
    <div class="toast"></div>
    <div class="bar idle">
      <div class="handle" title="Action bar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
      </div>
    </div>`;

  const bar = root.querySelector('.bar');
  const toastEl = root.querySelector('.toast');
  let toastTimer;

  function alive() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

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

  const slotsShown = () => [...bar.querySelectorAll('.slot')].filter(s => s.style.display !== 'none');

  // The bar collapses to the handle icon unless a button is showing something (a chip, or "live"). While a
  // chip is open the bar stacks: lifting slots move above it.
  function refresh() {
    const shown = slotsShown();
    const busy = shown.some(s => s.classList.contains('on') || s.classList.contains('live'));
    bar.classList.toggle('idle', !busy);
    const chip = shown.some(s => s.classList.contains('on') && !s.classList.contains('lift'));
    // Un-stacking waits until the cursor leaves, so a pill doesn't drop out from under it.
    if (chip || !bar.matches(':hover')) bar.classList.toggle('stack', chip);
  }

  // Runs a layout change, then slides every slot that moved from where it was to where it is now.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const slides = new Map(); // slot -> running slide
  function layout(change) {
    const rect = s => s.getBoundingClientRect();
    const before = new Map(slotsShown().map(s => [s, rect(s)]));
    slides.forEach(a => a.cancel());
    slides.clear();
    change();
    if (reduceMotion.matches) return;
    for (const s of slotsShown()) {
      const a = before.get(s);
      const b = rect(s);
      if (!a || !a.width || !b.width) continue;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const anim = s.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
      slides.set(s, anim);
      anim.onfinish = anim.oncancel = () => slides.get(s) === anim && slides.delete(s);
    }
  }
  bar.addEventListener('mouseleave', () => layout(refresh));

  const messageHandlers = [];
  if (alive()) {
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type === 'toast') toast(msg.text);
      messageHandlers.forEach(h => h(msg));
    });
  }

  // def: { id, title, icon (svg string), onClick?, css?, lift?, onMessage?(msg), setup?(ctx) }
  // lift: this slot moves above the bar, instead of beside the chip, while another button's chip is open.
  function register(def) {
    const slot = document.createElement('div');
    slot.className = `slot ${def.id}`;
    if (def.lift) slot.classList.add('lift');
    const pop = document.createElement('div');
    pop.className = 'pop';
    const chip = document.createElement('div');
    chip.className = 'chip';
    const btn = document.createElement('div');
    btn.className = 'btn';
    btn.title = def.title || '';
    btn.innerHTML = def.icon || '';
    if (def.onClick) btn.onclick = def.onClick;
    slot.append(pop, chip, btn);

    if (def.css) {
      const style = document.createElement('style');
      style.textContent = def.css;
      root.prepend(style);
    }
    if (def.onMessage) messageHandlers.push(def.onMessage);
    bar.append(slot);

    // A slot shows only if its button is turned on in settings, isn't disabled for this site, and has
    // something to show (shown).
    const settingKey = { 'copy-url': 'copyUrl' }[def.id] || def.id;
    let shown = true;
    let siteOn = true;
    const refreshSlot = () => {
      const on = settings().buttons[settingKey] !== false && siteOn && shown;
      slot.style.display = on ? '' : 'none';
    };
    slotRefreshers.push(refreshSlot);

    const ctx = {
      pop, chip, btn, send, toast,
      // on: show the chip. live: keep this button showing while the bar is collapsed.
      setActive: on => {
        if (slot.classList.contains('on') !== on) layout(() => { slot.classList.toggle('on', on); refresh(); });
      },
      setLive: on => { slot.classList.toggle('live', on); refresh(); },
      setVisible: on => { shown = on; refreshSlot(); refresh(); },
      setEnabled: on => { siteOn = on; refreshSlot(); refresh(); },
      isHovered: () => slot.matches(':hover')
    };
    def.setup?.(ctx);
    refreshSlot();
    return ctx;
  }

  // Hidden until settings have loaded, when turned off, and during fullscreen video (also covers a
  // fullscreen player inside an iframe).
  let ready = false;
  const settings = () => globalThis.Settings.current;
  const slotRefreshers = [];
  function refreshHost() {
    host.style.display = !ready || !settings().bar.enabled || document.fullscreenElement ? 'none' : '';
  }
  function applySettings() {
    refreshHost();
    slotRefreshers.forEach(fn => fn());
    refresh();
  }
  document.addEventListener('fullscreenchange', refreshHost);
  globalThis.Settings.load().then(() => { ready = true; applySettings(); }).catch(() => {});
  globalThis.Settings.onChange(applySettings);
  refreshHost();

  globalThis.__actionBar = { register, toast, send, alive, destroy: () => host.remove() };
  document.documentElement.appendChild(host);
})();
