/**
 * background.js  (MV3 service worker)
 * ---------------------------------------------------------------------------
 * Deliberately thin. The agent runs entirely in the content script, because
 * that is the only context with the page's origin — and therefore the only
 * context whose fetches carry the AbhiBus session cookies.
 *
 * This worker does two things:
 *   - toggles the panel when the toolbar icon is clicked
 *   - seeds default settings on install
 * ---------------------------------------------------------------------------
 */

const DEFAULTS = {
  backendUrl: 'http://localhost:8787',
  debug: false,
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);

  // Point first-time users at the settings so they can set the backend URL.
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // The content script only exists on abhibus.com.
  if (!/^https?:\/\/([a-z0-9-]+\.)*abhibus\.com\//i.test(tab.url ?? '')) {
    await chrome.tabs.create({ url: 'https://www.abhibus.com/' });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch {
    // Content script not injected yet (page loaded before the extension was
    // enabled). A reload wires it up.
    await chrome.tabs.reload(tab.id);
  }
});
