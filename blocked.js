// The page blocked sites are redirected to during focus mode. The address that was blocked rides along in the hash.
const $ = s => document.querySelector(s);
const original = decodeURI(location.hash.slice(1));
const CIRC = 2 * Math.PI * 46;

let state = { phase: 'off' };
let cfg = Settings.current.focus;

const blocking = s => !s.paused && (s.phase === 'focus' || (s.phase === 'break' && !cfg.breakUnblocks));

try { $('#site').textContent = new URL(original).hostname.replace(/^www\./, ''); } catch (_) {}

const fmt = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Once the session no longer blocks, go to where you were headed.
function leaveIfDone() {
  if (blocking(state)) return;
  if (/^https?:/i.test(original)) location.replace(original);
  else location.replace(chrome.runtime.getURL('newtab.html'));
}

function draw() {
  const left = state.paused ? state.remainingMs : state.endsAt - Date.now();
  $('#time').textContent = fmt(left);
  const frac = state.durationMs ? Math.min(1, Math.max(0, left / state.durationMs)) : 0;
  $('#bar').style.strokeDasharray = CIRC;
  $('#bar').style.strokeDashoffset = CIRC * (1 - frac);
  const dots = $('#dots');
  dots.hidden = false;
  const n = cfg.longEvery;
  dots.replaceChildren(...Array.from({ length: n }, (_, i) => Object.assign(document.createElement('i'), { className: i < (state.cycle || 0) % n ? 'on' : '' })));
}

async function load() {
  cfg = (await Settings.load()).focus;
  state = (await chrome.storage.local.get('focusState')).focusState || { phase: 'off' };
  leaveIfDone();
  draw();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.focusState || changes.settings)) return;
  load();
});

$('#back').onclick = () => (history.length > 1 ? history.back() : (location.href = chrome.runtime.getURL('newtab.html')));
$('#newtab').onclick = () => { location.href = chrome.runtime.getURL('newtab.html'); };

setInterval(() => state.phase !== 'off' && draw(), 1000);
load();
