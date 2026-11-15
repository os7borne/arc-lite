// Snooze (service worker): close a tab now and bring it back later.
//
// Snoozed tabs live in chrome.storage.local ("snoozed") as { id, url, title, pinned, scroll, snoozedAt, wakeAt }.
// One alarm always points at the nearest wake time, so nothing needs the worker to stay awake. If the browser was
// closed when a tab was due, it comes back on the next start.

const SNOOZE_KEY = 'snoozed';
const SNOOZE_ALARM = 'snooze-wake';
const snoozingTabs = new Set(); // tabs being closed by a snooze, so Cmd+Z doesn't treat them as accidents

const loadSnoozed = async () => (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY] || [];
const saveSnoozed = async list => {
  list.sort((a, b) => a.wakeAt - b.wakeAt);
  await chrome.storage.local.set({ [SNOOZE_KEY]: list });
  await scheduleSnooze(list);
};

async function scheduleSnooze(list) {
  list = list || (await loadSnoozed());
  await chrome.alarms.clear(SNOOZE_ALARM);
  if (list.length) chrome.alarms.create(SNOOZE_ALARM, { when: Math.max(list[0].wakeAt, Date.now() + 1000) });
}

// The scroll position, so the page comes back where it was. Best effort: some pages can't be scripted.
async function scrollOf(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ x: scrollX, y: scrollY }) });
    return result && (result.x || result.y) ? result : null;
  } catch (_) { return null; }
}

async function snoozeTab(tabId, wakeAt) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.url.startsWith(chrome.runtime.getURL('')) || !Number.isFinite(wakeAt)) return { ok: false, error: 'Nothing to snooze' };
  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    url: tab.url, title: tab.title || tab.url, pinned: !!tab.pinned,
    scroll: /^https?:/i.test(tab.url) ? await scrollOf(tabId) : null,
    snoozedAt: Date.now(), wakeAt
  };
  const list = await loadSnoozed();
  list.push(item);
  await saveSnoozed(list);
  // Closing a window's only tab would close the window: leave a blank one behind.
  const inWindow = await chrome.tabs.query({ windowId: tab.windowId });
  if (inWindow.length === 1) await chrome.tabs.create({ windowId: tab.windowId });
  snoozingTabs.add(tabId);
  await chrome.tabs.remove(tabId).catch(() => snoozingTabs.delete(tabId));
  return { ok: true, id: item.id };
}

async function wake(item, { focus = false } = {}) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const props = { url: item.url, active: focus, pinned: item.pinned };
  const tab = win ? await chrome.tabs.create({ ...props, windowId: win.id }) : (await chrome.windows.create({ url: item.url })).tabs?.[0];
  if (!tab) return null;
  if (item.scroll) {
    const restore = (id, change) => {
      if (id !== tab.id || change.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(restore);
      chrome.scripting.executeScript({ target: { tabId: id }, func: (x, y) => setTimeout(() => scrollTo(x, y), 400), args: [item.scroll.x, item.scroll.y] }).catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(restore);
    setTimeout(() => chrome.tabs.onUpdated.removeListener(restore), 60000);
  }
  return tab;
}

// Everything that's due, or one tab named by id (a "wake now").
async function wakeDue(onlyId) {
  const list = await loadSnoozed();
  const now = Date.now();
  const due = list.filter(i => (onlyId ? i.id === onlyId : i.wakeAt <= now));
  if (!due.length) return scheduleSnooze(list);
  await saveSnoozed(list.filter(i => !due.includes(i)));
  for (const item of due) {
    const tab = await wake(item, { focus: !!onlyId });
    if (!tab || onlyId) continue;
    chrome.notifications.create(`snooze:${tab.id}`, {
      type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Snoozed tab is back', message: item.title
    }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === SNOOZE_ALARM) wakeDue(); });
chrome.notifications.onClicked.addListener(async id => {
  if (!id.startsWith('snooze:')) return;
  const tab = await chrome.tabs.get(Number(id.slice(7))).catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  chrome.notifications.clear(id);
});

// Browser start / extension reload: bring back what came due while we were away, and re-arm the alarm.
chrome.runtime.onStartup.addListener(() => wakeDue());
chrome.runtime.onInstalled.addListener(() => wakeDue());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith('snooze-')) return;
  (async () => {
    switch (msg.type) {
      // The action bar doesn't know its own tab id: it's the sender's.
      case 'snooze-tab': return snoozeTab(msg.tabId ?? sender.tab?.id, msg.wakeAt);
      case 'snooze-wake': await wakeDue(msg.id); return { ok: true };
      case 'snooze-delete': await saveSnoozed((await loadSnoozed()).filter(i => i.id !== msg.id)); return { ok: true };
      case 'snooze-set': {
        const list = await loadSnoozed();
        const item = list.find(i => i.id === msg.id);
        if (item && Number.isFinite(msg.wakeAt)) item.wakeAt = msg.wakeAt;
        await saveSnoozed(list);
        return { ok: !!item };
      }
    }
    return { ok: false };
  })().then(sendResponse, e => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
