// Loads and autosaves the workspace in IndexedDB (this browser only). Tabs of the app in the
// same browser stay in sync through a BroadcastChannel. Data from the older server-side store
// (data/workspace.json) is copied in once, on first load.
import { useWs, getWs, setUi, useUi } from './store.js';
import { debounce, errMsg, uid } from './lib/util.js';
import { normalizeWorkspace } from './lib/model.js';
import * as db from './db.js';

const TAB_ID = uid();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('apicall') : null;
let applyingRemote = false;

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

// One-time copy of what the server stored before storage moved into the browser.
async function migrateFromServer() {
  const ws = await fetchJSON('/api/workspace');
  if (!ws || !Array.isArray(ws.collections)) return null;
  const history = (await fetchJSON('/api/history')) || [];
  for (const h of history) await db.historyAdd(h);
  const runs = (await fetchJSON('/api/runs')) || [];
  for (const r of runs) await db.runsPut(r);
  const fileIds = new Set();
  const walk = (n) => {
    if (n.type === 'request') {
      for (const f of n.body?.formdata || []) if (f.fileId) fileIds.add(f.fileId);
      if (n.body?.binary?.fileId) fileIds.add(n.body.binary.fileId);
    } else n.items?.forEach(walk);
  };
  ws.collections.forEach(walk);
  for (const id of fileIds) {
    try {
      const r = await fetch(`/api/files/${id}`);
      if (!r.ok) continue;
      const blob = await r.blob();
      const name = decodeURIComponent((r.headers.get('content-disposition') || '').match(/filename="([^"]*)"/)?.[1] || 'file');
      await db.filesPut({ id, name, type: blob.type, size: blob.size, blob });
    } catch {
      /* a missing attachment only means the user selects the file again */
    }
  }
  return ws;
}

export async function loadWorkspace() {
  let stored = await db.kvGet('workspace');
  if (!stored && !(await db.kvGet('migrated'))) {
    const fromServer = await migrateFromServer();
    await db.kvSet('migrated', true);
    if (fromServer) {
      stored = { ws: fromServer, rev: 1 };
      await db.kvSet('workspace', stored);
    }
  }
  const [drafts, vault, history] = await Promise.all([db.kvGet('drafts'), db.kvGet('vault'), db.historyList()]);
  lastRev = stored?.rev || 0;
  setUi({ drafts: drafts || {}, vault: vault || [], history });
  useWs.setState({ ws: normalizeWorkspace(stored?.ws || {}) });
  fetch('/api/capabilities')
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => c && setUi({ capabilities: c }))
    .catch(() => {});
  // Ask once to be exempt from eviction under disk pressure; the Settings screen shows the result.
  db.storageStatus({ request: true }).then((st) => setUi({ storage: st })).catch(() => {});
}

let lastRev = 0;

async function doSave() {
  setUi({ saveStatus: 'saving' });
  try {
    lastRev += 1;
    await db.kvSet('workspace', { ws: getWs(), rev: lastRev, by: TAB_ID, at: Date.now() });
    channel?.postMessage({ type: 'workspace', rev: lastRev, from: TAB_ID });
    if (useUi.getState().saveStatus === 'saving') setUi({ saveStatus: 'saved', saveError: null });
  } catch (e) {
    setUi({ saveStatus: 'error', saveError: errMsg(e) });
  }
}

let queue = Promise.resolve();
const schedule = debounce(() => {
  queue = queue.then(doSave);
}, 400);

export function saveNow() {
  schedule.flush();
  return queue;
}

useWs.subscribe((s, prev) => {
  if (!prev.ws || s.ws === prev.ws || applyingRemote) return;
  setUi({ saveStatus: 'pending' });
  schedule();
});

// Drafts and vault live in IndexedDB too, written shortly after they change.
const saveDrafts = debounce(() => db.kvSet('drafts', useUi.getState().drafts).catch(() => {}), 300);
const saveVault = debounce(() => db.kvSet('vault', useUi.getState().vault).catch(() => {}), 300);
useUi.subscribe((s, prev) => {
  if (s.drafts !== prev.drafts) saveDrafts();
  if (s.vault !== prev.vault) saveVault();
});

// Another tab saved: take its workspace unless this tab has an unsaved write queued.
channel?.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'workspace' || data.from === TAB_ID) return;
  if (useUi.getState().saveStatus === 'pending') return;
  const stored = await db.kvGet('workspace');
  if (!stored || stored.rev < lastRev) return;
  lastRev = stored.rev;
  applyingRemote = true;
  useWs.setState({ ws: normalizeWorkspace(stored.ws) });
  applyingRemote = false;
});

// Write pending edits before the page goes away (IndexedDB has no synchronous API).
const flushAll = () => {
  if (['pending', 'saving'].includes(useUi.getState().saveStatus)) saveNow();
  saveDrafts.flush();
  saveVault.flush();
};
window.addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAll());

export const storageInfo = () => db.storageStatus();
export const requestPersistence = async () => {
  const st = await db.storageStatus({ request: true });
  setUi({ storage: st });
  return st;
};
