// Shared settings: one object in chrome.storage.local, merged over the defaults below.
// Loaded in the service worker, content scripts, the start page and the options page.
// Wrapped in an IIFE so loading it twice into the same page (re-injection) is harmless.
(() => {
  const isAlive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  if (globalThis.Settings?.isAlive()) return; // already loaded here (an orphan from a reload reports false)

  const DEFAULTS = {
    commandBar: { enabled: true, shortcut: { code: 'KeyT', mod: true, shift: false, alt: false }, openIn: 'new' },
    toolbar: { action: 'settings' }, // what clicking the extension icon does: settings | start | downloads
    bar: { enabled: true },
    buttons: { downloads: true, copyUrl: true, media: true },
    media: { announceSeconds: 5, hideOnSites: [], ignoreSites: [] },
    downloads: { hideNativeUi: true, showSeconds: 6 },
    copyUrl: { shortcut: true },
    session: { restoreOnStartup: true },
    newtab: {
      clock: true, clock24: false, greeting: true, name: '', search: true, focusSearch: true, todo: true, todoSlots: 4,
      // type: gradient | solid | image (your own photo) | daily (downloaded, see photoSource)
      background: { type: 'gradient', gradient: 'aurora', color: '#14161c', photoSource: 'bing', overnight: true, dim: 20, blur: 0 }
    }
  };

  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (base, over) => {
    const out = {};
    for (const k of Object.keys(base)) {
      out[k] = isObject(base[k]) ? merge(base[k], isObject(over?.[k]) ? over[k] : {})
        : over && k in over ? over[k] : base[k];
    }
    return out;
  };

  const normalizeHost = s => String(s || '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  // "youtube.com" matches youtube.com and any subdomain of it.
  const hostMatches = (host, list = []) => {
    const h = normalizeHost(host);
    return list.some(d => { const n = normalizeHost(d); return n && (h === n || h.endsWith(`.${n}`)); });
  };

  let current = merge(DEFAULTS, {});
  const listeners = new Set();

  async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    current = merge(DEFAULTS, settings);
    return current;
  }

  // save(draft => { draft.media.announceSeconds = 3; })
  async function save(mutate) {
    const next = structuredClone(current);
    mutate(next);
    current = next;
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      current = merge(DEFAULTS, changes.settings.newValue);
      listeners.forEach(fn => fn(current));
    });
  } catch (_) {} // orphaned after an extension reload

  globalThis.Settings = {
    DEFAULTS, load, save, normalizeHost, hostMatches, isAlive,
    get current() { return current; },
    onChange: fn => listeners.add(fn)
  };
})();
