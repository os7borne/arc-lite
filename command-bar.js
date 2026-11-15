// Content script (every frame): the command bar shortcut, and the overlay that shows commandbar.html.
// The overlay is an extension page in an iframe, so its styles stay separate from the page and it can use
// the tabs, history and sessions APIs directly.
(() => {
  if (globalThis.__cmdBar?.alive()) return; // already running here
  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  globalThis.__cmdBar = { alive };

  const isMac = /Mac/i.test(navigator.platform);
  let frame = null;
  let previousFocus = null;

  function close() {
    if (!frame) return;
    frame.remove();
    frame = null;
    previousFocus?.focus?.({ preventScroll: true });
  }

  // `query` (optional) is typed into the bar when it opens, e.g. "snooze ".
  function open(query) {
    if (frame) return close();
    previousFocus = document.activeElement;
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('commandbar.html') + (query ? `?q=${encodeURIComponent(query)}` : '');
    frame.title = 'Command bar';
    frame.allow = 'clipboard-read; clipboard-write';
    frame.style.cssText = 'all:initial;position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:transparent;';
    frame.addEventListener('load', () => frame?.contentWindow?.focus());
    document.documentElement.appendChild(frame);
  }

  window.addEventListener('message', e => {
    if (frame && e.source === frame.contentWindow && e.data?.source === 'arclite-command-bar' && e.data.type === 'close') close();
  });
  window.addEventListener('pagehide', close);

  if (window.top === window && alive()) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type !== 'toggle-command-bar') return;
      open(msg.query);
      sendResponse(true);
    });
  }

  globalThis.Settings?.load().catch(() => {});

  // Cmd/Ctrl+Z right after closing a tab reopens it. The background script decides whether a tab was closed
  // recently enough; here we only step aside for text fields and for pages that handle undo themselves.
  const editable = el => !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
  window.addEventListener('keydown', e => {
    // Which key: Option+Z by default, since browsers and macOS leave it alone. On a Mac it types "Ω", so the key's
    // letter isn't "z": match the position as well as the letter (so other layouts work too).
    const isZ = e.code === 'KeyZ' || (e.key || '').toLowerCase() === 'z';
    const cmd = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const option = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
    const shifted = cmd && !e.altKey && e.shiftKey;
    const plain = cmd && !e.altKey && !e.shiftKey;
    const mode = Settings.current.tabs?.undoCloseKeys || 'option';
    const hit = (mode === 'option' && option) || (mode === 'shift' && shifted) || (mode === 'plain' && plain) ||
                (mode === 'all' && (option || shifted || plain));
    if (!alive() || e.defaultPrevented || e.repeat || !isZ || !hit) return;
    if (!Settings.current.tabs?.undoClose || editable(e.composedPath?.()[0] || e.target)) return;
    chrome.runtime.sendMessage({ type: 'undo-close-tab' })
      .then(r => { if (r?.restored) globalThis.__actionBar?.toast('Reopened closed tab'); })
      .catch(() => {});
  });
  window.addEventListener('keydown', e => {
    if (!alive()) return;
    const bar = Settings.current.commandBar;
    if (!bar.enabled) return;
    const s = bar.shortcut;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const other = isMac ? e.ctrlKey : e.metaKey;
    if (e.code !== s.code || mod !== !!s.mod || e.shiftKey !== !!s.shift || e.altKey !== !!s.alt || other) return;
    e.preventDefault();
    e.stopPropagation();
    // A subframe can't show the overlay: ask the top frame, through the background script.
    if (window.top === window) open(); else chrome.runtime.sendMessage({ type: 'toggle-command-bar' });
  }, true);
})();
