// Focus mode (service worker): a pomodoro timer that blocks distracting sites while a focus session runs.
//
// State lives in chrome.storage.local ("focusState") as an end time, not a countdown, so it survives the worker
// sleeping and the browser restarting. The action bar and the blocked page read it straight from storage.
//
//   { phase: 'off' | 'focus' | 'break', endsAt, durationMs, cycle, paused, remainingMs, next, endedAt }
//   next/endedAt: set when a phase ended and the next one is waiting for you to start it
//
// Blocking has two layers: declarativeNetRequest redirects navigations before the page loads, and a tab sweep
// catches what the rules can't (tabs that are already open, and in-page navigation on single-page sites).

const FOCUS_KEY = 'focusState';
const FOCUS_ALARM = 'focus-phase';
const GUARD_MS = 10000;      // the wait before a focus session can be paused, skipped or stopped
const GUARD_WINDOW_MS = 60000;
const RULES_PER_CHUNK = 10;  // keeps each regex well under the 2KB limit
const BLOCK_RULE_BASE = 100;
const ALLOW_RULE_BASE = 200;

const blockedPageUrl = () => chrome.runtime.getURL('blocked.html');

// --- sites -------------------------------------------------------------------

// "https://www.YouTube.com/watch?v=1" -> { host: 'youtube.com', path: '/watch' }; "x.com" -> { host: 'x.com', path: '' }
function parseSite(raw) {
  let s = String(raw || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '');
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');
  const i = s.indexOf('/');
  const host = (i < 0 ? s : s.slice(0, i)).replace(/:\d+$/, '');
  return host ? { host, path: i < 0 ? '' : s.slice(i) } : null;
}

function siteMatches(url, site) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^www\./, '');
  return (host === site.host || host.endsWith(`.${site.host}`)) && (!site.path || u.pathname.startsWith(site.path));
}

function isBlockedUrl(url) {
  const cfg = Settings.current.focus;
  const sites = list => list.map(parseSite).filter(Boolean);
  return sites(cfg.blocklist).some(s => siteMatches(url, s)) && !sites(cfg.allowlist).some(s => siteMatches(url, s));
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sitePattern = site =>
  `^https?://([^/?#]*\\.)?${escapeRe(site.host)}(:[0-9]+)?` + (site.path ? `${escapeRe(site.path)}.*` : '([/?#].*)?$');

// --- state -------------------------------------------------------------------

async function loadFocus() {
  const { [FOCUS_KEY]: s } = await chrome.storage.local.get(FOCUS_KEY);
  return s || { phase: 'off', cycle: 0 };
}

// Are sites blocked right now?
function blocking(s) {
  const cfg = Settings.current.focus;
  if (s.paused) return false;
  return s.phase === 'focus' || (s.phase === 'break' && !cfg.breakUnblocks);
}

async function saveFocus(s) {
  await chrome.storage.local.set({ [FOCUS_KEY]: s });
  await applyFocus(s);
  return s;
}

async function applyFocus(s) {
  await chrome.alarms.clear(FOCUS_ALARM);
  if (s.phase !== 'off' && !s.paused) chrome.alarms.create(FOCUS_ALARM, { when: Math.max(s.endsAt, Date.now() + 500) });
  await syncBlockRules(blocking(s));
  if (blocking(s)) sweepTabs();
  chrome.action.setBadgeBackgroundColor({ color: s.phase === 'break' ? '#30d158' : '#ff6b57' }).catch(() => {});
  chrome.action.setBadgeText({ text: s.phase === 'off' ? '' : s.paused ? '||' : s.phase === 'break' ? 'brk' : 'on' }).catch(() => {});
}

async function syncBlockRules(active) {
  const cfg = Settings.current.focus;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter(r => r.id >= BLOCK_RULE_BASE && r.id < ALLOW_RULE_BASE + 100).map(r => r.id);
  const addRules = [];
  if (active) {
    const chunks = (list, base, make) => {
      const sites = list.map(parseSite).filter(Boolean);
      for (let i = 0; i < sites.length; i += RULES_PER_CHUNK) {
        addRules.push(make(base + i / RULES_PER_CHUNK, sites.slice(i, i + RULES_PER_CHUNK).map(sitePattern).join('|')));
      }
    };
    chunks(cfg.blocklist, BLOCK_RULE_BASE, (id, regexFilter) => ({
      id, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${blockedPageUrl()}#\\0` } }, // the page's address rides along in the hash
      condition: { regexFilter, resourceTypes: ['main_frame'] }
    }));
    chunks(cfg.allowlist, ALLOW_RULE_BASE, (id, regexFilter) => ({
      id, priority: 2, action: { type: 'allow' }, condition: { regexFilter, resourceTypes: ['main_frame'] }
    }));
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }).catch(e => console.warn('focus rules', e));
}

// --- the tab sweep --------------------------------------------------------------

async function enforceTab(tab) {
  const url = tab?.url || tab?.pendingUrl;
  if (!url || url.startsWith(blockedPageUrl()) || !isBlockedUrl(url)) return;
  if (!blocking(await loadFocus())) return;
  chrome.tabs.update(tab.id, { url: `${blockedPageUrl()}#${url}` }).catch(() => {});
}

async function sweepTabs() {
  for (const t of await chrome.tabs.query({})) enforceTab(t);
}

chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.url || change.status === 'loading') enforceTab(tab); });
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(enforceTab).catch(() => {}));
chrome.tabs.onCreated.addListener(enforceTab);

// --- phases ---------------------------------------------------------------------

function minutesFor(phase, cycle) {
  const cfg = Settings.current.focus;
  if (phase === 'focus') return cfg.focusMin;
  return cycle > 0 && cycle % cfg.longEvery === 0 ? cfg.longBreakMin : cfg.breakMin;
}

function startPhase(phase, cycle) {
  const durationMs = minutesFor(phase, cycle) * 60000;
  return saveFocus({ phase, endsAt: Date.now() + durationMs, durationMs, cycle, paused: false, next: null });
}

function notify(title, message) {
  if (!Settings.current.focus.notify) return;
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon-128.png', title, message }).catch(() => {});
}

async function phaseEnded() {
  await Settings.load();
  const s = await loadFocus();
  if (s.phase === 'off' || s.paused) return;
  const auto = Settings.current.focus.autoNext;
  if (s.phase === 'focus') {
    const cycle = (s.cycle || 0) + 1;
    const long = minutesFor('break', cycle);
    notify('Focus session done', `Nice work. Take ${long} minutes.`);
    if (auto) await startPhase('break', cycle);
    else await saveFocus({ phase: 'off', cycle, next: 'break', endedAt: Date.now() });
  } else {
    notify('Break over', 'Ready for the next focus session?');
    if (auto) await startPhase('focus', s.cycle || 0);
    else await saveFocus({ phase: 'off', cycle: s.cycle || 0, next: 'focus', endedAt: Date.now() });
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === FOCUS_ALARM) phaseEnded(); });

// Browser start / extension reload / worker wake-up: put the blocking back. A phase that ran out while the browser
// was closed is closed out here; one that only just ended is left to its alarm, which chains the next phase.
async function resumeFocus() {
  await Settings.load();
  const s = await loadFocus();
  if (s.phase !== 'off' && !s.paused && s.endsAt <= Date.now() - 120000) {
    return saveFocus({ phase: 'off', cycle: s.cycle || 0, next: s.phase === 'focus' ? 'break' : 'focus', endedAt: Date.now() });
  }
  await applyFocus(s);
}
chrome.runtime.onStartup.addListener(resumeFocus);
chrome.runtime.onInstalled.addListener(resumeFocus);
resumeFocus();

// Changing the blocklist mid-session takes effect straight away.
Settings.onChange(async () => applyFocus(await loadFocus()));

// --- controls (from the action bar and the command bar) -------------------------------

// Pausing, skipping or stopping a focus session needs a request first and then a 10 second wait. It is checked
// here, not in the page, so no button or shortcut can skip the wait.
async function guardPassed(s) {
  if (s.phase !== 'focus' || Settings.current.focus.friction === false) return true;
  const { focusGuardAt = 0 } = await chrome.storage.session.get('focusGuardAt');
  const waited = Date.now() - focusGuardAt;
  return waited >= GUARD_MS - 500 && waited <= GUARD_WINDOW_MS; // 500ms of slack for timer jitter
}

async function focusCommand(msg) {
  await Settings.load();
  const s = await loadFocus();
  switch (msg.type) {
    case 'focus-guard':
      await chrome.storage.session.set({ focusGuardAt: Date.now() });
      return { ok: true };
    case 'focus-start': {
      const phase = msg.phase === 'break' ? 'break' : 'focus';
      // Cutting a focus session short with a break is skipping it: same wait.
      if (phase === 'break' && s.phase === 'focus' && !(await guardPassed(s))) return { ok: false, error: 'wait' };
      await chrome.storage.session.remove('focusGuardAt');
      await startPhase(phase, s.cycle || 0);
      return { ok: true };
    }
    case 'focus-dismiss': // clear the "start next" offer after a phase ends
      if (s.phase !== 'off') return { ok: false };
      await saveFocus({ phase: 'off', cycle: s.cycle || 0, next: null });
      return { ok: true };
    case 'focus-extend': {
      if (s.phase === 'off') return { ok: false };
      const add = 5 * 60000;
      return { ok: !!(await saveFocus(s.paused ? { ...s, remainingMs: s.remainingMs + add } : { ...s, endsAt: s.endsAt + add, durationMs: s.durationMs + add })) };
    }
    case 'focus-resume':
      if (!s.paused) return { ok: false };
      await saveFocus({ ...s, paused: false, endsAt: Date.now() + s.remainingMs, remainingMs: undefined });
      return { ok: true };
    case 'focus-pause':
    case 'focus-skip':
    case 'focus-stop': {
      if (s.phase === 'off') return { ok: false };
      if (!(await guardPassed(s))) return { ok: false, error: 'wait' };
      await chrome.storage.session.remove('focusGuardAt');
      if (msg.type === 'focus-pause') {
        if (!s.paused) await saveFocus({ ...s, paused: true, remainingMs: Math.max(0, s.endsAt - Date.now()) });
      } else if (msg.type === 'focus-stop') {
        await saveFocus({ phase: 'off', cycle: 0, next: null });
      } else if (s.phase === 'focus') {
        await startPhase('break', (s.cycle || 0) + 1);
      } else {
        await startPhase('focus', s.cycle || 0);
      }
      return { ok: true };
    }
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith('focus-')) return;
  focusCommand(msg).then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});
