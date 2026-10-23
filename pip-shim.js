// Runs in the page's own world (top frame, document_start) so it can see the page's Media Session handlers.
// Chrome opens picture-in-picture by itself when you leave a tab with playing video, but only if the page has
// an 'enterpictureinpicture' handler. This puts our handler in that slot (the site's own one is kept and
// restored when auto-PiP is off) and passes the call to media-agent.js through a DOM event.
(() => {
  const session = navigator.mediaSession;
  if (!session || !('documentPictureInPicture' in window) || window.__arcPipShim) return;
  window.__arcPipShim = true;

  const set = session.setActionHandler.bind(session);
  let siteHandler = null;
  let on = false;

  const ours = () => document.dispatchEvent(new CustomEvent('arc-pip:enter'));
  const apply = () => { try { set('enterpictureinpicture', on ? ours : siteHandler); } catch (_) {} };

  session.setActionHandler = function (action, handler) {
    if (action !== 'enterpictureinpicture') return set(action, handler);
    siteHandler = handler;
    apply();
  };

  document.addEventListener('arc-pip:config', e => { on = e.detail === 'on'; apply(); });
})();
