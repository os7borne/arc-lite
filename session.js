// Session restore: keep a snapshot of every open window/tab, and reopen it on browser start when the
// browser itself didn't restore the tabs (e.g. after an update restart).
// Loaded into the service worker with importScripts().

const SESSION_BLANK = /^(chrome:\/\/(newtab|new-tab-page)|about:blank|chrome-error:|devtools:)/;
const NEW_TAB_URL = chrome.runtime.getURL('newtab.html');
const sessionUrl = t => {
  const u = t.url || t.pendingUrl || '';
  // Our own start page counts as a blank tab: never saved, and its window can be reused on restore.
  return u && !SESSION_BLANK.test(u) && !u.startsWith(NEW_TAB_URL) ? u : '';
};

// Saves are held back from browser start until the restore decision is made, otherwise the tabs the
// browser is still reopening would overwrite the snapshot with a partial one. storage.session is
// cleared on browser restart, so it resets itself.
const sessionIsReady = async () => !!(await chrome.storage.session.get('sessionReady')).sessionReady;
const sessionMarkReady = () => chrome.storage.session.set({ sessionReady: true });

async function takeSnapshot() {
  const [wins, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({})
  ]);
  const groupInfo = new Map(groups.map(g => [g.id, g]));
  const out = [];
  for (const w of wins) {
    if (w.incognito) continue;
    const groupList = [];
    const groupIndex = new Map();
    const tabs = [];
    for (const t of w.tabs) {
      const url = sessionUrl(t);
      if (!url) continue;
      let group = -1;
      if (t.groupId !== -1 && groupInfo.has(t.groupId)) {
        if (!groupIndex.has(t.groupId)) {
          const g = groupInfo.get(t.groupId);
          groupIndex.set(t.groupId, groupList.length);
          groupList.push({ title: g.title, color: g.color, collapsed: g.collapsed });
        }
        group = groupIndex.get(t.groupId);
      }
      tabs.push({ url, pinned: t.pinned, active: t.active, group });
    }
    if (tabs.length) {
      out.push({
        state: w.state, left: w.left, top: w.top, width: w.width, height: w.height,
        focused: w.focused, groups: groupList, tabs
      });
    }
  }
  return out;
}

let sessionTimer;
function scheduleSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(async () => {
    if (!(await sessionIsReady())) return;
    const windows = await takeSnapshot();
    if (windows.length) await chrome.storage.local.set({ session: { savedAt: Date.now(), windows } });
  }, 1500);
}

async function openSavedWindow(saved, blankWindow) {
  let tabs;
  let windowId;
  if (blankWindow) {
    windowId = blankWindow.id;
    tabs = [];
    for (const t of saved.tabs) tabs.push(await chrome.tabs.create({ windowId, url: t.url, active: false }));
    await chrome.tabs.remove(blankWindow.tabs.map(t => t.id));
  } else {
    const opts = { url: saved.tabs.map(t => t.url), focused: false };
    if (saved.state === 'normal' && saved.width) {
      Object.assign(opts, { left: saved.left, top: saved.top, width: saved.width, height: saved.height });
    } else if (saved.state === 'maximized') {
      opts.state = 'maximized';
    }
    const win = await chrome.windows.create(opts);
    windowId = win.id;
    tabs = win.tabs;
  }

  const byGroup = new Map();
  for (const [i, t] of saved.tabs.entries()) {
    try {
      if (t.pinned) await chrome.tabs.update(tabs[i].id, { pinned: true });
      else if (t.group >= 0) byGroup.set(t.group, [...(byGroup.get(t.group) || []), tabs[i].id]);
    } catch (_) {}
  }
  for (const [index, tabIds] of byGroup) {
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      const g = saved.groups[index];
      await chrome.tabGroups.update(groupId, { title: g.title, color: g.color, collapsed: g.collapsed });
    } catch (_) {}
  }
  const active = saved.tabs.findIndex(t => t.active);
  if (active >= 0) chrome.tabs.update(tabs[active].id, { active: true }).catch(() => {});
  if (saved.focused) chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

async function restoreSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session?.windows?.length) return;

  const current = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const open = new Map();
  for (const w of current) {
    for (const t of w.tabs) {
      const u = sessionUrl(t);
      if (u) open.set(u, (open.get(u) || 0) + 1);
    }
  }
  // Windows that only hold a blank/new-tab page can be reused instead of opening yet another window.
  const blank = current.filter(w => !w.incognito && w.tabs.every(t => !sessionUrl(t)));

  for (const saved of session.windows) {
    // Skip tabs the browser already reopened itself, so nothing is duplicated.
    const tabs = saved.tabs.filter(t => {
      const n = open.get(t.url) || 0;
      if (n > 0) { open.set(t.url, n - 1); return false; }
      return true;
    });
    if (!tabs.length) continue;
    await openSavedWindow({ ...saved, tabs }, blank.shift());
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await new Promise(r => setTimeout(r, 4000)); // let the browser finish its own restore first
  try {
    if ((await Settings.load()).session.restoreOnStartup) await restoreSession();
  } finally {
    await sessionMarkReady();
  }
});

// Install, update and extension reload don't go through onStartup.
chrome.runtime.onInstalled.addListener(async () => {
  await sessionMarkReady();
  scheduleSessionSave();
});

// Safety net: if neither event marked it ready, don't stay silent forever.
setTimeout(async () => {
  if (!(await sessionIsReady())) await sessionMarkReady();
}, 15000);

chrome.tabs.onCreated.addListener(scheduleSessionSave);
chrome.tabs.onMoved.addListener(scheduleSessionSave);
chrome.tabs.onAttached.addListener(scheduleSessionSave);
chrome.tabs.onDetached.addListener(scheduleSessionSave);
chrome.tabs.onActivated.addListener(scheduleSessionSave);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined) scheduleSessionSave();
});
// Tabs closed because their whole window is closing (e.g. quitting) must not wipe the snapshot.
chrome.tabs.onRemoved.addListener((_id, info) => { if (!info.isWindowClosing) scheduleSessionSave(); });
chrome.windows.onCreated.addListener(scheduleSessionSave);
chrome.tabGroups.onCreated.addListener(scheduleSessionSave);
chrome.tabGroups.onUpdated.addListener(scheduleSessionSave);
chrome.tabGroups.onRemoved.addListener(scheduleSessionSave);
