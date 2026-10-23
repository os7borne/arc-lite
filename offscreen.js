chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'copy') return;
  const t = document.getElementById('t');
  t.value = msg.text;
  t.select();
  document.execCommand('copy');
  sendResponse(true);
});
