// Browsers put the cursor in their own address bar when a *new tab page* opens, and a page can't take
// it back. A tab opened with an ordinary page address doesn't get that, so this swaps the browser's new tab
// for an identical one (marked ?f) whose search box can take focus.
(async () => {
  const hidden = document.documentElement;
  if (new URLSearchParams(location.search).has('f')) return;
  hidden.style.visibility = 'hidden'; // no flash of a page that is about to be replaced
  let swapped = false;
  try {
    const { newtab } = await Settings.load();
    const tab = newtab.focusSearch && newtab.search ? await chrome.tabs.getCurrent() : null;
    if (tab) {
      await chrome.tabs.create({ url: `${location.pathname}?f=1`, index: tab.index, windowId: tab.windowId, active: tab.active });
      await chrome.tabs.remove(tab.id);
      swapped = true;
    }
  } catch (_) {
    // fall through and show this page as it is
  } finally {
    if (!swapped) hidden.style.visibility = '';
  }
})();
