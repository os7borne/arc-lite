const $ = s => document.querySelector(s);
const svg = (paths, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICON_SEARCH = svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>');
const ICON_GO = svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>');
const ICON_CHECK = svg('<polyline points="5 12.5 10 17.5 19 7"/>', 14);

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const favicon = url => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;

// --- clock ---------------------------------------------------------------

function tick() {
  const n = Settings.current.newtab;
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !n.clock24 });
  const h = d.getHours();
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const date = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const name = n.name.trim();
  $('#greeting').textContent = `Good ${part}${name ? `, ${name}` : ''} · ${date}`;
}
setInterval(tick, 10000);

// --- search / address bar -------------------------------------------------

const q = $('#q');
const list = $('#sugg');
let items = [];
let active = 0;
let seq = 0;

const looksLikeUrl = s =>
  /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) ||
  /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(s) ||
  /^localhost(:\d+)?([/?#]\S*)?$/i.test(s) ||
  /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]\S*)?$/.test(s);
const toUrl = s => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);

// Past searches live in history as results-page URLs; pull the query back out of them.
const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|brave|ecosia|yahoo|youtube|kagi|startpage)\./;
function queryOf(url) {
  try {
    const u = new URL(url);
    if (!SEARCH_HOSTS.test(u.hostname)) return '';
    const p = u.searchParams;
    return (p.get('q') || p.get('search_query') || p.get('query') || p.get('p') || '').trim();
  } catch { return ''; }
}

const go = url => chrome.tabs.update({ url });
const search = text => chrome.search.query({ text, disposition: 'CURRENT_TAB' });
const submit = value => {
  const v = value.trim();
  if (v) looksLikeUrl(v) ? go(toUrl(v)) : search(v);
};

async function suggest(text) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const first = looksLikeUrl(t)
    ? { type: 'go', title: t, sub: 'Open', url: toUrl(t) }
    : { type: 'search', title: t, sub: 'Search', query: t };

  const hist = await chrome.history.search({ text: t, maxResults: 150, startTime: 0 });
  const now = Date.now();
  const score = h => (h.typedCount || 0) * 4 + (h.visitCount || 0) + 6 / (1 + (now - h.lastVisitTime) / 6048e5);

  const searches = new Map();
  const pages = new Map();
  for (const h of hist) {
    const query = queryOf(h.url);
    if (query) {
      const k = query.toLowerCase();
      if (!k.includes(lower) || k === lower) continue;
      searches.set(k, { query, score: (searches.get(k)?.score || 0) + score(h) });
      continue;
    }
    const key = h.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').split('#')[0];
    const s = score(h) + (key.toLowerCase().startsWith(lower) ? 8 : 0);
    if (!pages.has(key) || pages.get(key).score < s) pages.set(key, { h, key, score: s });
  }

  const topSearches = [...searches.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  const topPages = [...pages.values()].sort((a, b) => b.score - a.score);

  // Inline completion: the best page whose address starts with what was typed.
  let inline = '';
  for (const p of topPages) {
    if (!p.key.toLowerCase().startsWith(lower)) continue;
    const cand = t.includes('/') ? p.key : p.key.split('/')[0];
    if (cand.length > t.length && cand.toLowerCase().startsWith(lower)) { inline = cand; break; }
  }

  return {
    inline,
    items: [
      first,
      ...topSearches.map(s => ({ type: 'search', title: s.query, sub: 'Past search', query: s.query })),
      ...topPages.slice(0, 4).map(p => ({
        type: 'page', title: p.h.title || p.key, sub: p.key, url: p.h.url
      }))
    ]
  };
}

function renderSuggestions() {
  list.hidden = !items.length;
  list.replaceChildren(...items.map((it, i) => {
    const li = document.createElement('li');
    li.className = i === active ? 'active' : '';
    let ico;
    if (it.type === 'page') {
      ico = document.createElement('img');
      ico.src = favicon(it.url);
    } else {
      ico = document.createElement('span');
      ico.innerHTML = it.type === 'go' ? ICON_GO : ICON_SEARCH;
    }
    ico.classList.add('ico');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = it.sub;
    li.append(ico, t, s);
    li.onmousedown = e => e.preventDefault(); // keep focus in the input
    li.onclick = () => choose(i);
    return li;
  }));
}

function hide() { items = []; seq++; renderSuggestions(); }

function choose(i) {
  const it = items[i];
  if (!it || i === 0) return submit(q.value); // first row = what Enter does with the current text
  if (it.type === 'search') search(it.query);
  else go(it.url);
}

q.addEventListener('input', async e => {
  if (e.isComposing) return;
  const text = q.value;
  const mine = ++seq;
  if (!text.trim()) return hide();
  const { items: next, inline } = await suggest(text);
  if (mine !== seq || q.value !== text) return; // stale
  items = next;
  active = 0;
  if (inline && text === text.trim() && !(e.inputType || '').startsWith('delete') && q.selectionStart === text.length) {
    q.value = text + inline.slice(text.length);
    q.setSelectionRange(text.length, q.value.length);
    items[0] = { type: 'go', title: q.value, sub: 'Open', url: toUrl(q.value) };
  }
  renderSuggestions();
});

q.addEventListener('keydown', e => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(active);
  } else if (e.key === 'Escape') {
    hide();
  }
});
q.addEventListener('blur', () => setTimeout(hide, 120));
q.focus();

// --- today: four things ----------------------------------------------------

const MAX_SLOTS = 8; // stored; how many show is a setting
const slots = () => Math.min(MAX_SLOTS, Math.max(1, Settings.current.newtab.todoSlots));
const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let todo = { date: dayKey(), items: [], carry: [] };

const saveTodo = () => chrome.storage.local.set({ todo });
const blank = () => ({ text: '', done: false });

async function loadTodo() {
  const { todo: stored } = await chrome.storage.local.get('todo');
  const today = dayKey();
  if (!stored) todo = { date: today, items: [], carry: [] };
  else if (stored.date === today) todo = stored;
  else {
    // New day: a clean list, but offer to bring back what wasn't finished.
    todo = {
      date: today, items: [],
      carry: stored.items.filter(i => i.text && !i.done).map(i => i.text)
    };
    saveTodo();
  }
  while (todo.items.length < MAX_SLOTS) todo.items.push(blank());
}

function updateCount() {
  const shown = todo.items.slice(0, slots());
  const filled = shown.filter(i => i.text);
  const done = filled.filter(i => i.done).length;
  $('#count').textContent = !filled.length ? 'Plan your day'
    : done === filled.length && filled.length === shown.length ? 'All done ✓'
    : `${done} of ${filled.length} done`;

  const free = shown.filter(i => !i.text).length;
  const carry = $('#carry');
  carry.hidden = !(todo.carry.length && free);
  const n = Math.min(todo.carry.length, free);
  carry.textContent = `Bring back ${n} unfinished from yesterday`;
}

function renderTodo() {
  const ul = $('#tasks');
  ul.replaceChildren(...todo.items.slice(0, slots()).map((item, i) => {
    const li = document.createElement('li');
    li.className = item.done ? 'done' : '';

    const check = document.createElement('button');
    check.className = 'check';
    check.title = 'Done';
    check.innerHTML = ICON_CHECK;
    check.disabled = !item.text;
    check.onclick = () => {
      item.done = !item.done;
      li.classList.toggle('done', item.done);
      saveTodo();
      updateCount();
    };

    const input = document.createElement('input');
    input.className = 'task';
    input.value = item.text;
    input.maxLength = 120;
    input.placeholder = todo.items.slice(0, slots()).findIndex(t => !t.text) === i ? 'Add a task' : '';
    input.onchange = () => {
      item.text = input.value.trim();
      if (!item.text) item.done = false;
      check.disabled = !item.text;
      li.classList.toggle('done', item.done);
      saveTodo();
      updateCount();
    };
    input.onkeydown = e => {
      if (e.key === 'Enter') {
        input.blur();
        ul.children[i + 1]?.querySelector('.task').focus();
      }
    };

    const clear = document.createElement('button');
    clear.className = 'clear';
    clear.title = 'Clear';
    clear.textContent = '✕';
    clear.hidden = !item.text;
    clear.onclick = () => {
      todo.items[i] = blank();
      saveTodo();
      renderTodo();
    };

    li.append(check, input, clear);
    return li;
  }));
  updateCount();
}

$('#carry').onclick = () => {
  for (const item of todo.items.slice(0, slots())) {
    if (!todo.carry.length) break;
    if (!item.text) item.text = todo.carry.shift();
  }
  saveTodo();
  renderTodo();
};

// --- footer: restore, recently closed ---------------------------------------

async function renderFooter() {
  const { session } = await chrome.storage.local.get('session');
  const restore = $('#restore');
  restore.hidden = !session?.windows?.length;
  restore.onclick = () => chrome.runtime.sendMessage({ type: 'restore-session' });

  const closed = await chrome.sessions.getRecentlyClosed({ maxResults: 10 }).catch(() => []);
  // Not the extension's own pages (this start page, settings) or browser pages like chrome://settings.
  const own = chrome.runtime.getURL('');
  $('#closed').replaceChildren(...closed.filter(s => s.tab && !s.tab.url.startsWith(own) && !s.tab.url.startsWith('chrome://')).slice(0, 3).map(s => {
    const b = document.createElement('button');
    const icon = document.createElement('img');
    icon.src = favicon(s.tab.url);
    icon.alt = '';
    const label = document.createElement('span');
    label.textContent = s.tab.title || hostOf(s.tab.url) || 'Closed tab';
    b.append(icon, label);
    b.title = `Reopen ${s.tab.url}`;
    b.onclick = () => chrome.sessions.restore(s.tab.sessionId);
    return b;
  }));
}

// --- background, settings, boot ---------------------------------------------------

const root = document.documentElement;
let bgImage = '';
let daily = null; // the downloaded photo of the day

function luminance(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = m.slice(1).map(v => parseInt(v, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyBackground() {
  const bg = Settings.current.newtab.background;
  const layer = $('#bg');
  const photo = bg.type === 'image' ? bgImage
    : bg.type === 'daily' && daily?.source === bg.photoSource ? daily.dataUrl : '';
  root.dataset.bg = bg.type === 'gradient' || (bg.type !== 'solid' && !photo) ? (bg.gradient || 'aurora') : '';
  root.classList.remove('light-text', 'dark-text');
  layer.classList.toggle('flat', bg.type === 'solid' || !!photo);
  layer.style.background = '';
  layer.style.backgroundImage = '';
  if (bg.type === 'solid') {
    layer.style.background = bg.color;
    root.classList.add(luminance(bg.color) < 0.5 ? 'light-text' : 'dark-text');
  } else if (photo) {
    layer.style.backgroundImage = `url("${photo}")`;
    root.classList.add('light-text');
  }
  layer.style.filter = photo && bg.blur ? `blur(${bg.blur}px)` : '';
  $('#dim').style.opacity = String((photo ? bg.dim : 0) / 100);

  const credit = $('#credit');
  const show = bg.type === 'daily' && photo && daily;
  credit.hidden = !show;
  if (show) {
    const short = daily.title.length > 60 ? `${daily.title.slice(0, 59)}…` : daily.title;
    credit.textContent = `${short ? `${short} · ` : ''}${daily.credit}`;
    credit.title = `${daily.title ? `${daily.title} · ` : ''}${daily.credit}`; // the full caption on hover
    if (daily.link) credit.href = daily.link; else credit.removeAttribute('href');
  }
}

function applySettings() {
  const n = Settings.current.newtab;
  $('#clock').hidden = !n.clock;
  $('#greeting').hidden = !n.greeting;
  $('header').hidden = !n.clock && !n.greeting;
  $('.search').hidden = !n.search;
  $('.todo').hidden = !n.todo;
  tick();
  applyBackground();
  if (todo.items.length) renderTodo();
}

// ego-lite sends the declared options page to the wrong screen, so the settings page is an ordinary page opened by address.
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

$('#gear').onclick = openSettings;

(async () => {
  const [, , stored] = await Promise.all([
    Settings.load(), loadTodo(), chrome.storage.local.get(['bgImage', 'dailyPhoto'])
  ]);
  bgImage = stored.bgImage || '';
  daily = stored.dailyPhoto || null;
  applySettings();
  // Show what's cached right away; the background fetches a newer photo if today's is missing.
  if (Settings.current.newtab.background.type === 'daily') chrome.runtime.sendMessage({ type: 'refresh-photo' });
  renderFooter();
  if (Settings.current.newtab.search) q.focus();
})();

Settings.onChange(() => {
  applySettings();
  if (Settings.current.newtab.background.type === 'daily') chrome.runtime.sendMessage({ type: 'refresh-photo' });
});

// Another new tab edited the list or changed the photo: pick it up unless this one is being typed in.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.todo && !document.activeElement?.classList.contains('task')) {
    todo = changes.todo.newValue;
    while (todo.items.length < MAX_SLOTS) todo.items.push(blank());
    renderTodo();
  }
  if (changes.bgImage) {
    bgImage = changes.bgImage.newValue || '';
    applyBackground();
  }
  if (changes.dailyPhoto) {
    daily = changes.dailyPhoto.newValue || null;
    applyBackground();
  }
});
