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
let focusState = { phase: 'off' };
let snoozed = [];       // tabs put to sleep until later
let snoozing = false;   // choosing when to wake the current tab
const DEFAULT_PLACEHOLDER = $('#q').placeholder;

const close = () => (popup ? window.close() : parent.postMessage({ source: 'arclite-command-bar', type: 'close' }, '*'));

// --- helpers ------------------------------------------------------------------

const svg = (paths, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>'),
  go: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  action: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  undo: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>')
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

// Pull every http(s) URL out of a block of text.
const urlsIn = text => [...new Set((text.match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map(u => u.replace(/[.,;:!?]+$/, '')))];

// The URL without tracking junk (utm_*, fbclid, gclid, ...).
function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|mc_|ga_|pk_)/i.test(k) || /^(fbclid|gclid|dclid|msclkid|igshid|yclid|_hsenc|_hsmi|ref_src|si)$/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch (_) { return url; }
}

async function pasteAndGo(alt) {
  const text = (await navigator.clipboard.readText().catch(() => '')).trim();
  if (!text) return;
  if (looksLikeUrl(text)) await openUrl(toUrl(text), alt); else await openSearch(text, alt);
}

async function openClipboardUrls() {
  const urls = urlsIn(await navigator.clipboard.readText().catch(() => ''));
  for (const url of urls.slice(0, 30)) await chrome.tabs.create({ url, windowId: tab?.windowId, active: false });
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
      { title: 'Copy URL', keywords: 'copy link address', run: () => copy(t.url) },
      { title: 'Copy URL as Markdown', keywords: 'link md', run: () => copy(`[${t.title}](${t.url})`) },
      { title: 'Duplicate tab', keywords: 'copy clone', run: () => chrome.tabs.duplicate(t.id) },
      { title: t.pinned ? 'Unpin tab' : 'Pin tab', keywords: 'favorite', run: () => chrome.tabs.update(t.id, { pinned: !t.pinned }) },
      { title: t.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab', keywords: 'sound audio volume', run: () => chrome.tabs.update(t.id, { muted: !t.mutedInfo?.muted }) },
      { title: 'Reload tab', keywords: 'refresh', run: () => chrome.tabs.reload(t.id) },
      { title: 'Move tab to new window', keywords: 'detach', run: () => chrome.windows.create({ tabId: t.id }) },
      { title: 'Close tab', keywords: 'remove', run: () => chrome.tabs.remove(t.id) }
    );
    const winTabs = allTabs.filter(x => x.windowId === t.windowId && !x.url.startsWith(own));
    const picked = winTabs.filter(x => x.highlighted);
    const clip = (label, keywords, tabs, fmt) =>
      tabs.length > 1 && list.push({ title: `${label} (${tabs.length})`, keywords: `copy clipboard ${keywords}`, run: () => copy(tabs.map(fmt).join('\n')) });
    list.push(
      { title: 'Copy page title', keywords: 'clipboard name', run: () => copy(t.title || '') },
      { title: 'Copy clean URL', keywords: 'clipboard link tracking utm strip', run: () => copy(cleanUrl(t.url)) }
    );
    if (picked.length > 1) {
      clip('Copy selected tab URLs', 'selected highlighted', picked, x => x.url);
      clip('Copy selected tabs as Markdown list', 'selected highlighted md links', picked, x => `- [${x.title}](${x.url})`);
    }
    clip('Copy all tab URLs', 'links window', winTabs, x => x.url);
    clip('Copy all tabs as Markdown list', 'md links window', winTabs, x => `- [${x.title}](${x.url})`);
    if (others.length) {
      list.push(
        { title: `Sleep other tabs (${others.length})`, keywords: 'discard suspend memory', run: () => Promise.all(others.map(x => chrome.tabs.discard(x.id).catch(() => {}))) },
        { title: `Close other tabs (${others.length})`, keywords: 'remove', run: () => chrome.tabs.remove(others.map(x => x.id)) }
      );
    }
  }
  // Snooze: close this tab now and bring it back later.
  if (t && t.url && !t.url.startsWith(own)) {
    list.push({ title: 'Snooze tab…', keywords: 'later remind hide wake reopen', keepOpen: true, run: startSnooze });
  }
  if (snoozed.length) {
    list.push({ title: `Snoozed tabs (${snoozed.length})`, keywords: 'snooze later woke wake', keepOpen: true, run: () => { input.value = 'snoozed '; refresh(); } });
  }
  // The action bar's cards: open it on the overview, or straight to one of them.
  if (t && /^(https?|chrome-extension):/.test(t.url || '')) {
    const openCard = page => () => chrome.tabs.sendMessage(t.id, { type: 'open-action-bar', page }, { frameId: 0 }).catch(() => {});
    list.push(
      { title: 'Open action bar', keywords: 'overview capsule card panel', run: openCard('home') },
      { title: 'Show media player', keywords: 'action bar music video playing', run: openCard('media') },
      { title: 'Show downloads', keywords: 'action bar files latest', run: openCard('downloads') },
      { title: 'Show focus timer', keywords: 'action bar pomodoro focus break', run: openCard('focus') },
      { title: 'Show snooze options', keywords: 'action bar later remind', run: openCard('snooze') }
    );
  }
  // Focus mode: starting is always allowed; pausing and stopping live in the action bar, behind its wait.
  if (focusState.phase !== 'focus') {
    list.push({ title: 'Start focus', keywords: 'pomodoro timer block distractions', run: () => chrome.runtime.sendMessage({ type: 'focus-start', phase: 'focus' }) });
  }
  if (focusState.phase === 'off') {
    list.push({ title: 'Start break', keywords: 'pomodoro rest', run: () => chrome.runtime.sendMessage({ type: 'focus-start', phase: 'break' }) });
  }
  if (t && /^https?:/i.test(t.url || '')) {
    const host = hostOf(t.url);
    if (host && !Settings.hostMatches(host, settings.focus.blocklist)) {
      list.push({ title: `Block ${host} during focus`, keywords: 'focus distraction blocklist add', run: () => Settings.save(d => { d.focus.blocklist.push(host); }) });
    }
  }
  list.push(
    { title: 'Paste and go', keywords: 'clipboard open url search', run: pasteAndGo },
    { title: 'Open URLs from clipboard', keywords: 'paste links tabs', run: openClipboardUrls }
  );
  list.push(
    { title: 'Open Downloads folder', keywords: 'files', run: () => chrome.downloads.showDefaultFolder() },
    { title: 'Downloads page', keywords: 'history', run: () => chrome.tabs.create({ url: 'chrome://downloads' }) },
    { title: 'History page', keywords: 'browsing', run: () => chrome.tabs.create({ url: 'chrome://history' }) },
    { title: 'Extensions', keywords: 'manage', run: () => chrome.tabs.create({ url: 'chrome://extensions' }) },
    { title: 'Settings', keywords: 'preferences options arc lite', run: openSettings }
  );
  return list;
}

// --- snooze ---------------------------------------------------------------------

function startSnooze() {
  snoozing = true;
  input.value = '';
  input.placeholder = 'Snooze until…  e.g. 2h, tomorrow 9am, fri';
  refresh();
}
function stopSnooze() {
  snoozing = false;
  input.placeholder = DEFAULT_PLACEHOLDER;
  input.value = '';
  refresh();
}

// The ways to wake the current tab: what you typed, if it makes sense, and the usual choices.
function snoozeRows(rest) {
  if (!tab) return [];
  const now = new Date();
  const row = (title, date) => ({
    type: 'snooze', key: 'z:' + title, title, sub: SnoozeTimes.fmtWhen(date, now), glyph: ICONS.clock, tag: 'Snooze',
    run: () => chrome.runtime.sendMessage({ type: 'snooze-tab', tabId: tab.id, wakeAt: date.getTime() })
  });
  const parsed = rest ? SnoozeTimes.parseWhen(rest, now) : null;
  if (parsed) return [row(`Snooze until ${SnoozeTimes.fmtWhen(parsed, now)}`, parsed)];
  const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = SnoozeTimes.presets(now).filter(p => !words.length || matchScore(p.label, words) >= 0).map(p => row(p.label, p.when));
  if (!rows.length) {
    rows.push({ type: 'hint', title: 'Try “2h”, “tomorrow 9am”, “fri” or “next week”', sub: '', glyph: ICONS.clock, tag: 'Snooze', keepOpen: true, run: () => {} });
  }
  return rows;
}

const snoozedRow = i => ({
  type: 'snoozed', key: 's:' + i.id, id: i.id, title: i.title, sub: `Wakes ${SnoozeTimes.fmtWhen(new Date(i.wakeAt))} · ${hostOf(i.url)}`,
  icon: favicon(i.url), tag: 'Snoozed', run: () => chrome.runtime.sendMessage({ type: 'snooze-wake', id: i.id })
});

const QUICK_ACTIONS = ['New tab', 'Copy URL', 'Reopen closed tab', 'Settings'];

async function compute(raw) {
  const text = raw.trim();
  const actionOnly = text.startsWith('>');
  const query = actionOnly ? text.slice(1).trim() : text;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  snoozed = (await chrome.storage.local.get('snoozed').catch(() => ({}))).snoozed || [];

  // Choosing a wake time: after "Snooze tab…", or by typing "snooze 2h".
  if (!actionOnly) {
    const rest = snoozing ? text : /^snooze\b/i.test(text) ? text.replace(/^snooze\b\s*/i, '') : null;
    if (rest !== null) return snoozeRows(rest);
    if (/^snoozed\b/i.test(text)) {
      const w = text.replace(/^snoozed\b\s*/i, '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = snoozed.filter(i => !w.length || matchScore(`${i.title} ${i.url}`, w) >= 0).map(snoozedRow);
      return rows.length ? rows : [{ type: 'hint', title: 'No snoozed tabs', sub: '', glyph: ICONS.clock, tag: 'Snoozed', keepOpen: true, run: () => {} }];
    }
  }

  const tabRow = (t, tag = 'Tab') => ({
    type: 'tab', key: 'u:' + t.url, title: t.title || t.url, sub: hostOf(t.url), icon: favicon(t.url), tag, tabId: t.id,
    run: async () => {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
  });
  const closedRow = s => {
    const isTab = !!s.tab;
    const title = isTab ? s.tab.title || s.tab.url : `Window with ${s.window.tabs.length} tabs`;
    const url = isTab ? s.tab.url : s.window.tabs[0]?.url;
    return { type: 'closed', key: 'u:' + url, title, url, sub: isTab ? hostOf(s.tab.url) : '', icon: url ? favicon(url) : '', glyph: ICONS.undo,
             tag: 'Closed', run: () => chrome.sessions.restore(isTab ? s.tab.sessionId : s.window.sessionId) };
  };
  const actionRow = a => ({ type: 'action', key: 'a:' + a.title.replace(/\s*\(\d+\)$/, ''), title: a.title, sub: '', glyph: ICONS.action, tag: 'Action', keepOpen: a.keepOpen, run: a.run });

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

  if (looksLikeUrl(query) || (ghost && query === ghost)) {
    out.push({ type: 'go', key: 'u:' + toUrl(query), title: query, sub: 'Open', glyph: ICONS.go, tag: 'Go', run: alt => openUrl(toUrl(query), alt) });
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
      type: 'history', key: 'u:' + h.url, title: h.title || h.url, sub: hostOf(h.url), icon: favicon(h.url), tag: 'History',
      run: alt => openUrl(h.url, alt)
    }));

  snoozed.filter(i => matchScore(`${i.title} ${i.url}`, words) >= 0).slice(0, 3).forEach(i => out.push(snoozedRow(i)));
  closedRows.filter(r => matchScore(`${r.title} ${r.url}`, words) >= 0).slice(0, 3).forEach(r => out.push(r));

  if (!looksLikeUrl(query) && query !== ghost) {
    out.push({ type: 'search', title: `Search for “${query}”`, sub: '', glyph: ICONS.search, tag: 'Web', run: alt => openSearch(query, alt) });
  }
  return out;
}

// --- host autocomplete (from history) -----------------------------------------

// Hosts you've visited, best first: typed visits count most, then visits, then recency.
let hosts = [];
let ghost = ''; // the host currently suggested inline, if any

async function loadHosts() {
  const hist = await chrome.history.search({ text: '', maxResults: 5000, startTime: 0 }).catch(() => []);
  const now = Date.now();
  const byHost = new Map();
  for (const h of hist) {
    if (isInternal(h.url) || !/^https?:/i.test(h.url)) continue;
    const host = hostOf(h.url);
    if (!host) continue;
    const s = (h.typedCount || 0) * 4 + (h.visitCount || 0) + 6 / (1 + (now - h.lastVisitTime) / 6048e5);
    byHost.set(host, (byHost.get(host) || 0) + s);
  }
  hosts = [...byHost].sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

// Complete a single typed token (no spaces or slashes) to the best host that starts with it.
function completeHost(typed) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(typed)) return '';
  const t = typed.toLowerCase();
  return hosts.find(h => h.length > t.length && h.startsWith(t)) || '';
}

// --- learned ranking ----------------------------------------------------------

// What you picked for what you typed, kept on this device: { query: { itemKey: count } }.
const LEARN_KEY = 'commandBarPicks';
const LEARN_MAX_QUERIES = 400;
let picks = {};

// What was actually typed, without the inline host suggestion.
const typedText = () => (ghost && input.selectionStart !== input.selectionEnd ? input.value.slice(0, input.selectionStart) : input.value);

const loadPicks = () => chrome.storage.local.get(LEARN_KEY).then(r => { picks = r[LEARN_KEY] || {}; }).catch(() => {});

function recordPick(query, key) {
  const q = query.trim().toLowerCase();
  if (!q || !key) return;
  const entry = picks[q] || {};
  delete picks[q]; // re-insert so the newest queries sit last
  entry[key] = (entry[key] || 0) + 1;
  picks[q] = entry;
  const qs = Object.keys(picks);
  for (const old of qs.slice(0, Math.max(0, qs.length - LEARN_MAX_QUERIES))) delete picks[old];
  chrome.storage.local.set({ [LEARN_KEY]: picks }).catch(() => {});
}

// Picks made for the exact query count fully; picks made for a longer query that starts with it
// (you typed "gi" and usually finish "github") count in proportion to how much of it you've typed.
function learnedBoost(query) {
  const q = query.trim().toLowerCase();
  const boost = new Map();
  if (!q) return boost;
  for (const [pq, entry] of Object.entries(picks)) {
    if (!pq.startsWith(q)) continue;
    const w = q.length / pq.length;
    for (const [key, n] of Object.entries(entry)) boost.set(key, (boost.get(key) || 0) + n * w);
  }
  return boost;
}

// Items you've picked before for this query float to the top, most-picked first; the rest keep their order.
function applyLearned(rows, query) {
  const boost = learnedBoost(query.replace(/^>\s*/, ''));
  if (!boost.size) return rows;
  const lifted = rows.filter(r => boost.has(r.key)).sort((a, b) => boost.get(b.key) - boost.get(a.key));
  return [...lifted, ...rows.filter(r => !boost.has(r.key))];
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
  recordPick(typedText(), it.key);
  try { await it.run(alt); } finally { if (!it.keepOpen) close(); }
}

async function refresh() {
  const mine = ++seq;
  const next = applyLearned(await compute(input.value), typedText());
  if (mine !== seq) return; // a newer keystroke is already being worked on
  items = next;
  active = 0;
  render();
}

let timer;
input.addEventListener('input', e => {
  ghost = '';
  const typed = input.value;
  // Don't fight deletions or IME composition; only complete when the caret is at the end.
  // (Not while choosing a snooze time: "fri" shouldn't turn into a website.)
  if (settings.commandBar.autocompleteHosts !== false && typed && !snoozing && !/^snooze/i.test(typed) && !e.isComposing && !/^delete/.test(e.inputType || '') &&
      input.selectionStart === typed.length) {
    const host = completeHost(typed);
    if (host) {
      ghost = host;
      input.value = host;
      input.setSelectionRange(typed.length, host.length);
    }
  }
  clearTimeout(timer);
  timer = setTimeout(refresh, 40);
});

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
  } else if (e.key === 'Tab' && ghost && input.selectionStart !== input.selectionEnd) {
    e.preventDefault(); // accept the suggested host
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (snoozing) stopSnooze(); else close();
  } else if (e.key === 'Backspace' && snoozing && !input.value) {
    e.preventDefault();
    stopSnooze();
  } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && items[active]?.type === 'snoozed') {
    // Cmd/Ctrl+Backspace on a snoozed tab drops it for good.
    e.preventDefault();
    await chrome.runtime.sendMessage({ type: 'snooze-delete', id: items[active].id });
    refresh();
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
  if (params.get('q')) input.value = params.get('q');
  chrome.storage.local.get('focusState').then(r => { focusState = r.focusState || focusState; });
  loadHosts();
  await loadPicks();
  await refresh();
  input.focus();
  if (popup) setTimeout(() => window.addEventListener('blur', close), 400);
})();
window.addEventListener('focus', () => input.focus());
