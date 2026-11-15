// Runs in every frame. Finds the <video>/<audio> that matters, reports its state to the background
// script, and carries out play/pause/seek/skip commands sent back.
(() => {
  const isAlive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  // Our own picture-in-picture window is an about:blank page this script also matches: the page that opened it
  // already reports the video (it lives there), so the window must not report it a second time.
  try { if (window.opener?.documentPictureInPicture?.window === window) return; } catch (_) {}
  if (globalThis.__mediaAgent?.()) return; // already running here (an orphan from a reload reports false)
  globalThis.__mediaAgent = isAlive;

  // Sites whose player exposes next/previous buttons we can click (the Media Session handlers aren't reachable).
  const SKIP = {
    'www.youtube.com': { next: '.ytp-next-button', prev: '.ytp-prev-button' },
    'music.youtube.com': { next: 'ytmusic-player-bar .next-button', prev: 'ytmusic-player-bar .previous-button' },
    'open.spotify.com': {
      next: '[data-testid="control-button-skip-forward"]',
      prev: '[data-testid="control-button-skip-back"]'
    },
    'soundcloud.com': { next: '.playControls__next', prev: '.playControls__prev' },
    'www.deezer.com': { next: '[data-testid="next_track_button"]', prev: '[data-testid="previous_track_button"]' },
    'listen.tidal.com': { next: '[data-test="next"]', prev: '[data-test="previous"]' }
  };
  // Sites that are about audio: picture-in-picture gets a small player of our own instead of floating a video.
  const AUDIO_HOSTS = /(^|\.)(spotify|soundcloud|deezer|tidal|pandora|bandcamp|mixcloud|audiomack|napster|qobuz)\.com$|^music\.(youtube|apple|amazon)\./i;

  const EVENTS = ['play', 'playing', 'pause', 'ended', 'seeked', 'volumechange', 'loadedmetadata',
    'durationchange', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture'];
  const userMuted = new WeakSet(); // muted from the widget: must not make the player disappear
  // Document picture-in-picture (top frame only): our own window with minimise/close buttons.
  const docPip = window.top === window && globalThis.documentPictureInPicture || null;
  let active = null;
  let reportedGone = true;
  let debounce;
  let lastTick = 0;

  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  const send = msg => alive() && chrome.runtime.sendMessage(msg).catch(() => {});

  // The site's Media Session handlers (play, pause, next and previous track, seek) live in the page's own world.
  // pip-shim.js keeps them and tells us which exist; we ask it to call them. Most music sites want to be controlled
  // this way, and a few misbehave if you pause their audio element behind their back.
  const siteActions = new Set();
  document.addEventListener('arc-media:actions', e => {
    try { siteActions.clear(); JSON.parse(e.detail).forEach(a => siteActions.add(a)); } catch (_) {}
  });
  const querySite = () => document.dispatchEvent(new CustomEvent('arc-media:query'));
  const callSite = (action, details = {}) => {
    if (!siteActions.has(action)) return false;
    document.dispatchEvent(new CustomEvent('arc-media:call', { detail: JSON.stringify({ action, details }) }));
    return true;
  };
  querySite();

  // Muted looping/autoplaying clips (hero videos, GIF replacements) aren't "media" to control.
  const ignorable = el => (!el.currentSrc && !el.srcObject) || (el.muted && !userMuted.has(el) && (el.loop || el.autoplay));

  function pick() {
    const docs = [document, docPip?.window?.document].filter(Boolean);
    const els = docs.flatMap(d => [...d.querySelectorAll('video, audio')]).filter(el => !ignorable(el));
    const playing = els.find(el => !el.paused && !el.ended && el.readyState >= 2);
    if (playing) return playing;
    return els.includes(active) ? active : null;
  }

  // Audio you can't float as a video: an <audio> element, a music site, or a <video> with no picture.
  const audioOnly = el => el.localName === 'audio' || AUDIO_HOSTS.test(location.hostname) || (el.readyState >= 1 && !el.videoWidth);

  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    play: ['M6 4l14 8-14 8z', true],
    pause: ['M6 4h4v16H6zM14 4h4v16h-4z', true],
    prev: ['M19 20 9 12l10-8zM5 4v16', true],
    next: ['M5 4l10 8-10 8zM19 4v16', true],
    minimise: ['M5 12h14'],
    close: ['M6 6l12 12M18 6L6 18']
  };
  const icon = (doc, name, size = 18) => {
    const [d, filled] = ICONS[name];
    const svg = doc.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', 'stroke-width': 2.4,
      'stroke-linecap': 'round', fill: filled ? 'currentColor' : 'none', stroke: 'currentColor' })) svg.setAttribute(k, v);
    const path = doc.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };

  // Moves the video into a small window of our own. Minimise closes the window and the video goes back to its
  // page, still playing (the mini player keeps it); Close pauses it first.
  async function openDocPip(video, auto = false) {
    const rect = video.getBoundingClientRect();
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const width = Math.round(Math.min(560, Math.max(320, rect.width || 480)));
    const win = await docPip.requestWindow({ width, height: Math.round(width / ratio) });
    const doc = win.document;
    listen(doc);

    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden;
                   font: 12px -apple-system, system-ui, sans-serif; color: #fff; }
      video { position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important;
              max-width: none !important; max-height: none !important; object-fit: contain !important;
              transform: none !important; margin: 0 !important; background: #000; }
      .ui { position: fixed; inset: 0; opacity: 0; transition: opacity .15s;
            background: linear-gradient(rgba(0,0,0,.6), transparent 35%, transparent 60%, rgba(0,0,0,.7)); }
      body:hover .ui, body.paused .ui { opacity: 1; }
      button { display: flex; align-items: center; justify-content: center; padding: 0; border: 0; color: #fff;
               cursor: pointer; font: 600 12px -apple-system, system-ui, sans-serif; }
      .top { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; }
      .top button { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,.16); }
      .mid { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex;
             align-items: center; gap: 18px; }
      .mid button { width: 40px; height: 40px; border-radius: 50%; background: rgba(0,0,0,.45); }
      .mid .main { width: 54px; height: 54px; }
      button:hover { background: rgba(255,255,255,.3) !important; }
      .seek { position: absolute; left: 12px; right: 12px; bottom: 10px; display: flex; align-items: center; gap: 8px; }
      .seek.off { display: none; }
      .seek span { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
      input[type=range] { flex: 1; height: 14px; margin: 0; cursor: pointer; -webkit-appearance: none; appearance: none;
                          background: transparent; }
      input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
        background: linear-gradient(to right, #fff var(--p, 0%), rgba(255,255,255,.3) var(--p, 0%)); }
      input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px;
                                                border-radius: 50%; background: #fff; }`;
    doc.head.append(style);

    const button = (name, title, onclick, size) => {
      const b = doc.createElement('button');
      b.title = title;
      if (name) b.append(icon(doc, name, size));
      b.onclick = onclick;
      return b;
    };
    const skip = delta => () => {
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
    };
    const playBtn = button('pause', 'Pause', () => (video.paused ? video.play().catch(() => {}) : video.pause()), 26);
    playBtn.className = 'main';
    const el = (tag, className) => Object.assign(doc.createElement(tag), { className });
    const top = el('div', 'top');
    top.append(
      button('minimise', 'Minimise (keep playing in the mini player)', () => win.close()),
      button('close', 'Close and stop', () => { video.pause(); win.close(); })
    );
    const back = button('', 'Back 10 seconds', skip(-10));
    const fwd = button('', 'Forward 10 seconds', skip(10));
    back.textContent = '−10';
    fwd.textContent = '+10';
    const mid = el('div', 'mid');
    mid.append(back, playBtn, fwd);

    const range = Object.assign(el('input'), { type: 'range', min: 0, max: 1000, value: 0 });
    const cur = el('span');
    const dur = el('span');
    const seek = el('div', 'seek');
    seek.append(cur, range, dur);
    const fmt = t => {
      t = Math.max(0, Math.floor(t || 0));
      const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = String(t % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    };
    let scrubbing = false;
    const syncTime = () => {
      const seekable = Number.isFinite(video.duration) && video.duration > 0; // live streams have no end
      seek.classList.toggle('off', !seekable);
      back.style.display = fwd.style.display = seekable ? '' : 'none';
      if (!seekable) return;
      cur.textContent = fmt(video.currentTime);
      dur.textContent = fmt(video.duration);
      if (!scrubbing) {
        range.value = (video.currentTime / video.duration) * 1000;
        range.style.setProperty('--p', `${range.value / 10}%`);
      }
    };
    range.addEventListener('input', () => {
      scrubbing = true;
      range.style.setProperty('--p', `${range.value / 10}%`);
      cur.textContent = fmt((range.value / 1000) * video.duration);
    });
    range.addEventListener('change', () => {
      video.currentTime = (range.value / 1000) * video.duration;
      scrubbing = false;
    });

    const ui = el('div', 'ui');
    ui.append(top, mid, seek);
    const syncPlay = () => {
      const paused = video.paused;
      playBtn.title = paused ? 'Play' : 'Pause';
      playBtn.replaceChildren(icon(doc, paused ? 'play' : 'pause', 26));
      doc.body.classList.toggle('paused', paused);
    };
    const syncAll = () => { syncPlay(); syncTime(); };
    for (const type of ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata']) video.addEventListener(type, syncTime);
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    syncAll();

    // The page's own stylesheets don't reach this window, but inline styles the site set on the video do, and
    // YouTube keeps rewriting them (pixel width/height/left/top) as its player resizes. Inline !important gets
    // dropped on those rewrites, so the sizing lives in the stylesheet above, where !important beats any inline.
    const marker = document.createComment('arc-lite-pip');
    const prevStyle = video.getAttribute('style');
    video.parentNode.insertBefore(marker, video);
    video.style.cssText = 'position: static !important; width: 100% !important; height: 100% !important; ' +
      'object-fit: contain !important; transform: none !important; margin: 0 !important';
    doc.body.append(video, ui);

    const onVisible = () => document.visibilityState === 'visible' && win.close();
    if (auto) document.addEventListener('visibilitychange', onVisible);

    win.addEventListener('pagehide', () => {
      document.removeEventListener('visibilitychange', onVisible);
      video.removeEventListener('play', syncPlay);
      video.removeEventListener('pause', syncPlay);
      for (const type of ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata']) video.removeEventListener(type, syncTime);
      const wasPlaying = !video.paused;
      if (prevStyle == null) video.removeAttribute('style'); else video.setAttribute('style', prevStyle);
      if (marker.isConnected) marker.replaceWith(video);
      if (wasPlaying && video.paused) video.play().catch(() => {});
      soon();
    });
    soon();
  }

  // Chrome calls this (through pip-shim.js) when you leave a tab that is playing video.
  document.addEventListener('arc-pip:enter', () => {
    const el = pick();
    if (docPip && !docPip.window && el?.localName === 'video' && !el.disablePictureInPicture && !el.paused) {
      openDocPip(el, true).catch(() => {});
    }
  });
  if (docPip && globalThis.Settings) {
    const sync = () => document.dispatchEvent(new CustomEvent('arc-pip:config',
      { detail: Settings.current.media.autoPip ? 'on' : 'off' }));
    Settings.load().then(sync).catch(() => {});
    Settings.onChange(sync);
  }

  // Picture-in-picture needs a recent user gesture in this page. A click on the widget counts when the
  // video is in the same page; otherwise the next click or key press on the page does it.
  async function togglePip(el, retried = false) {
    try {
      if (docPip?.window) return docPip.window.close(); // minimise: the video returns to the page
      if (document.pictureInPictureElement) return await document.exitPictureInPicture();
      if (audioOnly(el)) return docPip ? await openAudioPip(el) : undefined;
      if (el.localName !== 'video') return;
      if (docPip && !el.disablePictureInPicture) return await openDocPip(el);
      if (!document.pictureInPictureEnabled) return;
      await el.requestPictureInPicture();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        send({ type: 'pip-hint', text: `Picture-in-Picture failed (${err.name})` });
        return;
      }
      if (retried) return;
      send({ type: 'pip-hint' });
      const stop = () => {
        removeEventListener('pointerdown', go, true);
        removeEventListener('keydown', go, true);
        clearTimeout(giveUp);
      };
      const go = () => { stop(); togglePip(el, true); };
      const giveUp = setTimeout(stop, 15000);
      addEventListener('pointerdown', go, true);
      addEventListener('keydown', go, true);
    }
  }

  // For the action bar in this same page: calling this inside its click keeps the user gesture intact.
  globalThis.__mediaPip = () => { const el = pick(); if (el) togglePip(el); };

  function togglePlay(el) {
    const paused = el.paused;
    if (callSite(paused ? 'play' : 'pause')) return;
    if (paused) el.play().catch(() => {}); else el.pause();
  }
  function seekTo(el, t) {
    t = Math.max(0, Math.min(el.duration || Infinity, t));
    if (!callSite('seekto', { seekTime: t })) el.currentTime = t;
  }
  function skipTrack(which) {
    if (callSite(which === 'next' ? 'nexttrack' : 'previoustrack')) return;
    skipButton(which)?.click();
  }
  const canSkip = which => !!skipButton(which) || siteActions.has(which === 'next' ? 'nexttrack' : 'previoustrack');

  // Picture-in-picture for audio (Spotify and the like): there's no video to float, so this is a small player of our
  // own in the same kind of window: the artwork, title and artist, a seek bar and the controls, kept in step with the page.
  async function openAudioPip(el) {
    const win = await docPip.requestWindow({ width: 380, height: 172 });
    const doc = win.document;
    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin: 0; height: 100%; background: #1c1c1e; color: #f2f2f7; overflow: hidden;
                   font: 13px -apple-system, system-ui, sans-serif; }
      .wrap { position: relative; display: flex; align-items: center; gap: 12px; height: 100%; box-sizing: border-box; padding: 10px 12px; }
      .art { flex: none; width: 76px; height: 76px; border-radius: 10px; object-fit: cover; background: #2c2c2e; }
      .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .t { font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 24px; }
      .a { margin-top: -4px; font-size: 12px; color: #a1a1a8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .seek { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #a1a1a8; font-variant-numeric: tabular-nums; }
      .seek.off { visibility: hidden; }
      input[type=range] { flex: 1; height: 14px; margin: 0; cursor: pointer; -webkit-appearance: none; appearance: none; background: transparent; }
      input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
        background: linear-gradient(to right, #f2f2f7 var(--p, 0%), rgba(255,255,255,.2) var(--p, 0%)); }
      input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; margin-top: -3px; border-radius: 50%; background: #fff; }
      .ctl { display: flex; align-items: center; gap: 6px; }
      button { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0;
               border-radius: 50%; background: transparent; color: #f2f2f7; cursor: pointer; }
      button:hover { background: rgba(255,255,255,.14); }
      button.main { width: 36px; height: 36px; background: #f2f2f7; color: #1c1c1e; }
      button.main:hover { background: #fff; }
      .x { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; opacity: .6; }
      .x:hover { opacity: 1; }`;
    doc.head.append(style);

    const make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
    const btn = (name, title, onclick, size = 16) => {
      const b = make('button');
      b.title = title;
      b.append(icon(doc, name, size));
      b.onclick = onclick;
      return b;
    };
    const art = make('img', 'art');
    art.alt = '';
    const title = make('div', 't');
    const artist = make('div', 'a');
    const cur = make('span');
    const dur = make('span');
    const range = Object.assign(make('input'), { type: 'range', min: 0, max: 1000, value: 0 });
    const seek = make('div', 'seek');
    seek.append(cur, range, dur);
    const prev = btn('prev', 'Previous', () => skipTrack('prev'), 15);
    const play = btn('play', 'Play', () => { togglePlay(el); setTimeout(paint, 150); }, 16);
    play.className = 'main';
    const next = btn('next', 'Next', () => skipTrack('next'), 15);
    const ctl = make('div', 'ctl');
    ctl.append(prev, play, next);
    const col = make('div', 'col');
    col.append(title, artist, seek, ctl);
    const close = btn('close', 'Close', () => win.close(), 12);
    close.className = 'x';
    const wrap = make('div', 'wrap');
    wrap.append(art, col, close);
    doc.body.append(wrap);

    const fmt = t => {
      t = Math.max(0, Math.floor(t || 0));
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    };
    let scrubbing = false;
    let lastArt = '';
    function paint() {
      const md = navigator.mediaSession?.metadata;
      const name = md?.title || document.title;
      title.textContent = name;
      doc.title = name;
      artist.textContent = md?.artist || '';
      artist.style.display = md?.artist ? '' : 'none';
      const src = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : '';
      if (src !== lastArt) { lastArt = src; if (src) art.src = src; else art.removeAttribute('src'); }
      art.style.visibility = src ? '' : 'hidden';
      play.replaceChildren(icon(doc, el.paused ? 'play' : 'pause', 16));
      play.title = el.paused ? 'Play' : 'Pause';
      prev.style.display = canSkip('prev') ? '' : 'none';
      next.style.display = canSkip('next') ? '' : 'none';
      const seekable = Number.isFinite(el.duration) && el.duration > 0;
      seek.classList.toggle('off', !seekable);
      if (seekable) {
        cur.textContent = fmt(el.currentTime);
        dur.textContent = fmt(el.duration);
        if (!scrubbing) {
          range.value = (el.currentTime / el.duration) * 1000;
          range.style.setProperty('--p', `${range.value / 10}%`);
        }
      }
    }
    range.addEventListener('input', () => {
      scrubbing = true;
      range.style.setProperty('--p', `${range.value / 10}%`);
      cur.textContent = fmt((range.value / 1000) * el.duration);
    });
    range.addEventListener('change', () => { seekTo(el, (range.value / 1000) * el.duration); scrubbing = false; });

    // Tracks change without any media event (the site just swaps the metadata), so it also repaints on a timer.
    const types = ['timeupdate', 'play', 'pause', 'durationchange', 'seeked', 'loadedmetadata', 'emptied'];
    types.forEach(t => el.addEventListener(t, paint));
    const timer = setInterval(paint, 1000);
    win.addEventListener('pagehide', () => {
      clearInterval(timer);
      types.forEach(t => el.removeEventListener(t, paint));
      soon();
    });
    paint();
    soon();
  }

  function skipButton(which) {
    const sel = SKIP[location.hostname]?.[which];
    const btn = sel && document.querySelector(sel);
    return btn && btn.getClientRects().length ? btn : null;
  }

  function report() {
    if (!alive()) return;
    const el = pick();
    if (!el) {
      if (!reportedGone) { reportedGone = true; send({ type: 'media-report', gone: true }); }
      return;
    }
    reportedGone = false;
    querySite();
    const md = navigator.mediaSession?.metadata;
    const art = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : el.poster || '';
    send({
      type: 'media-report',
      state: {
        playing: !el.paused && !el.ended,
        title: md?.title || (window.top === window ? document.title : ''),
        artist: md?.artist || '',
        artwork: art,
        currentTime: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        muted: el.muted,
        canSkip: { next: canSkip('next'), prev: canSkip('prev') },
        // Audio floats in a player of our own, which needs document picture-in-picture (top frame only).
        canPip: audioOnly(el) ? !!docPip : el.localName === 'video' && (!!docPip || document.pictureInPictureEnabled) && !el.disablePictureInPicture,
        pip: document.pictureInPictureElement === el || el.ownerDocument !== document || (audioOnly(el) && !!docPip?.window)
      }
    });
  }

  const soon = () => { clearTimeout(debounce); debounce = setTimeout(report, 100); };

  function listen(doc) {
    for (const type of EVENTS) {
      doc.addEventListener(type, e => {
        if (!(e.target instanceof HTMLMediaElement)) return;
        if (type === 'play' || type === 'playing') active = e.target;
        soon();
      }, true);
    }
    doc.addEventListener('timeupdate', e => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      const now = Date.now();
      if (now - lastTick < 1000) return;
      lastTick = now;
      report();
    }, true);
  }
  listen(document);

  addEventListener('pagehide', () => {
    if (!reportedGone) { reportedGone = true; send({ type: 'media-report', gone: true }); }
  });
  addEventListener('pageshow', e => e.persisted && soon());

  if (alive()) {
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type !== 'media-command') return;
      const el = pick();
      switch (msg.action) {
        case 'toggle':
          if (el) togglePlay(el);
          break;
        case 'pip':
          if (el) togglePip(el);
          break;
        case 'mute':
          if (el) { el.muted = !el.muted; userMuted.add(el); }
          break;
        case 'seek':
          if (el) seekTo(el, el.currentTime + msg.delta);
          break;
        case 'next':
        case 'prev':
          skipTrack(msg.action);
          break;
      }
      setTimeout(report, 200);
    });
  }

  soon(); // media already playing when the script loads
})();
