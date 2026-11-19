// Feed filter (content script, x.com / twitter.com / linkedin.com only): hides posts that contain a video or GIF.
//
// Posts are never removed from the page, only tagged with data-arc-video-hidden, and one injected rule hides the
// tagged ones. That keeps X's virtualized timeline happy, and turning the setting off just un-tags everything.
// A post that gets its <video> late is caught on the next mutation, since every scan re-judges every post.
(() => {
  const isAlive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  if (globalThis.__feedFilter?.()) return; // already running here (an orphan from a reload reports false)
  globalThis.__feedFilter = isAlive;

  const ATTR = 'data-arc-video-hidden';
  const STYLE_ID = 'arc-lite-feed-filter';

  // One adapter per site: which settings key it uses, how to find posts, and how to tell one has video.
  // `row` is the element to hide for a post (the whole timeline row, so no gap is left behind).
  const SITES = [
    {
      key: 'x',
      hosts: /(^|\.)(x|twitter)\.com$/,
      posts: 'article[data-testid="tweet"]',
      row: post => post.closest('[data-testid="cellInnerDiv"]') || post,
      // Real videos, GIFs (X serves them as <video>) and quoted posts all contain one of these.
      hasVideo: post => !!post.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video'),
      // The post you opened on its own page stays visible; only the feed around it is filtered.
      isOpened(post) {
        const id = location.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1];
        if (!id) return false;
        const own = new RegExp(`/status/${id}(?:$|[/?])`);
        return [...post.querySelectorAll('a[href*="/status/"]')].some(a => a.querySelector('time') && own.test(a.getAttribute('href')));
      }
    },
    {
      key: 'linkedin',
      hosts: /(^|\.)linkedin\.com$/,
      // Class names rotate on LinkedIn, so lean on the stable data-urn attribute, with the old class as a fallback.
      posts: '[data-urn^="urn:li:activity"], [data-urn^="urn:li:ugcPost"], [data-urn^="urn:li:share"], div.feed-shared-update-v2',
      row: post => post,
      hasVideo: post => !!post.querySelector('video, .video-js, [class*="linkedin-video"], [class*="video-player"], [data-test-video-player], [data-testid*="video"]'),
      isOpened: () => /^\/(feed\/update|posts)\//.test(location.pathname)
    }
  ];

  const site = SITES.find(s => s.hosts.test(location.hostname));
  if (!site || !globalThis.Settings) return;

  let scheduled = false;
  let observer;

  const enabled = () => !!Settings.current.feed?.hideVideo?.[site.key];

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (enabled() && !style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `[${ATTR}] { display: none !important; }`;
      (document.head || document.documentElement).appendChild(style);
    } else if (!enabled()) {
      style?.remove();
    }
  }

  function scan() {
    scheduled = false;
    if (!isAlive()) return stop();
    ensureStyle();
    const on = enabled();
    const rows = new Set();
    for (const post of document.querySelectorAll(site.posts)) {
      const row = site.row(post);
      const hide = on && site.hasVideo(post) && !site.isOpened(post);
      if (hide) rows.add(row);
      else if (!rows.has(row)) row.removeAttribute(ATTR);
    }
    rows.forEach(r => r.setAttribute(ATTR, ''));
  }

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  };

  function stop() {
    observer?.disconnect();
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`[${ATTR}]`).forEach(el => el.removeAttribute(ATTR));
  }

  Settings.load().then(() => {
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  }).catch(() => {});
  Settings.onChange(schedule);
})();
