// Offscreen document: clipboard copy, and still frames from video files for download thumbnails.
const SIZE = 96;
const MAX_BYTES = 500 * 1024 * 1024; // bigger videos are skipped rather than loaded into memory

// Grabs a frame from the first source that loads, scaled to cover a square. Resolves '' if none can be decoded.
function videoFrame(sources) {
  // Read the file into a same-origin blob first: a file:// or cross-origin video would taint the canvas.
  const attempt = src => new Promise(async resolve => {
    let blobUrl = '';
    let blob;
    try {
      const res = await fetch(src, { credentials: 'include' });
      blob = res.ok ? await res.blob() : null;
    } catch (_) { blob = null; }
    if (!blob || blob.size > MAX_BYTES) return resolve('');
    blobUrl = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = url => { clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(blobUrl); resolve(url); };
    const timer = setTimeout(() => done(''), 8000);
    v.onerror = () => done('');
    v.onloadedmetadata = () => {
      // A little way in, so the frame isn't the black one many videos open with.
      v.currentTime = Number.isFinite(v.duration) ? Math.min(5, v.duration * 0.1) : 0;
    };
    v.onseeked = () => {
      if (!v.videoWidth) return done('');
      const k = Math.max(SIZE / v.videoWidth, SIZE / v.videoHeight);
      const w = v.videoWidth * k, h = v.videoHeight * k;
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      try {
        c.getContext('2d').drawImage(v, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        done(c.toDataURL('image/jpeg', 0.8));
      } catch (_) { done(''); } // a tainted canvas (cross-origin source)
    };
    v.src = blobUrl;
  });
  return (async () => {
    for (const src of sources) {
      const url = await attempt(src);
      if (url) return url;
    }
    return '';
  })();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'copy') {
    const t = document.getElementById('t');
    t.value = msg.text;
    t.select();
    document.execCommand('copy');
    sendResponse(true);
  } else if (msg.type === 'video-thumb') {
    videoFrame(msg.sources).then(sendResponse);
    return true; // answered asynchronously
  }
});
