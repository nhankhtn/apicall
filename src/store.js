import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { findNode } from './lib/model.js';

// Persisted workspace: collections, environments, globals, cookies, settings. Updated through immer.
export const useWs = create(
  immer((set) => ({
    ws: null,
    mutate: (fn) =>
      set((s) => {
        fn(s.ws);
      }),
  })),
);

export const getWs = () => useWs.getState().ws;
export const mutate = (fn) => useWs.getState().mutate(fn);

export const updateNode = (id, fn) =>
  mutate((ws) => {
    const f = findNode(ws, id);
    if (f) fn(f.node, f);
  });

export const updateEnv = (id, fn) =>
  mutate((ws) => {
    const e = ws.environments.find((x) => x.id === id);
    if (e) fn(e);
  });

// ---------- UI / runtime state (browser only) ----------

const LS_PREFIX = 'apicall.';
export const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(LS_PREFIX + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(LS_PREFIX + k, JSON.stringify(v));
    } catch {
      /* storage unavailable: preferences just won't stick */
    }
  },
};

const PERSISTED_UI = ['envId', 'openTabs', 'activeTab', 'drafts', 'expanded', 'subTabs', 'editorHeight', 'sidebarWidth', 'sidebarTab', 'vault'];

// Tabs from before the tab bar existed were a single "view".
function initialTabs() {
  const tabs = LS.get('openTabs', null);
  if (tabs) return tabs;
  const view = LS.get('view', null);
  if (view?.id || view?.kind === 'globals') return [{ id: `${view.kind}:${view.id || ''}`, kind: view.kind, refId: view.id || '', preview: false }];
  return [];
}

export const useUi = create(() => {
  const openTabs = initialTabs();
  return {
    envId: LS.get('envId', null),
    // Tab: { id, kind: 'request'|'node'|'runner'|'env'|'globals'|'example', refId, preview }
    openTabs,
    activeTab: LS.get('activeTab', openTabs[0]?.id || null),
    // Unsaved request edits keyed by request id (or a tmp- id for requests not saved yet).
    drafts: LS.get('drafts', {}),
    expanded: LS.get('expanded', []),
    subTabs: { req: 'params', resp: 'body', node: 'overview', runner: 'functional', ...LS.get('subTabs', LS.get('tabs', {})) },
    editorHeight: LS.get('editorHeight', 280),
    sidebarWidth: LS.get('sidebarWidth', 300),
    sidebarTab: LS.get('sidebarTab', 'collections'),
    vault: LS.get('vault', []),
    filter: '',
    renaming: null,
    saveStatus: 'saved',
    saveError: null,
    modal: null,
    menu: null,
    toasts: [],
    history: [],
    responses: {}, // request id -> last single-send record
    sending: {}, // request id -> cancel()
    runsRev: 0,
    // index.html applies the saved theme before first paint; this mirrors it.
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  };
});

export const setUi = (patch) => useUi.setState(typeof patch === 'function' ? patch : () => patch);

let lsTimer = null;
const lsPending = new Set();
useUi.subscribe((s, prev) => {
  for (const k of PERSISTED_UI) if (s[k] !== prev[k]) lsPending.add(k);
  if (!lsPending.size || lsTimer) return;
  // Drafts change on every keystroke; batch the writes.
  lsTimer = setTimeout(() => {
    lsTimer = null;
    const st = useUi.getState();
    for (const k of lsPending) LS.set(k, st[k]);
    lsPending.clear();
  }, 250);
});
window.addEventListener('beforeunload', () => {
  const st = useUi.getState();
  for (const k of lsPending) LS.set(k, st[k]);
});

export function toggleTheme() {
  const next = useUi.getState().theme === 'dark' ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', next === 'dark');
  try {
    localStorage.setItem('apicall-theme', next);
  } catch {
    /* storage unavailable: the choice lasts for this tab only */
  }
  useUi.setState({ theme: next });
}

export const setSubTab = (group, tab) => setUi((s) => ({ subTabs: { ...s.subTabs, [group]: tab } }));
// Kept for components that still call it by its old name.
export const setTab = setSubTab;
