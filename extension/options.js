/**
 * options.js
 * ---------------------------------------------------------------------------
 * Reads and writes the two settings the extension has, and offers a health
 * check so a misconfigured gateway shows up here rather than as a dead chat.
 * ---------------------------------------------------------------------------
 */

const urlInput = document.getElementById('backendUrl');
const debugInput = document.getElementById('debug');
const statusEl = document.getElementById('status');

function setStatus(text, tone = 'ok') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  if (text) setTimeout(() => (statusEl.textContent = ''), 4000);
}

function normalise(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function load() {
  const stored = await chrome.storage.sync.get(['backendUrl', 'debug']);
  urlInput.value = stored.backendUrl || 'http://localhost:8787';
  debugInput.checked = stored.debug === true;
}

document.getElementById('save').addEventListener('click', async () => {
  const backendUrl = normalise(urlInput.value);

  if (backendUrl && !/^https?:\/\//i.test(backendUrl)) {
    setStatus('URL must start with http:// or https://', 'error');
    return;
  }

  await chrome.storage.sync.set({ backendUrl, debug: debugInput.checked });
  urlInput.value = backendUrl;
  setStatus('Saved. Reload the AbhiBus tab to apply.');
});

document.getElementById('test').addEventListener('click', async () => {
  const backendUrl = normalise(urlInput.value) || 'http://localhost:8787';
  setStatus('Checking…');

  try {
    const res = await fetch(`${backendUrl}/health`, { method: 'GET' });
    if (!res.ok) {
      setStatus(`Gateway replied HTTP ${res.status}`, 'error');
      return;
    }
    const body = await res.json();
    const providers = Array.isArray(body.providers) ? body.providers : [];
    setStatus(
      providers.length
        ? `Connected. Models: ${providers.join(' → ')}`
        : 'Connected, but no LLM API keys are configured.',
      providers.length ? 'ok' : 'error',
    );
  } catch {
    setStatus('Could not reach the gateway. Is it running?', 'error');
  }
});

load();
