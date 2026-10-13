// Loads the workspace from the server and autosaves every change (debounced, serialized).
import { useWs, getWs, setUi, useUi } from './store.js';
import { debounce, errMsg } from './lib/util.js';
import { normalizeWorkspace } from './lib/model.js';

export async function loadWorkspace() {
  const r = await fetch('/api/workspace');
  if (!r.ok) throw new Error(`GET /api/workspace: HTTP ${r.status}`);
  useWs.setState({ ws: normalizeWorkspace(await r.json()) });
  loadHistory();
}

export async function loadHistory() {
  try {
    const r = await fetch('/api/history');
    if (r.ok) setUi({ history: await r.json() });
  } catch {
    /* history is optional; the sidebar shows it empty */
  }
}

let queue = Promise.resolve();

async function doSave() {
  setUi({ saveStatus: 'saving' });
  try {
    const r = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(getWs()),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    // Another edit may have landed while this request was in flight.
    if (useUi.getState().saveStatus === 'saving') setUi({ saveStatus: 'saved', saveError: null });
  } catch (e) {
    setUi({ saveStatus: 'error', saveError: errMsg(e) });
  }
}

const schedule = debounce(() => {
  queue = queue.then(doSave);
}, 400);

export function saveNow() {
  schedule.flush();
  return queue;
}

useWs.subscribe((s, prev) => {
  if (!prev.ws || s.ws === prev.ws) return;
  setUi({ saveStatus: 'pending' });
  schedule();
});

window.addEventListener('beforeunload', () => {
  const { saveStatus } = useUi.getState();
  if (saveStatus === 'pending' || saveStatus === 'saving') {
    navigator.sendBeacon('/api/workspace', new Blob([JSON.stringify(getWs())], { type: 'application/json' }));
  }
});
