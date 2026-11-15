// Snooze card: close this tab now and bring it back later. Its page is a short list of times; "Custom…" opens the
// command bar already typed for it ("snooze "), where "fri" or "tomorrow 9am" work.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar || !globalThis.SnoozeTimes) return;

  const CLOCK = '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>';
  const svg = size => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CLOCK}</svg>`;
  const css = `
    .s-detail { box-sizing: border-box; padding: 8px 6px; display: flex; flex-direction: column; }
    .s-title { padding: 6px 10px 6px; font-weight: 650; }
    .s-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; height: 32px; padding: 0 10px;
             border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .s-row:hover { background: rgba(255,255,255,.1); }
    .s-row small { color: #a1a1a8; font-size: 12px; }
    .s-row.custom { margin-top: 6px; border-top: 1px solid rgba(255,255,255,.08); border-radius: 0 0 8px 8px; }`;

  let ctx;
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text ?? '' });

  // The times are relative to now, so they are worked out again each time the page slides into view.
  function paint() {
    const now = new Date();
    const det = el('div', 's-detail');
    det.append(el('div', 's-title', 'Snooze this tab until'));
    for (const p of SnoozeTimes.presets(now)) {
      const b = el('button', 's-row');
      b.type = 'button';
      b.append(el('span', '', p.label), Object.assign(el('small'), { textContent: SnoozeTimes.fmtWhen(p.when, now) }));
      b.onclick = () => {
        // worked out at the click, not when the list was drawn, so "in 1 hour" is an hour from now
        const fresh = SnoozeTimes.presets(new Date()).find(x => x.label === p.label) || p;
        ctx.send({ type: 'snooze-tab', wakeAt: fresh.when.getTime() });
      };
      det.append(b);
    }
    const custom = el('button', 's-row custom');
    custom.type = 'button';
    custom.append(el('span', '', 'Custom…'), Object.assign(el('small'), { textContent: 'opens the command bar' }));
    custom.onclick = () => ctx.send({ type: 'toggle-command-bar', query: 'snooze ' });
    det.append(custom);
    ctx.detail.replaceChildren(det);
  }

  actionBar.register({
    id: 'snooze',
    title: 'Snooze this tab',
    side: 'right',
    order: 90,
    home: false,
    icon: svg(17),
    css,
    onShow: () => paint(),
    setup(c) {
      ctx = c;
      ctx.setAvailable(true);
      ctx.setEnabled(location.protocol !== 'chrome-extension:'); // the extension's own pages can't be snoozed
      paint();
    }
  });
})();
