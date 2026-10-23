// Copy URL button, plus the Cmd/Ctrl+Shift+C shortcut handled in the page so it works without
// assigning it in chrome://extensions/shortcuts (Chrome won't auto-assign it: it clashes with DevTools).
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const LINK = '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>';
  const isMac = /Mac/i.test(navigator.platform);

  async function copy() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      const t = document.createElement('textarea');
      t.value = url;
      t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.documentElement.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    actionBar.toast('Copied URL');
  }

  actionBar.register({
    id: 'copy-url',
    title: `Copy URL (${isMac ? '⌘' : 'Ctrl+'}⇧C)`,
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LINK}</svg>`,
    onClick: copy
  });

  document.addEventListener('keydown', e => {
    if (!actionBar.alive()) return; // orphaned copy after an extension reload
    if (!Settings.current.copyUrl.shortcut) return;
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (e.code === 'KeyC' && e.shiftKey && !e.altKey && mod) {
      e.preventDefault();
      e.stopPropagation();
      copy();
    }
  }, true);
})();
