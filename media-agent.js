// Runs in every frame. Finds the <video>/<audio> that matters, reports its state to the background
// script, and carries out play/pause/seek/skip commands sent back.
(() => {
  const isAlive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  if (globalThis.__mediaAgent?.()) return; // already running here (an orphan from a reload reports false)
  globalThis.__mediaAgent = isAlive;

  // Sites whose player exposes next/previous buttons we can click (the Media Session handlers aren't reachable).
  const SKIP = {
    'www.youtube.com': { next: '.ytp-next-button', prev: '.ytp-prev-button' },
    'music.youtube.com': { next: 'ytmusic-player-bar .next-button', prev: 'ytmusic-player-bar .previous-button' },
    'open.spotify.com': {
      next: '[data-testid="control-button-skip-forward"]',
      prev: '[data-testid="control-button-skip-back"]'
    }
  };

  const EVENTS = ['play', 'playing', 'pause', 'ended', 'seeked', 'volumechange', 'loadedmetadata',
    'durationchange', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture'];
  const userMuted = new WeakSet(); // muted from the widget: must not make the player disappear
  let active = null;
  let reportedGone = true;
  let debounce;
  let lastTick = 0;

  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  const send = msg => alive() && chrome.runtime.sendMessage(msg).catch(() => {});

  // Muted looping/autoplaying clips (hero videos, GIF replacements) aren't "media" to control.
  const ignorable = el => (!el.currentSrc && !el.srcObject) || (el.muted && !userMuted.has(el) && (el.loop || el.autoplay));

  function pick() {
    const els = [...document.querySelectorAll('video, audio')].filter(el => !ignorable(el));
    const playing = els.find(el => !el.paused && !el.ended && el.readyState >= 2);
    if (playing) return playing;
    return els.includes(active) ? active : null;
  }

  // Picture-in-picture needs a recent user gesture in this page. A click on the widget counts when the
  // video is in the same page; otherwise the next click or key press on the page does it.
  async function togglePip(el, retried = false) {
    try {
      if (document.pictureInPictureElement) return await document.exitPictureInPicture();
      if (!(el instanceof HTMLVideoElement) || !document.pictureInPictureEnabled) return;
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
        canSkip: { next: !!skipButton('next'), prev: !!skipButton('prev') },
        canPip: el instanceof HTMLVideoElement && document.pictureInPictureEnabled && !el.disablePictureInPicture,
        pip: document.pictureInPictureElement === el
      }
    });
  }

  const soon = () => { clearTimeout(debounce); debounce = setTimeout(report, 100); };

  for (const type of EVENTS) {
    document.addEventListener(type, e => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      if (type === 'play' || type === 'playing') active = e.target;
      soon();
    }, true);
  }
  document.addEventListener('timeupdate', e => {
    if (!(e.target instanceof HTMLMediaElement)) return;
    const now = Date.now();
    if (now - lastTick < 1000) return;
    lastTick = now;
    report();
  }, true);

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
          if (el) el.paused ? el.play().catch(() => {}) : el.pause();
          break;
        case 'pip':
          if (el) togglePip(el);
          break;
        case 'mute':
          if (el) { el.muted = !el.muted; userMuted.add(el); }
          break;
        case 'seek':
          if (el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + msg.delta));
          break;
        case 'next':
        case 'prev':
          skipButton(msg.action)?.click();
          break;
      }
      setTimeout(report, 200);
    });
  }

  soon(); // media already playing when the script loads
})();
