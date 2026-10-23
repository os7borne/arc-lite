const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const set = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
};

let savedTimer;
function flashSaved() {
  $('#saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('#saved').classList.remove('on'), 1100);
}

async function update(path, value) {
  await Settings.save(draft => set(draft, path, value));
  flashSaved();
}

// --- generic controls: anything with data-key --------------------------------

function bindControls() {
  for (const el of $$('[data-key]:not(.list)')) {
    const path = el.dataset.key;
    const value = get(Settings.current, path);
    const out = el.parentElement.querySelector('output');
    const show = () => { if (out) out.textContent = el.type === 'range' ? el.value : ''; };

    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
    show();

    el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', () => {
      show();
      const v = el.type === 'checkbox' ? el.checked
        : el.type === 'range' || el.hasAttribute('data-number') ? Number(el.value)
        : el.value.trim();
      update(path, v);
    });
  }
}

// --- list editors (site lists) ----------------------------------------------------

function bindList(el) {
  const path = el.dataset.key;
  const render = () => {
    const sites = get(Settings.current, path);
    const input = document.createElement('input');
    input.placeholder = 'Add a site, e.g. youtube.com';
    const add = () => {
      const host = Settings.normalizeHost(input.value);
      if (!host || sites.includes(host)) { input.value = ''; return; }
      update(path, [...sites, host]).then(render);
    };
    input.onkeydown = e => { if (e.key === 'Enter') add(); };
    input.onblur = add;

    el.replaceChildren(
      ...sites.map(site => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = site;
        const x = document.createElement('button');
        x.textContent = '✕';
        x.title = 'Remove';
        x.onclick = () => update(path, sites.filter(s => s !== site)).then(render);
        chip.append(x);
        return chip;
      }),
      input
    );
  };
  render();
}

// --- background ------------------------------------------------------------------

function renderBackground() {
  const bg = Settings.current.newtab.background;
  $$('#bgType button').forEach(b => b.classList.toggle('on', b.dataset.value === bg.type));
  $$('#gradients button').forEach(b => b.classList.toggle('on', b.dataset.value === bg.gradient));
  $('#bgGradient').hidden = bg.type !== 'gradient';
  $('#bgSolid').hidden = bg.type !== 'solid';
  $('#bgImage').hidden = bg.type !== 'image';
  $('#bgDaily').hidden = bg.type !== 'daily';
  $('#bgOvernight').hidden = bg.type !== 'daily';
  const photo = bg.type === 'image' || bg.type === 'daily';
  $('#bgDim').hidden = !photo;
  $('#bgBlur').hidden = !photo;
}

async function renderDailyState() {
  $('#dailyState').textContent = ''; // only shows a problem, set by fetchPhoto
}

async function fetchPhoto(force) {
  const btn = $('#refreshPhoto');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  const ok = await chrome.runtime.sendMessage({ type: 'refresh-photo', force });
  btn.disabled = false;
  btn.textContent = 'New photo';
  await renderDailyState();
  if (!ok) $('#dailyState').textContent = "Couldn't download a photo. Check your connection.";
  else flashSaved();
}

async function renderImageState() {
  const { bgImage } = await chrome.storage.local.get('bgImage');
  $('#imgState').textContent = bgImage ? 'Photo set' : 'None chosen';
  $('#removeImage').hidden = !bgImage;
}

// Photos are downscaled so they fit comfortably in extension storage.
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2560 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
    img.src = url;
  });
}

function bindBackground() {
  $$('#bgType button').forEach(b => b.onclick = async () => {
    await update('newtab.background.type', b.dataset.value);
    renderBackground();
    if (b.dataset.value === 'daily') fetchPhoto(false);
  });
  $('#photoSource').value = Settings.current.newtab.background.photoSource;
  $('#photoSource').onchange = async e => {
    await update('newtab.background.photoSource', e.target.value); // saved first: the fetch reads it
    fetchPhoto(false);
  };
  $('#refreshPhoto').onclick = () => fetchPhoto(true);
  $$('#gradients button').forEach(b => b.onclick = async () => {
    await update('newtab.background.gradient', b.dataset.value);
    renderBackground();
  });
  $('#pickImage').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await chrome.storage.local.set({ bgImage: await shrink(file) });
      await update('newtab.background.type', 'image');
      renderBackground();
      renderImageState();
    } catch (err) {
      alert('That file could not be used as a photo.');
    }
    e.target.value = '';
  };
  $('#removeImage').onclick = async () => {
    await chrome.storage.local.remove('bgImage');
    renderImageState();
    flashSaved();
  };
}

// --- the rest -----------------------------------------------------------------------

async function renderSession() {
  const { session } = await chrome.storage.local.get('session');
  const tabs = session?.windows?.reduce((n, w) => n + w.tabs.length, 0) || 0;
  $('#sessionInfo').textContent = tabs
    ? `${tabs} tabs in ${session.windows.length} window${session.windows.length > 1 ? 's' : ''}`
    : 'Nothing saved yet';
  $('#forget').hidden = !tabs;
}

// --- command bar shortcut recorder ---------------------------------------------------

const IS_MAC = /Mac/i.test(navigator.platform);
const keyName = code => ({ Space: 'Space', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' }[code]
  || code.replace(/^Key|^Digit|^Numpad/, ''));
const shortcutLabel = s => (IS_MAC
  ? `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}`
  : `${s.mod ? 'Ctrl+' : ''}${s.alt ? 'Alt+' : ''}${s.shift ? 'Shift+' : ''}`) + keyName(s.code);

function bindShortcut() {
  const btn = $('#shortcutBtn');
  const show = () => { btn.textContent = shortcutLabel(Settings.current.commandBar.shortcut); };
  show();
  let recording = false;

  const onKey = async e => {
    e.preventDefault();
    e.stopPropagation();
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return; // wait for the real key
    if (e.key === 'Escape') return stop();
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const other = IS_MAC ? e.ctrlKey : e.metaKey;
    if ((!mod && !e.altKey) || other) {
      btn.textContent = IS_MAC ? 'Include ⌘ or ⌥' : 'Include Ctrl or Alt';
      return;
    }
    await update('commandBar.shortcut', { code: e.code, mod, shift: e.shiftKey, alt: e.altKey });
    stop();
  };
  function stop() {
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    show();
  }
  btn.onclick = () => {
    if (recording) return stop();
    recording = true;
    btn.textContent = 'Press shortcut…';
    window.addEventListener('keydown', onKey, true);
  };
  btn.onblur = () => recording && stop();
  $('#shortcutReset').onclick = async () => {
    await update('commandBar.shortcut', { ...Settings.DEFAULTS.commandBar.shortcut });
    show();
  };
}

function bindMisc() {
  $('#shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  $('#forget').onclick = async () => { await chrome.storage.local.remove('session'); renderSession(); flashSaved(); };
  $('#resetAll').onclick = async () => {
    if (!confirm('Reset all settings to their defaults?')) return;
    await chrome.storage.local.remove('settings');
    location.reload();
  };

  // Highlight the section being read.
  const links = $$('nav a');
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.hash === `#${e.target.id}`));
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  $$('main section').forEach(s => io.observe(s));
}

(async () => {
  await Settings.load();
  bindControls();
  $$('.list').forEach(bindList);
  bindShortcut();
  bindBackground();
  renderBackground();
  renderImageState();
  renderDailyState();
  renderSession();
  bindMisc();
})();
