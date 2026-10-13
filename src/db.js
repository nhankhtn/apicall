// IndexedDB storage, per browser profile and origin. Used by the page and by the engine worker.
//   kv       workspace, drafts, vault, flags
//   history  sent requests (newest kept)
//   runs     collection-run and load-test summaries
//   files    attachments for form-data / binary bodies, as Blobs
const DB_NAME = 'apicall';
const DB_VERSION = 1;
const HISTORY_LIMIT = 1000;
const RUNS_PER_TARGET = 50;

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('history', { keyPath: 'id' }).createIndex('at', 'at');
      db.createObjectStore('runs', { keyPath: 'id' }).createIndex('targetId', 'targetId');
      db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: let it, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab of this app; close it and reload'));
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Runs fn(store) in one transaction and resolves when it commits.
async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let result;
    Promise.resolve(fn(tx.objectStore(name))).then((v) => (result = v), reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

// ---------- kv ----------

export const kvGet = (key) => withStore('kv', 'readonly', (s) => done(s.get(key)));
export const kvSet = (key, value) => withStore('kv', 'readwrite', (s) => done(s.put(value, key)));

// ---------- history ----------

export async function historyList() {
  const all = await withStore('history', 'readonly', (s) => done(s.getAll()));
  return all.sort((a, b) => b.at - a.at);
}

export function historyAdd(entry) {
  return withStore('history', 'readwrite', async (s) => {
    await done(s.put(entry));
    const count = await done(s.count());
    if (count <= HISTORY_LIMIT) return;
    // Drop the oldest entries beyond the limit.
    let extra = count - HISTORY_LIMIT;
    await new Promise((resolve, reject) => {
      const cur = s.index('at').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || extra-- <= 0) return resolve();
        c.delete();
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  });
}

export const historyDelete = (id) => withStore('history', 'readwrite', (s) => done(s.delete(id)));
export const historyClear = () => withStore('history', 'readwrite', (s) => done(s.clear()));

// ---------- runs ----------

export async function runsList(targetId) {
  const list = await withStore('runs', 'readonly', (s) => done(s.index('targetId').getAll(targetId)));
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export const runsGet = (id) => withStore('runs', 'readonly', (s) => done(s.get(id)));

export function runsPut(run) {
  return withStore('runs', 'readwrite', async (s) => {
    await done(s.put(run));
    const mine = (await done(s.index('targetId').getAll(run.targetId))).sort((a, b) => b.startedAt - a.startedAt);
    for (const old of mine.slice(RUNS_PER_TARGET)) await done(s.delete(old.id));
  });
}

export const runsDelete = (id) => withStore('runs', 'readwrite', (s) => done(s.delete(id)));

// ---------- files ----------

// file: { id, name, type, size, blob }
export const filesPut = (file) => withStore('files', 'readwrite', (s) => done(s.put(file)));
export const filesGet = (id) => withStore('files', 'readonly', (s) => done(s.get(id)));
export const filesAll = () => withStore('files', 'readonly', (s) => done(s.getAll()));

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

// ---------- storage durability ----------

// Asks the browser not to evict this origin's data under storage pressure.
export async function storageStatus({ request = false } = {}) {
  const sm = globalThis.navigator?.storage;
  if (!sm) return { supported: false };
  let persisted = (await sm.persisted?.()) ?? false;
  if (!persisted && request) persisted = (await sm.persist?.()) ?? false;
  const est = (await sm.estimate?.()) || {};
  return { supported: true, persisted, usage: est.usage ?? null, quota: est.quota ?? null };
}
