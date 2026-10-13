// Workspace operations triggered from the UI.
import { produce } from 'immer';
import _ from 'lodash';
import { useUi, setUi, getWs, mutate } from './store.js';
import * as M from './lib/model.js';
import { toMap, writeBack, createVars, resolveRequest, toCurl, sameScope } from './lib/engine.js';
import { uid, clone, download, errMsg } from './lib/util.js';
import { executeInWorker, fetchTokenInWorker } from './engineClient.js';
import * as db from './db.js';
import { stopSession } from './realtime.js';

// ---------- UI helpers ----------

export function toast(text, kind = 'info', ms = 3500) {
  const id = uid();
  setUi((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => setUi((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function expand(id, open = true) {
  setUi((s) => {
    const has = s.expanded.includes(id);
    if (open === has) return {};
    return { expanded: open ? [...s.expanded, id] : s.expanded.filter((x) => x !== id) };
  });
}

export const toggleExpand = (id) => expand(id, !useUi.getState().expanded.includes(id));

export function openMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  setUi({ menu: { x: e.clientX, y: e.clientY, items } });
}

export const closeMenu = () => setUi({ menu: null });

export const currentEnv = () => getWs().environments.find((e) => e.id === useUi.getState().envId) || null;

// ---------- Requests and drafts ----------

export function savedRequest(refId) {
  const f = M.findNode(getWs(), refId);
  return f?.node.type === 'request' ? f.node : null;
}

export const getRequest = (refId, s = useUi.getState()) => s.drafts[refId] ?? savedRequest(refId);

// Compares what matters for saving: settings of protocols the request is not using (left over
// from trying another type) and remembered per-protocol URLs do not count as changes.
const PROTOCOL_KEYS = { websocket: 'ws', socketio: 'socketio', mqtt: 'mqtt', grpc: 'grpc' };
function comparable(r) {
  const keep = PROTOCOL_KEYS[r.protocol || 'http'];
  return _.omit(r, ['urlByProtocol', ...Object.values(PROTOCOL_KEYS).filter((k) => k !== keep)]);
}
const sameRequest = (a, b) => _.isEqual(comparable(a), comparable(b));

export function isDirty(refId, s = useUi.getState()) {
  const d = s.drafts[refId];
  if (!d) return false;
  if (d._tmp) return true;
  const saved = savedRequest(refId);
  return !saved || !sameRequest(d, saved);
}

// ---------- Tabs ----------

const tabKey = (kind, refId) => `${kind}:${refId}`;
const tabDirty = (s, t) => t.kind === 'request' && isDirty(t.refId, s);

// Like Postman: a single click opens a "preview" tab that the next click replaces,
// until it is edited or double-clicked.
export function openTab(kind, refId = '', { preview = true } = {}) {
  setUi((s) => {
    const id = tabKey(kind, refId);
    const existing = s.openTabs.find((t) => t.id === id);
    if (existing) {
      return {
        activeTab: id,
        menu: null,
        openTabs: preview ? s.openTabs : s.openTabs.map((t) => (t.id === id ? { ...t, preview: false } : t)),
      };
    }
    const tab = { id, kind, refId, preview };
    const tabs = [...s.openTabs];
    const previewAt = preview ? tabs.findIndex((t) => t.preview && !tabDirty(s, t)) : -1;
    if (previewAt >= 0) tabs[previewAt] = tab;
    else tabs.splice(tabs.findIndex((t) => t.id === s.activeTab) + 1, 0, tab);
    return { openTabs: tabs, activeTab: id, menu: null };
  });
}

export const openView = ({ kind, id }, opts) => openTab(kind, id ?? '', opts);

export const pinTab = (id) =>
  setUi((s) => (s.openTabs.some((t) => t.id === id && t.preview) ? { openTabs: s.openTabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) } : {}));

function dropTabs(ids) {
  // Connections stay open while their tab is merely hidden; closing the tab ends them.
  for (const t of useUi.getState().openTabs) if (ids.includes(t.id) && t.kind === 'request') stopSession(t.refId);
  setUi((s) => {
    const gone = new Set(ids);
    const tabs = s.openTabs.filter((t) => !gone.has(t.id));
    const drafts = { ...s.drafts };
    for (const t of s.openTabs) if (gone.has(t.id) && t.kind === 'request') delete drafts[t.refId];
    let active = s.activeTab;
    if (gone.has(active)) {
      const idx = s.openTabs.findIndex((t) => t.id === active);
      const after = s.openTabs.slice(idx + 1).find((t) => !gone.has(t.id));
      const before = s.openTabs.slice(0, idx).reverse().find((t) => !gone.has(t.id));
      active = (after || before)?.id || null;
    }
    return { openTabs: tabs, activeTab: active, drafts };
  });
}

// Closing tabs with unsaved changes asks first (Save / Don't save / Cancel).
export function closeTabs(ids, { force = false } = {}) {
  const s = useUi.getState();
  const dirty = s.openTabs.filter((t) => ids.includes(t.id) && tabDirty(s, t));
  if (dirty.length && !force) {
    setUi({ modal: { type: 'unsaved', tabIds: ids, dirtyIds: dirty.map((t) => t.id) } });
    return;
  }
  dropTabs(ids);
}

export const closeTab = (id) => closeTabs([id]);
export const closeOtherTabs = (id) => closeTabs(useUi.getState().openTabs.filter((t) => t.id !== id).map((t) => t.id));
export const closeAllTabs = () => closeTabs(useUi.getState().openTabs.map((t) => t.id));

export function moveTab(fromId, toId) {
  setUi((s) => {
    const tabs = [...s.openTabs];
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0 || from === to) return {};
    tabs.splice(to, 0, ...tabs.splice(from, 1));
    return { openTabs: tabs };
  });
}

function retargetTab(oldRefId, newRefId) {
  setUi((s) => {
    const oldId = tabKey('request', oldRefId);
    const newId = tabKey('request', newRefId);
    const responses = { ...s.responses, [newRefId]: s.responses[oldRefId] };
    delete responses[oldRefId];
    return {
      openTabs: s.openTabs.map((t) => (t.id === oldId ? { ...t, id: newId, refId: newRefId, preview: false } : t)),
      activeTab: s.activeTab === oldId ? newId : s.activeTab,
      responses,
    };
  });
}

// Edits a request through its draft; the tab stops being a preview once edited.
export function updateRequest(refId, fn) {
  setUi((s) => {
    const base = s.drafts[refId] ?? savedRequest(refId);
    if (!base) return {};
    const next = produce(base, fn);
    const saved = savedRequest(refId);
    const drafts = { ...s.drafts };
    if (saved && !next._tmp && sameRequest(next, saved)) delete drafts[refId];
    else drafts[refId] = next;
    const id = tabKey('request', refId);
    return { drafts, openTabs: s.openTabs.map((t) => (t.id === id && t.preview ? { ...t, preview: false } : t)) };
  });
}

export function newRequestTab(seed) {
  const id = `tmp-${uid()}`;
  const req = { ...M.newRequest('Untitled Request', seed?.protocol || 'http'), ...(seed ? clone(seed) : {}), id, _tmp: true };
  M.normalizeRequest(req);
  setUi((s) => ({ drafts: { ...s.drafts, [id]: req } }));
  openTab('request', id, { preview: false });
  return id;
}

// Returns true when saved, false when a "Save As" dialog was opened instead.
export function saveRequest(refId) {
  const d = useUi.getState().drafts[refId];
  if (!d) return true;
  if (d._tmp || !savedRequest(refId)) {
    setUi({ modal: { type: 'saveAs', refId } });
    return false;
  }
  mutate((ws) => {
    const f = M.findNode(ws, refId);
    const list = f.parent.items;
    list[list.findIndex((x) => x.id === refId)] = clone(d);
  });
  setUi((s) => {
    const drafts = { ...s.drafts };
    delete drafts[refId];
    return { drafts };
  });
  return true;
}

// Saves the current state of a request as a new request in `parentId` (collection or folder).
export function saveRequestAs(refId, { name, parentId }) {
  const base = getRequest(refId);
  if (!base) return;
  const { _tmp, ...rest } = clone(base);
  const node = { ...rest, id: uid(), name: name.trim() || base.name };
  mutate((ws) => void M.findNode(ws, parentId)?.node.items.push(node));
  expand(parentId);
  setUi((s) => {
    const drafts = { ...s.drafts };
    delete drafts[refId];
    return { drafts };
  });
  retargetTab(refId, node.id);
}

export function saveActiveTab() {
  const s = useUi.getState();
  const tab = s.openTabs.find((t) => t.id === s.activeTab);
  if (tab?.kind === 'request') return saveRequest(tab.refId);
  return true;
}

export const revertRequest = (refId) =>
  setUi((s) => {
    const drafts = { ...s.drafts };
    delete drafts[refId];
    return { drafts };
  });

// ---------- Tree operations ----------

const siblingsOf = (ws, f) => (f.parent ? f.parent.items : ws.collections);

export function createCollection(name = 'New Collection') {
  const c = M.newCollection(name);
  mutate((ws) => void ws.collections.push(c));
  openTab('node', c.id, { preview: false });
  setUi({ renaming: c.id });
  return c;
}

function addChild(parentId, node) {
  mutate((ws) => void M.findNode(ws, parentId)?.node.items.push(node));
  expand(parentId);
  setUi({ renaming: node.id });
}

export function addRequest(parentId) {
  const r = M.newRequest();
  addChild(parentId, r);
  openTab('request', r.id, { preview: false });
}

export function addFolder(parentId) {
  const f = M.newFolder();
  addChild(parentId, f);
  openTab('node', f.id, { preview: false });
}

export function renameNode(id, name) {
  name = name.trim();
  if (!name) return;
  mutate((ws) => {
    const f = M.findNode(ws, id);
    if (f) f.node.name = name;
    const env = ws.environments.find((x) => x.id === id);
    if (env) env.name = name;
  });
  setUi((s) => (s.drafts[id] ? { drafts: { ...s.drafts, [id]: { ...s.drafts[id], name } } } : {}));
}

export function duplicateNode(id) {
  const f = M.findNode(getWs(), id);
  if (!f) return;
  const copy = M.cloneWithNewIds(getRequest(id) || f.node);
  copy.name = `${f.node.name} Copy`;
  mutate((ws) => {
    const g = M.findNode(ws, id);
    const list = siblingsOf(ws, g);
    list.splice(list.findIndex((x) => x.id === id) + 1, 0, copy);
  });
  openTab(copy.type === 'request' ? 'request' : 'node', copy.id, { preview: false });
}

function idsWithin(node) {
  const ids = [node.id];
  node.items?.forEach((c) => ids.push(...idsWithin(c)));
  return ids;
}

export function deleteNode(id) {
  const f = M.findNode(getWs(), id);
  if (!f) return;
  const n = f.node;
  const extra = n.type === 'request' ? '' : ` It contains ${M.countRequests(n)} request(s).`;
  if (!window.confirm(`Delete ${n.type} "${n.name}"?${extra}`)) return;
  const gone = new Set(idsWithin(n));
  mutate((ws) => {
    const g = M.findNode(ws, id);
    const list = siblingsOf(ws, g);
    list.splice(list.findIndex((x) => x.id === id), 1);
  });
  const s = useUi.getState();
  dropTabs(s.openTabs.filter((t) => gone.has(t.refId) || gone.has(t.refId.split('/')[0])).map((t) => t.id));
}

// Where a dragged node may land relative to a target row.
export function dropModes(dragId, targetId) {
  const ws = getWs();
  const src = M.findNode(ws, dragId);
  const dst = M.findNode(ws, targetId);
  if (!src || !dst || dragId === targetId || M.isDescendant(src.node, targetId)) return [];
  if (src.node.type === 'collection') return dst.node.type === 'collection' ? ['before', 'after'] : [];
  if (dst.node.type === 'collection') return ['into'];
  if (dst.node.type === 'folder') return ['before', 'into', 'after'];
  return ['before', 'after'];
}

export function moveNode(dragId, targetId, pos) {
  if (!dropModes(dragId, targetId).includes(pos)) return;
  mutate((ws) => {
    const src = M.findNode(ws, dragId);
    const srcList = siblingsOf(ws, src);
    const [node] = srcList.splice(srcList.findIndex((x) => x.id === dragId), 1);
    const dst = M.findNode(ws, targetId);
    if (pos === 'into') dst.node.items.push(node);
    else {
      const list = siblingsOf(ws, dst);
      const i = list.findIndex((x) => x.id === targetId);
      list.splice(pos === 'before' ? i : i + 1, 0, node);
    }
  });
  if (pos === 'into') expand(targetId);
}

// ---------- Environments and variables ----------

export function createEnvironment(name = 'New Environment') {
  const env = M.newEnvironment(name);
  mutate((ws) => void ws.environments.push(env));
  openTab('env', env.id, { preview: false });
  return env;
}

export function duplicateEnvironment(id) {
  const env = getWs().environments.find((e) => e.id === id);
  if (!env) return;
  const copy = { ...structuredClone(env), id: uid(), name: `${env.name} Copy` };
  mutate((ws) => void ws.environments.push(copy));
  openTab('env', copy.id, { preview: false });
}

export function deleteEnvironment(id) {
  const env = getWs().environments.find((e) => e.id === id);
  if (!env || !window.confirm(`Delete environment "${env.name}"?`)) return;
  mutate((ws) => {
    ws.environments = ws.environments.filter((e) => e.id !== id);
  });
  if (useUi.getState().envId === id) setUi({ envId: null });
  dropTabs([tabKey('env', id)]);
}

// "Persist all": current values become the initial (shared/exported) values.
export const persistAllValues = (list) => list.map(({ current, ...v }) => (current === undefined ? v : { ...v, value: current }));
// "Reset all": drop local current values so the initial values apply again.
export const resetAllValues = (list) => list.map(({ current, ...v }) => v);

export const vaultMap = () => new Map(useUi.getState().vault.filter((v) => v.key).map((v) => [v.key, v.value]));

// ---------- Import / export ----------

const fileSafe = (s) => s.replace(/[\\/:*?"<>|]+/g, '_');

export function exportCollection(id) {
  const col = getWs().collections.find((c) => c.id === id);
  if (col) download(`${fileSafe(col.name)}.postman_collection.json`, JSON.stringify(M.exportPostmanCollection(col), null, 2));
}

export function exportEnvironment(id) {
  const env = getWs().environments.find((e) => e.id === id);
  if (env) download(`${fileSafe(env.name)}.postman_environment.json`, JSON.stringify(M.exportPostmanEnvironment(env), null, 2));
}

// Backup of everything in this browser's workspace, attachments included (base64).
export async function exportWorkspace() {
  const files = await Promise.all((await db.filesAll()).map(async (f) => ({ id: f.id, name: f.name, type: f.type, data: await db.blobToBase64(f.blob) })));
  download(`apicall-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ ...getWs(), files }, null, 2));
}

// Accepts a Postman collection/environment, a workspace backup, or a cURL command.
// Returns a human-readable summary; throws when nothing could be imported.
export function importText(text, { curlTarget } = {}) {
  const t = text.trim();
  if (!t) throw new Error('Nothing to import');

  if (/^curl\s/i.test(t)) {
    const req = M.parseCurl(t);
    if (curlTarget && M.findNode(getWs(), curlTarget)) {
      mutate((ws) => void M.findNode(ws, curlTarget).node.items.push(req));
      expand(curlTarget);
      openTab('request', req.id, { preview: false });
    } else newRequestTab(req);
    return `Imported request "${req.name}"`;
  }

  let json;
  try {
    json = JSON.parse(t);
  } catch (e) {
    throw new Error(`Not valid JSON or a cURL command (${e.message})`);
  }
  const docs = Array.isArray(json) ? json : [json];
  const cols = [];
  const envs = [];
  for (const d of docs) {
    if (d?.info && Array.isArray(d.item)) cols.push(M.importPostmanCollection(d));
    else if (d?.name && Array.isArray(d.values)) envs.push(M.importPostmanEnvironment(d));
    else if (Array.isArray(d?.collections) && Array.isArray(d?.environments)) {
      // Workspace backup: give everything fresh ids so it can sit next to the originals.
      const backup = M.normalizeWorkspace(d);
      for (const f of d.files || []) db.filesPut({ id: f.id, name: f.name, type: f.type, size: 0, blob: db.base64ToBlob(f.data, f.type) }).catch(() => {});
      cols.push(...backup.collections.map(M.cloneWithNewIds));
      envs.push(...backup.environments.map((e) => ({ ...e, id: uid() })));
      if (backup.globals.length) {
        mutate((ws) => {
          for (const g of backup.globals) if (!ws.globals.some((x) => x.key === g.key)) ws.globals.push(g);
        });
      }
    } else if (d?.requests && d?.order) {
      throw new Error('Postman Collection v1 is not supported. Re-export it from Postman as Collection v2.1.');
    } else {
      throw new Error('Unrecognized JSON: expected a Postman collection (v2.x), environment, or workspace backup');
    }
  }
  mutate((ws) => {
    ws.collections.push(...cols);
    ws.environments.push(...envs);
  });
  cols.forEach((c) => expand(c.id));
  if (cols.length === 1) openTab('node', cols[0].id, { preview: false });
  const parts = [];
  if (cols.length) parts.push(`${cols.length} collection(s)`);
  if (envs.length) parts.push(`${envs.length} environment(s)`);
  return `Imported ${parts.join(' and ')}`;
}

// ---------- Sending ----------

export function scopesFor(collection, env) {
  return {
    environment: toMap(env?.values),
    collection: toMap(collection?.variables),
    globals: toMap(getWs().globals),
  };
}

// Variable rows per scope for the editor's highlighting/autocomplete.
export function varSources(refId) {
  const ws = getWs();
  const f = refId ? M.findNode(ws, refId) : null;
  const env = currentEnv();
  return {
    environment: env?.values || [],
    collection: f?.collection?.variables || [],
    globals: ws.globals,
    vault: vaultMap(),
    envName: env?.name || null,
  };
}

// Saves variable, cookie and vault changes that a worker job made.
export function applyJobState(envId, collectionId, result) {
  const ws = getWs();
  const env = ws.environments.find((e) => e.id === envId);
  const col = ws.collections.find((c) => c.id === collectionId);
  const s = result.scopes;
  const varsDirty = s && ((env && !sameScope(env.values, s.environment)) || (col && !sameScope(col.variables, s.collection)) || !sameScope(ws.globals, s.globals));
  const cookiesDirty = result.cookies && !_.isEqual(result.cookies, ws.cookies);
  if (varsDirty || cookiesDirty) {
    mutate((d) => {
      if (varsDirty) {
        const e = d.environments.find((x) => x.id === envId);
        if (e) writeBack(e.values, s.environment);
        const c = d.collections.find((x) => x.id === collectionId);
        if (c) writeBack(c.variables, s.collection);
        writeBack(d.globals, s.globals);
      }
      if (cookiesDirty) d.cookies = result.cookies;
    });
  }
  if (result.vault) {
    const next = [...result.vault].map(([key, value]) => ({ key, value }));
    if (!_.isEqual(next, useUi.getState().vault.filter((v) => v.key))) setUi({ vault: next });
  }
}

const HISTORY_LIMIT = 1000;

function addHistory(item, rec) {
  const { examples, _tmp, ...request } = clone(item);
  const entry = {
    id: uid(),
    at: Date.now(),
    refId: _tmp ? null : item.id,
    name: item.name,
    method: rec.request?.method || item.method,
    url: rec.request?.url || item.url,
    request,
    response: rec.response ? { status: rec.response.status, statusText: rec.response.statusText, timeMs: rec.response.timeMs, size: rec.response.size } : null,
    error: rec.error || null,
  };
  setUi((s) => ({ history: [entry, ...s.history].slice(0, HISTORY_LIMIT) }));
  db.historyAdd(entry).catch((e) => toast(`Cannot save history: ${errMsg(e)}`, 'error'));
}

export function openHistoryEntry(entry) {
  newRequestTab({ ...entry.request, name: entry.name });
}

export function deleteHistoryEntry(id) {
  setUi((s) => ({ history: s.history.filter((h) => h.id !== id) }));
  db.historyDelete(id).catch(() => {});
}

export function clearHistory() {
  if (!window.confirm('Clear all request history?')) return;
  setUi({ history: [] });
  db.historyClear().catch(() => {});
}

export function jobContext() {
  const ws = getWs();
  return { settings: ws.settings, jar: { cookies: ws.cookies }, vault: vaultMap() };
}

export async function sendRequest(refId) {
  const ui = useUi.getState();
  if (ui.sending[refId]) return;
  const item = getRequest(refId);
  if (!item) return;
  const f = M.findNode(getWs(), refId);
  const env = currentEnv();
  const collection = f?.collection || null;
  const job = executeInWorker({
    item,
    chain: f?.chain || [],
    scopes: scopesFor(collection, env),
    info: { iteration: 0, iterationCount: 1, requestName: item.name, requestId: refId, environmentName: env?.name },
    ctx: jobContext(),
  });
  setUi((s) => ({ sending: { ...s.sending, [refId]: job.cancel } }));
  let rec;
  try {
    const result = await job.promise;
    rec = result.record;
    applyJobState(env?.id, collection?.id, result);
  } catch (e) {
    rec = { id: uid(), error: errMsg(e), tests: [], logs: [], scriptErrors: [], warnings: [], failed: true };
  } finally {
    setUi((s) => {
      const { [refId]: _drop, ...rest } = s.sending;
      return { sending: rest };
    });
  }
  setUi((s) => ({ responses: { ...s.responses, [refId]: rec } }));
  addHistory(item, rec);
}

export const cancelRequest = (refId) => useUi.getState().sending[refId]?.();

// The fully resolved request (current environment, no scripts) for cURL / code snippets.
export async function resolvedSpec(refId) {
  const item = getRequest(refId);
  const f = M.findNode(getWs(), refId);
  const vars = createVars({ ...scopesFor(f?.collection, currentEnv()), local: new Map(), data: new Map(), vault: vaultMap() });
  return resolveRequest(item, f?.chain || [], vars, { settings: getWs().settings, cookies: getWs().cookies });
}

export async function copyAsCurl(refId) {
  try {
    await navigator.clipboard.writeText(toCurl(await resolvedSpec(refId)));
    toast('cURL copied to clipboard', 'success');
  } catch (e) {
    toast(`Cannot copy: ${errMsg(e)}`, 'error');
  }
}

// Replaces a request's method, URL, headers, body and auth with a parsed cURL command
// (what Postman does when a cURL command is pasted into the URL bar).
export function applyCurl(refId, text) {
  let parsed;
  try {
    parsed = M.parseCurl(text.trim());
  } catch (e) {
    toast(`Cannot parse cURL: ${errMsg(e)}`, 'error');
    return false;
  }
  updateRequest(refId, (n) => {
    n.method = parsed.method;
    n.url = parsed.url;
    n.headers = parsed.headers;
    n.body = parsed.body;
    n.disabledQuery = [];
    n.pathVars = [];
    if (parsed.auth.type !== 'inherit') n.auth = parsed.auth;
    if (!n.name || n.name === 'New Request' || n.name === 'Untitled Request') n.name = parsed.name;
  });
  toast(`Imported cURL: ${parsed.method} with ${parsed.headers.length} header(s)`, 'success');
  return true;
}

// ---------- OAuth 2.0 ----------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export const oauthRedirectUri = () => `${location.origin}/oauth/callback`;

// Authorization-code flow: open the provider's login page and wait for /oauth/callback.
function authorizeInPopup(o, R) {
  return new Promise((resolve, reject) => {
    (async () => {
      const state = uid();
      const pkce = o.usePkce ? await pkcePair() : null;
      const url = new URL(R(o.authUrl));
      const redirectUri = R(o.redirectUri) || oauthRedirectUri();
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', R(o.clientId));
      url.searchParams.set('redirect_uri', redirectUri);
      if (o.scope) url.searchParams.set('scope', R(o.scope));
      url.searchParams.set('state', state);
      if (pkce) {
        url.searchParams.set('code_challenge', pkce.challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      const popup = window.open(url.toString(), 'apicall-oauth', 'width=520,height=720');
      if (!popup) throw new Error('The browser blocked the login popup');
      const onMsg = (e) => {
        if (e.origin !== location.origin || e.data?.type !== 'apicall-oauth' || e.data.state !== state) return;
        window.removeEventListener('message', onMsg);
        clearInterval(closed);
        if (e.data.error) reject(new Error(`Authorization failed: ${e.data.error}`));
        else resolve({ code: e.data.code, redirectUri, codeVerifier: pkce?.verifier });
      };
      const closed = setInterval(() => {
        if (popup.closed) {
          clearInterval(closed);
          window.removeEventListener('message', onMsg);
          reject(new Error('The login window was closed'));
        }
      }, 500);
      window.addEventListener('message', onMsg);
    })().catch(reject);
  });
}

// Fetches a token for an OAuth 2.0 auth config. `refId` gives the variable context.
export async function getOAuth2Token(oauth2, refId) {
  const f = refId ? M.findNode(getWs(), refId) : null;
  const scopes = scopesFor(f?.collection, currentEnv());
  const vars = createVars({ ...scopes, local: new Map(), data: new Map(), vault: vaultMap() });
  let cfg = oauth2;
  if (oauth2.grantType === 'authorization_code') {
    const { code, redirectUri, codeVerifier } = await authorizeInPopup(oauth2, (s) => vars.replaceIn(s ?? ''));
    cfg = { ...oauth2, code, redirectUri, codeVerifier };
  }
  return fetchTokenInWorker({ oauth2: cfg, scopes, vault: vaultMap(), settings: getWs().settings });
}

// ---------- Examples ----------

export function saveExample(refId, rec, name) {
  if (!rec?.response) return;
  const item = getRequest(refId);
  const example = {
    id: uid(),
    name: name || `${rec.response.status} ${rec.response.statusText || ''}`.trim(),
    request: { method: item.method, url: item.url, headers: clone(item.headers), body: clone(item.body) },
    response: {
      status: rec.response.status,
      statusText: rec.response.statusText,
      headers: rec.response.headers,
      body: rec.response.encoding === 'base64' ? '' : rec.response.body,
      encoding: 'utf8',
    },
  };
  if (savedRequest(refId)) {
    updateNodeExamples(refId, (list) => [...list, example]);
    expand(refId);
    openTab('example', `${refId}/${example.id}`, { preview: false });
  } else updateRequest(refId, (n) => void n.examples.push(example));
  toast(`Saved example "${example.name}"`, 'success');
}

// Examples are saved immediately (also into an open draft) as in Postman.
export function updateNodeExamples(refId, fn) {
  mutate((ws) => {
    const f = M.findNode(ws, refId);
    if (f) f.node.examples = fn(f.node.examples || []);
  });
  setUi((s) => (s.drafts[refId] ? { drafts: { ...s.drafts, [refId]: { ...s.drafts[refId], examples: fn(s.drafts[refId].examples || []) } } } : {}));
}

export function deleteExample(refId, exampleId) {
  updateNodeExamples(refId, (list) => list.filter((e) => e.id !== exampleId));
  dropTabs([tabKey('example', `${refId}/${exampleId}`)]);
}

// ---------- Files ----------

// Attachments are kept in this browser (IndexedDB) and sent inline with the request.
export async function uploadFile(file) {
  const meta = { id: uid(), name: file.name, type: file.type || 'application/octet-stream', size: file.size };
  await db.filesPut({ ...meta, blob: file });
  return meta;
}

// {{variable}} resolver for a request (active environment, its collection, globals, vault).
export function varsFor(refId) {
  const f = M.findNode(getWs(), refId);
  return createVars({ ...scopesFor(f?.collection, currentEnv()), local: new Map(), data: new Map(), vault: vaultMap() });
}
