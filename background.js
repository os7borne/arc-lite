importScripts('settings.js', 'session.js', 'focus.js', 'snooze.js');

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD', 'BLOBS'],
    justification: 'Copy the current tab URL to the clipboard, and read a still frame from downloaded videos for thumbnails'
  });
}

// Runs inside the page: the command grants activeTab, and the page is where focus is.
function copyInPage(text) {
  const legacy = () => {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.documentElement.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  };
  return navigator.clipboard.writeText(text).then(() => true, legacy);
}

async function writeClipboard(tab) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: copyInPage, args: [tab.url]
    });
    if (res?.result) return true;
  } catch (_) {
    // unscriptable page (chrome://, web store): fall through to the offscreen document
  }
  try {
    await ensureOffscreen();
    return !!(await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text: tab.url }));
  } catch (_) {
    return false;
  }
}

async function copyUrl(tab) {
  if (!tab?.url) return;
  const ok = await writeClipboard(tab);
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#d32f2f' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
  if (!ok) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toast });
  } catch (_) {
    // badge still shows
  }
}

function toast() {
  const el = document.createElement('div');
  el.textContent = 'Copied URL';
  Object.assign(el.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    background: '#1c1c1e', color: '#fff', font: '13px -apple-system, system-ui, sans-serif',
    padding: '8px 14px', borderRadius: '10px', zIndex: 2147483647,
    boxShadow: '0 4px 16px rgba(0,0,0,.3)', opacity: '1', transition: 'opacity .3s'
  });
  document.documentElement.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 1200);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'copy-url') await copyUrl(tab);
  else if (command === 'open-command-bar' && tab) await openCommandBar(tab.id);
});

// The overlay needs a page the extension can script. Elsewhere (chrome:// pages, the Web Store, PDFs) the
// command bar opens in a small window instead.
async function openCommandBar(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle-command-bar' }, { frameId: 0 });
  } catch (_) {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`commandbar.html?popup=1&tab=${tabId}`),
      type: 'popup', width: 720, height: 520, focused: true
    });
  }
}

// Hide the browser's native downloads UI; the widget replaces it.
async function applyDownloadsUi() {
  const s = await Settings.load();
  chrome.downloads.setUiOptions?.({ enabled: !s.downloads.hideNativeUi }).catch(() => {});
}
applyDownloadsUi();
Settings.onChange(applyDownloadsUi);

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

chrome.action.onClicked.addListener(async () => {
  const { action } = (await Settings.load()).toolbar;
  if (action === 'downloads') chrome.downloads.showDefaultFolder();
  else if (action === 'start') chrome.tabs.create({}); // a new tab is the start page
  else openSettings();
});

// --- download widget ---------------------------------------------------

const showForMs = () => (Settings.current.downloads.showSeconds ?? 6) * 1000;
let revealUntil = 0;

// Thumbnails for finished image and video downloads, scaled down and cached. The file itself is read when the extension
// has "Allow access to file URLs"; otherwise the original address is tried. Failures are cached too.
const THUMB_SIZE = 96;
const THUMB_MAX_BYTES = 30 * 1024 * 1024;
const thumbs = new Map(); // download id -> data URL, or '' when there isn't one

const isImage = d => /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(d.mime || '') ||
  /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(d.filename || '');

const isVideo = d => /^video\/(mp4|webm|quicktime|ogg|x-m4v)$/i.test(d.mime || '') ||
  /\.(mp4|m4v|mov|webm|ogv)$/i.test(d.filename || '');

async function makeThumb(d) {
  const sources = [];
  if (d.filename) sources.push('file://' + d.filename.split('/').map(encodeURIComponent).join('/'));
  if (/^https?:/i.test(d.url || '')) sources.push(d.url);
  if (isVideo(d)) {
    try {
      await ensureOffscreen();
      return (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'video-thumb', sources })) || '';
    } catch (_) { return ''; }
  }
  for (const src of sources) {
    try {
      const res = await fetch(src, { credentials: 'include' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > THUMB_MAX_BYTES) continue;
      const bmp = await createImageBitmap(blob);
      const k = Math.max(THUMB_SIZE / bmp.width, THUMB_SIZE / bmp.height); // cover the square
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const canvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
      canvas.getContext('2d').drawImage(bmp, (THUMB_SIZE - w) / 2, (THUMB_SIZE - h) / 2, w, h);
      bmp.close();
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:image/jpeg;base64,${btoa(bin)}`;
    } catch (_) { /* try the next source */ }
  }
  return '';
}

async function thumbFor(d) {
  if (Settings.current.downloads.thumbnails === false) return '';
  if (d.state !== 'complete' || d.exists === false || !(isImage(d) || isVideo(d))) return '';
  if (!thumbs.has(d.id)) {
    thumbs.set(d.id, ''); // placeholder so concurrent snapshots don't start the same work twice
    // Don't hold up the widget: it shows the file icon now and swaps in the thumbnail once it's ready.
    makeThumb(d).then(url => {
      thumbs.set(d.id, url);
      if (thumbs.size > 30) thumbs.delete(thumbs.keys().next().value);
      if (url) throttledBroadcast();
    });
  }
  return thumbs.get(d.id);
}

async function snapshot() {
  // The latest few, for the downloads page (deleted files included, shown struck through). The home card shows only the
  // latest file that still exists, which can be older than those few, so look a little further back for it.
  const found = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 12 });
  const recent = found.slice(0, 3);
  const available = found.find(d => d.exists !== false);
  const describe = async d => {
    let icon = '';
    try { icon = await chrome.downloads.getFileIcon(d.id, { size: 32 }); } catch (_) {}
    const thumb = await thumbFor(d);
    return {
      id: d.id,
      name: (d.filename || d.url || '').split(/[\\/]/).pop(),
      state: d.state,
      paused: d.paused,
      exists: d.exists,
      bytesReceived: d.bytesReceived,
      totalBytes: d.totalBytes,
      fileSize: d.fileSize,
      path: d.filename,
      mime: d.mime,
      icon,
      thumb
    };
  };
  const items = await Promise.all(recent.map(describe));
  const latest = available ? (items.find(i => i.id === available.id) || await describe(available)) : null;
  // remaining: -1 = stay (download running), 0 = hidden, >0 = ms left before fading out
  const remaining = latest?.state === 'in_progress' ? -1 : latest ? Math.max(0, revealUntil - Date.now()) : 0;
  return { items, latest, remaining };
}

async function broadcast() {
  const state = await snapshot();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'downloads', ...state }).catch(() => {});
  }
  // onChanged doesn't fire for byte counts, so keep polling while a download is running.
  if (state.remaining < 0) setTimeout(throttledBroadcast, 700);
}

let pending = false;
function throttledBroadcast() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; broadcast(); }, 300);
}

chrome.downloads.onCreated.addListener(() => {
  revealUntil = Date.now() + showForMs();
  throttledBroadcast();
});
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state && delta.state.current !== 'in_progress') revealUntil = Date.now() + showForMs();
  throttledBroadcast();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-downloads') {
    snapshot().then(sendResponse);
    return true;
  }
  if (msg.type === 'open-file') chrome.downloads.open(msg.id);
  if (msg.type === 'show-file') chrome.downloads.show(msg.id);
  if (msg.type === 'open-folder') chrome.downloads.showDefaultFolder();
  if (msg.type === 'open-downloads-page') chrome.tabs.create({ url: 'chrome://downloads' });
  if (msg.type === 'drop-file') {
    dropFile(sender.tab?.id, msg.id, msg.x, msg.y).then(() => sendResponse({}), e => sendResponse({ error: String(e.message || e) }));
    return true;
  }
});

// Drops a downloaded file onto a page at (x, y) by replaying a drag through the DevTools protocol: a native
// drag can't hand a web page a real file. Chrome shows its "started debugging" banner while attached.
async function dropFile(tabId, downloadId, x, y) {
  if (tabId == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Nothing to drop onto');
  const [d] = await chrome.downloads.search({ id: downloadId });
  if (!d?.filename || d.state !== 'complete' || d.exists === false) throw new Error('File not found');
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    throw new Error(/already attached/i.test(e.message) ? 'Close DevTools on this tab to drop files' : "Can't drop files on this page");
  }
  try {
    const data = { items: [], files: [d.filename], dragOperationsMask: 1 };
    const cmd = (method, params) => chrome.debugger.sendCommand(target, method, params);
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cmd('Input.dispatchDragEvent', { type, x, y, data });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// --- media -------------------------------------------------------------

const MEDIA_STALE_MS = 10 * 60 * 1000; // paused media is forgotten after this long

let mediaQueue = Promise.resolve();
// State lives in storage.session so it survives the service worker being suspended.
function withMedia(fn) {
  const run = mediaQueue.then(async () => {
    const { media = {} } = await chrome.storage.session.get('media');
    const result = await fn(media);
    await chrome.storage.session.set({ media });
    return result;
  });
  mediaQueue = run.catch(() => {});
  return run;
}

// Everything playing (most recently started first), then recently paused ones.
function listMedia(media) {
  const now = Date.now();
  return Object.values(media)
    .filter(e => e.playing || now - e.ts < MEDIA_STALE_MS)
    .sort((a, b) => (b.playing - a.playing) || (b.since - a.since))
    .slice(0, 5);
}
const primaryMedia = media => listMedia(media)[0] || null;

async function mediaViews(entries) {
  await Settings.load();
  return (await Promise.all(entries.map(mediaView))).filter(Boolean);
}

async function mediaView(entry) {
  if (!entry) return null;
  let tab;
  try { tab = await chrome.tabs.get(entry.tabId); } catch (_) { return null; }
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch (_) {}
  if (Settings.hostMatches(host, Settings.current.media.ignoreSites)) return null;
  return { ...entry, title: entry.title || tab.title || '', favicon: tab.favIconUrl || '', host };
}

let mediaPending = false;
function broadcastMedia() {
  if (mediaPending) return;
  mediaPending = true;
  setTimeout(async () => {
    mediaPending = false;
    const views = await mediaViews(await withMedia(listMedia));
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs) {
      // local: the media is in this very page, so the widget can act on it without a round-trip
      const forTab = views.map(v => ({ ...v, local: v.tabId === t.id && v.frameId === 0 }));
      chrome.tabs.sendMessage(t.id, { type: 'media', views: forTab }, { frameId: 0 }).catch(() => {});
    }
  }, 400);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'media-report' && sender.tab) {
    const key = `${sender.tab.id}:${sender.frameId}`;
    withMedia(media => {
      if (msg.gone) { delete media[key]; return; }
      const now = Date.now();
      const prev = media[key];
      // announceAt: when the player should show in full for a few seconds (new media, a new track,
      // or playback resuming after a long pause).
      const announce = msg.state.playing && (!prev ||
        (prev.title && msg.state.title && prev.title !== msg.state.title) ||
        (!prev.playing && now - prev.ts > 60000));
      media[key] = {
        ...msg.state, tabId: sender.tab.id, frameId: sender.frameId, ts: now,
        since: prev && prev.playing === msg.state.playing ? prev.since : now,
        announceAt: announce ? now : prev?.announceAt || 0
      };
    }).then(broadcastMedia);
  } else if (msg.type === 'pip-hint' && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'toast', text: msg.text || 'Click the page to open Picture-in-Picture' }, { frameId: 0 }).catch(() => {});
  } else if (msg.type === 'undo-close-tab') {
    undoCloseTab().then(restored => sendResponse({ restored }), () => sendResponse({ restored: false }));
    return true;
  } else if (msg.type === 'restore-session') {
    restoreSession();
  } else if (msg.type === 'toggle-command-bar' && sender.tab) {
    // pressed inside a subframe: the top frame shows the overlay
    chrome.tabs.sendMessage(sender.tab.id, { type: 'toggle-command-bar', query: msg.query }, { frameId: 0 }).catch(() => {});
  } else if (msg.type === 'refresh-photo') {
    refreshPhoto(msg.force).then(ok => sendResponse(ok));
    return true;
  } else if (msg.type === 'fetch-image') {
    fetchImage(msg.url).then(sendResponse);
    return true;
  } else if (msg.type === 'get-media') {
    withMedia(listMedia).then(mediaViews)
      .then(views => views.map(v => ({ ...v, local: v.tabId === sender.tab?.id && v.frameId === 0 })))
      .then(sendResponse);
    return true;
  } else if (msg.type === 'media-control') {
    withMedia(async media => {
      // Controls name their source; fall back to the main one.
      const entry = (msg.tabId != null && media[`${msg.tabId}:${msg.frameId}`]) || primaryMedia(media);
      if (!entry) return;
      if (msg.action === 'focus' || (msg.action === 'pip' && sender.tab?.id !== entry.tabId)) {
        const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
        if (!tab) return;
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        if (msg.action === 'focus') return;
      }
      try {
        await chrome.tabs.sendMessage(entry.tabId,
          { type: 'media-command', action: msg.action, delta: msg.delta }, { frameId: entry.frameId });
      } catch (_) {
        delete media[`${entry.tabId}:${entry.frameId}`]; // that frame is gone
      }
    }).then(broadcastMedia);
  }
});

// Cmd/Ctrl+Z reopens a tab closed in the last few seconds. Kept in session storage: the worker can be stopped.
const UNDO_CLOSE_MS = 10000;
chrome.tabs.onRemoved.addListener((id, info) => {
  // A snoozed tab isn't an accident to undo, and closing a whole window isn't a tab close.
  if (!info.isWindowClosing && !snoozingTabs.delete(id)) chrome.storage.session.set({ lastTabClosedAt: Date.now() });
});
async function undoCloseTab() {
  if (!(await Settings.load()).tabs.undoClose) return false; // reload: the worker may have just woken up
  const { lastTabClosedAt = 0 } = await chrome.storage.session.get('lastTabClosedAt');
  if (Date.now() - lastTabClosedAt > UNDO_CLOSE_MS) return false;
  await chrome.storage.session.remove('lastTabClosedAt'); // one undo per close
  return chrome.sessions.restore().then(() => true, () => false);
}

chrome.tabs.onRemoved.addListener(tabId => {
  withMedia(media => {
    for (const k of Object.keys(media)) if (media[k].tabId === tabId) delete media[k];
  }).then(broadcastMedia);
});

// Content scripts only load on page loads, so after an install/update/reload put them into tabs that are
// already open (otherwise nothing works there until each tab is refreshed).
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    try {
      // idempotent: skips itself where it is already running
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['settings.js', 'command-bar.js'] });
    } catch (_) {}
    try {
      const [{ result: running } = {}] = await chrome.scripting.executeScript({
        target: { tabId: t.id }, func: () => !!globalThis.__actionBar?.alive()
      });
      if (running) continue;
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        files: ['settings.js', 'snooze-times.js', 'action-bar.js', 'buttons/media.js', 'buttons/downloads.js', 'buttons/focus.js', 'buttons/snooze.js', 'buttons/copy-url.js', 'buttons/command-bar.js']
      });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['pip-shim.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['media-agent.js'] });
    } catch (_) {
      // discarded or restricted tab: it picks the scripts up on its next load
    }
  }
});

// Artwork for the media player: fetched here (no cookies sent) and returned as a data URL, so a page never
// loads another site's image itself.
const imageCache = new Map();
async function fetchImage(url) {
  if (!/^https?:\/\//i.test(url)) return '';
  if (imageCache.has(url)) return imageCache.get(url);
  let data = '';
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (res.ok && type.startsWith('image/')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length <= 2_000_000) data = toDataUrl(bytes, type);
    }
  } catch (_) {}
  imageCache.set(url, data);
  if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
  return data;
}

function toDataUrl(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

// --- start page photo ---------------------------------------------------------------

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const xmlText = str => str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

async function getJson(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Each source resolves to { imageUrl, title, credit, link }.
const PHOTO_SOURCES = {
  async bing() {
    const data = await getJson('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US');
    const img = data.images[0];
    return {
      imageUrl: `https://www.bing.com${img.urlbase}_UHD.jpg`,
      title: img.title || img.copyright, credit: 'Bing', link: img.copyrightlink
    };
  },
  async wikipedia() {
    for (const offset of [0, 1]) { // the feed is by UTC date and can be empty early in the day
      const d = new Date(Date.now() - offset * 864e5);
      const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
      try {
        const { image } = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${path}`);
        if (!image?.thumbnail?.source) continue;
        return {
          imageUrl: image.thumbnail.source.replace(/\/\d+px-/, '/1920px-'),
          title: image.description?.text || image.title, credit: 'Wikipedia', link: image.file_page
        };
      } catch (_) {}
    }
    throw new Error('no Wikipedia picture of the day');
  },
  // NASA's Image of the Day (the Astronomy Picture of the Day service currently returns only a logo).
  // Originals can be hundreds of MB, so the site is asked for a screen-sized copy.
  async nasa() {
    const res = await fetch('https://www.nasa.gov/feeds/iotd-feed', { credentials: 'omit' });
    if (!res.ok) throw new Error(`NASA feed ${res.status}`);
    const xml = await res.text();
    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const tag = /<enclosure\s[^>]*>/.exec(item)?.[0] || '';
      const url = xmlText(/url="([^"]+)"/.exec(tag)?.[1] || '');
      if (!/\.(jpe?g|png|webp)$/i.test(url.split('?')[0])) continue;
      return {
        imageUrl: `${url}${url.includes('?') ? '&' : '?'}w=2560`,
        title: xmlText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] || ''),
        credit: 'NASA',
        link: xmlText(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1] || '')
      };
    }
    throw new Error('no NASA image of the day');
  },
  async picsum() {
    const res = await fetch('https://picsum.photos/2560/1440', { credentials: 'omit' });
    const id = res.headers.get('picsum-id');
    let author = '';
    let link = 'https://picsum.photos';
    if (id) {
      try { const info = await getJson(`https://picsum.photos/id/${id}/info`); author = info.author; link = info.url; } catch (_) {}
    }
    return { response: res, title: author ? `Photo by ${author}` : 'Random photo', credit: 'Picsum', link };
  }
};

// Downscale to screen size so it stays small in storage and draws fast.
async function toPhotoDataUrl(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return toDataUrl(new Uint8Array(await out.arrayBuffer()), 'image/jpeg');
}

async function fetchPhoto(source) {
  const meta = await (PHOTO_SOURCES[source] || PHOTO_SOURCES.bing)();
  const res = meta.response || await fetch(meta.imageUrl, { credentials: 'omit' });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  if (Number(res.headers.get('content-length')) > 40e6) throw new Error('photo too large');
  return {
    dataUrl: await toPhotoDataUrl(await res.blob()),
    title: meta.title || '', credit: meta.credit, link: meta.link || ''
  };
}

let photoInFlight = null;
function refreshPhoto(force = false) {
  photoInFlight ||= (async () => {
    const source = (await Settings.load()).newtab.background.photoSource;
    const { dailyPhoto } = await chrome.storage.local.get('dailyPhoto');
    if (!force && dailyPhoto?.source === source && dailyPhoto.date === localDay()) return true;
    try {
      await chrome.storage.local.set({ dailyPhoto: { ...(await fetchPhoto(source)), source, date: localDay() } });
      return true;
    } catch (_) {
      return false; // offline or the source is down: keep showing the last photo
    }
  })().finally(() => { photoInFlight = null; });
  return photoInFlight;
}

// Have today's photo ready when the browser opens.
chrome.runtime.onStartup.addListener(async () => {
  if ((await Settings.load()).newtab.background.type === 'daily') refreshPhoto();
});

// --- overnight refresh ---------------------------------------------------------------
// One alarm a day at 00:05 local time. If a source hasn't published the new photo yet (the result is the
// same picture as before), retry every few hours, up to RETRIES times.

const PHOTO_ALARM = 'daily-photo';
const PHOTO_RETRY = 'daily-photo-retry';
const RETRIES = 4;
const RETRY_MINUTES = 180;
const nextMidnight = () => { const d = new Date(); d.setHours(24, 5, 0, 0); return d.getTime(); };

async function syncPhotoAlarm() {
  const { background } = (await Settings.load()).newtab;
  if (background.type !== 'daily' || !background.overnight) {
    for (const a of await chrome.alarms.getAll()) {
      if (a.name === PHOTO_ALARM || a.name.startsWith(PHOTO_RETRY)) chrome.alarms.clear(a.name);
    }
    return;
  }
  if (!(await chrome.alarms.get(PHOTO_ALARM))) chrome.alarms.create(PHOTO_ALARM, { when: nextMidnight() });
}

async function overnightRefresh(attempt) {
  const { background } = (await Settings.load()).newtab;
  if (background.type !== 'daily' || !background.overnight) return;
  const before = (await chrome.storage.local.get('dailyPhoto')).dailyPhoto?.dataUrl;
  const ok = await refreshPhoto(attempt > 0); // the first try only fetches if today's isn't stored yet
  const after = (await chrome.storage.local.get('dailyPhoto')).dailyPhoto?.dataUrl;
  const unchanged = !ok || after === before;
  if (unchanged && background.photoSource !== 'picsum' && attempt < RETRIES) {
    chrome.alarms.create(`${PHOTO_RETRY}:${attempt + 1}`, { delayInMinutes: RETRY_MINUTES });
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PHOTO_ALARM) {
    chrome.alarms.create(PHOTO_ALARM, { when: nextMidnight() });
    overnightRefresh(0);
  } else if (alarm.name.startsWith(`${PHOTO_RETRY}:`)) {
    overnightRefresh(Number(alarm.name.split(':')[1]));
  }
});

syncPhotoAlarm();
Settings.onChange(syncPhotoAlarm);
chrome.runtime.onInstalled.addListener(syncPhotoAlarm);
chrome.runtime.onStartup.addListener(syncPhotoAlarm);
