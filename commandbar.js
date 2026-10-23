// The command bar: one box for open tabs, actions, history, recently closed tabs and the web.
// Runs as an extension page, either in an overlay iframe on the current page or, where an overlay isn't
// possible (chrome:// pages), in a small popup window.

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const popup = params.has('popup');
if (popup) document.body.classList.add('popup');

const input = $('#q');
const list = $('#list');

let settings = Settings.current;
let tab = null; // the tab this was opened from
let allTabs = [];
let items = [];
let active = 0;
let seq = 0;

const close = () => (popup ? window.close() : parent.postMessage({ source: 'arclite-command-bar', type: 'close' }, '*'));

// --- helpers ------------------------------------------------------------------

const svg = (paths, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>'),
  go: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  action: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  undo: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>')
};

const favicon = url => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const own = chrome.runtime.getURL('');
const isInternal = url => !url || url.startsWith(own) || url.startsWith('chrome://') || url.startsWith('chrome-error://');

const looksLikeUrl = s =>
  /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) ||
  /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(s) ||
  /^localhost(:\d+)?([/?#]\S*)?$/i.test(s);
const toUrl = s => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

async function findTab() {
  if (params.has('tab')) return chrome.tabs.get(Number(params.get('tab'))).catch(() => null);
  const current = await chrome.tabs.getCurrent().catch(() => null);
  if (current) return current;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

// "Open in a new tab" vs "this tab": the setting, flipped by holding Shift.
const inNewTab = alt => (settings.commandBar.openIn !== 'current') !== !!alt;

async function openUrl(url, alt) {
  if (inNewTab(alt) || !tab) {
    await chrome.tabs.create({ url, windowId: tab?.windowId, index: tab ? tab.index + 1 : undefined, openerTabId: tab?.id });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
}

async function openSearch(text, alt) {
  if (inNewTab(alt) || !tab) await chrome.search.query({ text, disposition: 'NEW_TAB' });
  else await chrome.search.query({ text, tabId: tab.id });
}

async function openSettings() {
  const url = chrome.runtime.getURL('prefs.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// --- matching -----------------------------------------------------------------

// Every word typed must appear; matches at the start of the text or of a word count for more.
function matchScore(text, words) {
  const t = text.toLowerCase();
  let score = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    score += i === 0 ? 3 : /[\s/.\-_]/.test(t[i - 1]) ? 2 : 1;
  }
  return score;
}

function buildActions() {
  const t = tab;
  const others = allTabs.filter(x => t && x.windowId === t.windowId && x.id !== t.id && !x.pinned);
  const list = [
    { title: 'New tab', keywords: 'open blank start page', run: () => chrome.tabs.create({}) },
    { title: 'New window', keywords: 'open', run: () => chrome.windows.create({}) },
    { title: 'Reopen closed tab', keywords: 'undo restore', run: () => chrome.sessions.restore() }
  ];
  if (t) {
    list.push(
      { title: 'Copy URL', keywords: 'link address', run: () => copy(t.url) },
      { title: 'Copy URL as Markdown', keywords: 'link md', run: () => copy(`[${t.title}](${t.url})`) },
      { title: 'Duplicate tab', keywords: 'copy clone', run: () => chrome.tabs.duplicate(t.id) },
      { title: t.pinned ? 'Unpin tab' : 'Pin tab', keywords: 'favorite', run: () => chrome.tabs.update(t.id, { pinned: !t.pinned }) },
      { title: t.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab', keywords: 'sound audio volume', run: () => chrome.tabs.update(t.id, { muted: !t.mutedInfo?.muted }) },
      { title: 'Reload tab', keywords: 'refresh', run: () => chrome.tabs.reload(t.id) },
      { title: 'Move tab to new window', keywords: 'detach', run: () => chrome.windows.create({ tabId: t.id }) },
      { title: 'Close tab', keywords: 'remove', run: () => chrome.tabs.remove(t.id) }
    );
    if (others.length) {
      list.push(
        { title: `Sleep other tabs (${others.length})`, keywords: 'discard suspend memory', run: () => Promise.all(others.map(x => chrome.tabs.discard(x.id).catch(() => {}))) },
        { title: `Close other tabs (${others.length})`, keywords: 'remove', run: () => chrome.tabs.remove(others.map(x => x.id)) }
      );
    }
  }
  list.push(
    { title: 'Open Downloads folder', keywords: 'files', run: () => chrome.downloads.showDefaultFolder() },
    { title: 'Downloads page', keywords: 'history', run: () => chrome.tabs.create({ url: 'chrome://downloads' }) },
    { title: 'History page', keywords: 'browsing', run: () => chrome.tabs.create({ url: 'chrome://history' }) },
    { title: 'Extensions', keywords: 'manage', run: () => chrome.tabs.create({ url: 'chrome://extensions' }) },
    { title: 'Settings', keywords: 'preferences options arc lite', run: openSettings }
  );
  return list;
}

const QUICK_ACTIONS = ['New tab', 'Copy URL', 'Reopen closed tab', 'Settings'];

async function compute(raw) {
  const text = raw.trim();
  const actionOnly = text.startsWith('>');
  const query = actionOnly ? text.slice(1).trim() : text;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];

  const tabRow = (t, tag = 'Tab') => ({
    type: 'tab', title: t.title || t.url, sub: hostOf(t.url), icon: favicon(t.url), tag, tabId: t.id,
    run: async () => {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
  });
  const closedRow = s => {
    const isTab = !!s.tab;
    const title = isTab ? s.tab.title || s.tab.url : `Window with ${s.window.tabs.length} tabs`;
    const url = isTab ? s.tab.url : s.window.tabs[0]?.url;
    return { type: 'closed', title, url, sub: isTab ? hostOf(s.tab.url) : '', icon: url ? favicon(url) : '', glyph: ICONS.undo,
             tag: 'Closed', run: () => chrome.sessions.restore(isTab ? s.tab.sessionId : s.window.sessionId) };
  };
  const actionRow = a => ({ type: 'action', title: a.title, sub: '', glyph: ICONS.action, tag: 'Action', run: a.run });

  // The extension's own pages (start page, settings) aren't offered as tabs to jump to.
  const openTabs = allTabs.filter(t => !t.url.startsWith(own));
  const byRecent = [...openTabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const closed = await chrome.sessions.getRecentlyClosed({ maxResults: 12 }).catch(() => []);
  const closedRows = closed.map(closedRow).filter(r => !isInternal(r.url));

  if (!words.length) {
    if (actionOnly) return buildActions().map(actionRow);
    byRecent.filter(t => !tab || t.id !== tab.id).slice(0, 6).forEach(t => out.push(tabRow(t)));
    closedRows.slice(0, 3).forEach(r => out.push(r));
    buildActions().filter(a => QUICK_ACTIONS.includes(a.title)).forEach(a => out.push(actionRow(a)));
    return out;
  }

  const actions = buildActions()
    .map(a => ({ a, s: matchScore(`${a.title} ${a.keywords || ''}`, words) }))
    .filter(x => x.s >= 0).sort((x, y) => y.s - x.s).map(x => actionRow(x.a));
  if (actionOnly) return actions;

  if (looksLikeUrl(query)) {
    out.push({ type: 'go', title: query, sub: 'Open', glyph: ICONS.go, tag: 'Go', run: alt => openUrl(toUrl(query), alt) });
  }

  const rank = new Map(byRecent.map((t, i) => [t.id, i]));
  const tabs = openTabs
    .map(t => ({ t, s: matchScore(`${t.title || ''} ${t.url}`, words) }))
    .filter(x => x.s >= 0)
    .sort((x, y) => (y.s + Math.max(0, 2 - rank.get(y.t.id) * 0.15)) - (x.s + Math.max(0, 2 - rank.get(x.t.id) * 0.15)))
    .slice(0, 6).map(x => tabRow(x.t));
  out.push(...tabs);
  out.push(...actions.slice(0, 4));

  const openUrls = new Set(allTabs.map(t => t.url));
  const hist = await chrome.history.search({ text: query, maxResults: 40, startTime: 0 });
  const now = Date.now();
  hist.filter(h => !openUrls.has(h.url) && !isInternal(h.url))
    .map(h => ({ h, s: (h.typedCount || 0) * 4 + (h.visitCount || 0) + 6 / (1 + (now - h.lastVisitTime) / 6048e5) }))
    .sort((x, y) => y.s - x.s).slice(0, 5)
    .forEach(({ h }) => out.push({
      type: 'history', title: h.title || h.url, sub: hostOf(h.url), icon: favicon(h.url), tag: 'History',
      run: alt => openUrl(h.url, alt)
    }));

  closedRows.filter(r => matchScore(`${r.title} ${r.url}`, words) >= 0).slice(0, 3).forEach(r => out.push(r));

  if (!looksLikeUrl(query)) {
    out.push({ type: 'search', title: `Search for “${query}”`, sub: '', glyph: ICONS.search, tag: 'Web', run: alt => openSearch(query, alt) });
  }
  return out;
}

// --- rendering & keys ---------------------------------------------------------

function render() {
  list.replaceChildren(...items.map((it, i) => {
    const li = document.createElement('li');
    li.className = i === active ? 'active' : '';
    li.setAttribute('role', 'option');
    let ico;
    if (it.icon) {
      ico = document.createElement('img');
      ico.src = it.icon;
      ico.alt = '';
    } else {
      ico = document.createElement('span');
      ico.innerHTML = it.glyph || '';
    }
    ico.classList.add('ico');
    const txt = document.createElement('span');
    txt.className = 'txt';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title;
    txt.append(t);
    if (it.sub) {
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = it.sub;
      txt.append(s);
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = it.tag;
    li.append(ico, txt, tag);
    li.onmousemove = () => { if (active !== i) { active = i; markActive(); } };
    li.onclick = e => run(i, e.shiftKey);
    return li;
  }));
  if (!items.length) {
    const none = document.createElement('li');
    none.className = 'empty';
    none.textContent = 'Nothing found';
    list.append(none);
  }
}

function markActive() {
  [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
  list.children[active]?.scrollIntoView({ block: 'nearest' });
}

async function run(i, alt) {
  const it = items[i];
  if (!it) return;
  try { await it.run(alt); } finally { close(); }
}

async function refresh() {
  const mine = ++seq;
  const next = await compute(input.value);
  if (mine !== seq) return; // a newer keystroke is already being worked on
  items = next;
  active = 0;
  render();
}

let timer;
input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 40); });

input.addEventListener('keydown', async e => {
  const n = items.length;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    if (n) { active = (active + 1) % n; markActive(); }
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    if (n) { active = (active - 1 + n) % n; markActive(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    run(active, e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && items[active]?.type === 'tab') {
    // Cmd/Ctrl+Backspace closes the highlighted tab without leaving the bar.
    e.preventDefault();
    await chrome.tabs.remove(items[active].tabId);
    allTabs = await chrome.tabs.query({});
    refresh();
  }
});

// Clicking outside the panel closes it.
$('#backdrop').addEventListener('mousedown', e => { if (e.target.id === 'backdrop') close(); });

// --- start ----------------------------------------------------------------------

(async () => {
  settings = await Settings.load();
  [tab, allTabs] = await Promise.all([findTab(), chrome.tabs.query({})]);
  const newFirst = settings.commandBar.openIn !== 'current';
  $('#primary').textContent = newFirst ? 'new tab' : 'this tab';
  $('#alt').textContent = newFirst ? 'this tab' : 'new tab';
  await refresh();
  input.focus();
  if (popup) setTimeout(() => window.addEventListener('blur', close), 400);
})();
window.addEventListener('focus', () => input.focus());
