// Runs in the page's own world (top frame, document_start) so it can see the page's Media Session handlers.
//
// 1. Chrome opens picture-in-picture by itself when you leave a tab with playing video, but only if the page has
//    an 'enterpictureinpicture' handler. This puts our handler in that slot (the site's own one is kept and
//    restored when auto-PiP is off) and passes the call to media-agent.js through a DOM event.
// 2. It keeps a copy of every other Media Session handler the site registers (play, pause, next and previous
//    track, seek). media-agent.js can't reach those from its own world, but they are how most music sites (Spotify,
//    SoundCloud, Apple Music, Deezer, Tidal...) want to be controlled, so it asks this script to call them.
(() => {
  const session = navigator.mediaSession;
  if (!session || window.__arcPipShim) return;
  window.__arcPipShim = true;

  const set = session.setActionHandler.bind(session);
  const canPip = 'documentPictureInPicture' in window;
  const handlers = new Map(); // the site's own handlers, by action
  let siteHandler = null;
  let on = false;

  const ours = () => document.dispatchEvent(new CustomEvent('arc-pip:enter'));
  const apply = () => { try { set('enterpictureinpicture', on ? ours : siteHandler); } catch (_) {} };
  // Which actions the site handles, told to media-agent.js (it asks when it starts, and on every report).
  const announce = () => document.dispatchEvent(new CustomEvent('arc-media:actions', { detail: JSON.stringify([...handlers.keys()]) }));

  session.setActionHandler = function (action, handler) {
    if (action === 'enterpictureinpicture' && canPip) {
      siteHandler = handler;
      return apply();
    }
    if (handler) handlers.set(action, handler); else handlers.delete(action);
    announce();
    return set(action, handler);
  };

  document.addEventListener('arc-media:query', announce);
  document.addEventListener('arc-media:call', e => {
    try {
      const { action, details } = JSON.parse(e.detail);
      handlers.get(action)?.({ action, ...details });
    } catch (_) {}
  });
  if (canPip) document.addEventListener('arc-pip:config', e => { on = e.detail === 'on'; apply(); });
})();
