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

  function open() {
    if (frame) return close();
    previousFocus = document.activeElement;
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('commandbar.html');
    frame.title = 'Command bar';
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
      open();
      sendResponse(true);
    });
  }

  globalThis.Settings?.load().catch(() => {});
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
