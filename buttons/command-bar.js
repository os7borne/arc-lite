// Command bar button: the last button on the action bar's pager. It opens the command bar over the page.
(() => {
  const actionBar = globalThis.__actionBar;
  if (!actionBar) return;

  const SEARCH = '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>';
  const ctx = actionBar.register({
    id: 'command-bar',
    kind: 'action',
    side: 'right',
    order: 99,
    title: 'Command bar',
    icon: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SEARCH}</svg>`,
    onClick: () => actionBar.send({ type: 'toggle-command-bar' })
  });

  // Hidden while the command bar is turned off in settings.
  const apply = () => ctx.setEnabled(Settings.current.commandBar.enabled !== false);
  apply();
  Settings.onChange(apply);
})();
