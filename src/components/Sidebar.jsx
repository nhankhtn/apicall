import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUi, useWs, setUi } from '../store.js';
import * as A from '../actions.js';
import { PROTOCOL_TAG, isHttp } from '../lib/model.js';
import { formatMs } from '../lib/util.js';
import { statusClass } from './ResponseView.jsx';
import { IconCaret, IconCollection, IconEnv, IconExample, IconFolder, IconGlobe, IconImport, IconMore, IconPlus, IconSearch } from './icons.jsx';

const SHORT = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' };

function RenameInput({ initial, onDone }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className="rename"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function nodeMenu(node) {
  const startRename = () => setUi({ renaming: node.id });
  if (node.type === 'request') {
    return [
      { label: 'Open in new tab', onClick: () => A.openTab('request', node.id, { preview: false }) },
      { label: 'Copy as cURL', onClick: () => A.copyAsCurl(node.id) },
      { label: 'Generate code snippet', onClick: () => setUi({ modal: { type: 'code', refId: node.id } }) },
      { label: 'Rename', onClick: startRename },
      { label: 'Duplicate', onClick: () => A.duplicateNode(node.id) },
      { sep: true },
      { label: 'Delete', danger: true, onClick: () => A.deleteNode(node.id) },
    ];
  }
  return [
    { label: `Run ${node.type}`, onClick: () => A.openTab('runner', node.id, { preview: false }) },
    { label: 'Add request', onClick: () => A.addRequest(node.id) },
    { label: 'Add folder', onClick: () => A.addFolder(node.id) },
    { sep: true },
    { label: 'Edit (auth, scripts, variables)', onClick: () => A.openTab('node', node.id, { preview: false }) },
    { label: 'Rename', onClick: startRename },
    { label: 'Duplicate', onClick: () => A.duplicateNode(node.id) },
    node.type === 'collection' && { label: 'Export (Postman v2.1)', onClick: () => A.exportCollection(node.id) },
    { sep: true },
    { label: 'Delete', danger: true, onClick: () => A.deleteNode(node.id) },
  ].filter(Boolean);
}

function Tree() {
  const ws = useWs((s) => s.ws);
  const { expanded, filter, renaming, activeTab, drafts } = useUi(
    useShallow((s) => ({ expanded: s.expanded, filter: s.filter, renaming: s.renaming, activeTab: s.activeTab, drafts: s.drafts })),
  );
  const [drop, setDrop] = useState(null); // { id, pos }
  const dragId = useRef(null);
  const activeRef = activeTab?.split(':').slice(1).join(':') || '';
  const f = filter.trim().toLowerCase();
  const state = useUi.getState();

  const selfMatch = (n) => !f || n.name.toLowerCase().includes(f) || (n.type === 'request' && n.url.toLowerCase().includes(f));
  const visible = (n) => selfMatch(n) || (n.items || []).some(visible);

  const onDragOver = (e, node) => {
    if (!dragId.current) return;
    const modes = A.dropModes(dragId.current, node.id);
    if (!modes.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    let pos;
    if (modes.length === 1) pos = modes[0];
    else if (modes.includes('into')) pos = frac < 0.25 ? 'before' : frac > 0.75 ? 'after' : 'into';
    else pos = frac < 0.5 ? 'before' : 'after';
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drop?.id !== node.id || drop?.pos !== pos) setDrop({ id: node.id, pos });
  };

  const rows = [];
  const walk = (node, depth, parentMatched) => {
    if (!parentMatched && !visible(node)) return;
    const isRequest = node.type === 'request';
    const examples = isRequest ? node.examples || [] : [];
    const container = !isRequest || examples.length > 0;
    const open = (!isRequest && !!f) || expanded.includes(node.id);
    const dropCls = drop?.id === node.id ? `drop-${drop.pos}` : '';
    const kind = isRequest ? 'request' : 'node';
    const dirty = isRequest && drafts[node.id] && A.isDirty(node.id, state);
    const method = isRequest ? (drafts[node.id]?.method ?? node.method) : null;
    rows.push(
      <div
        key={node.id}
        className={`tree-row ${activeRef === node.id ? 'active' : ''} ${dropCls}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={renaming !== node.id}
        tabIndex={0}
        onClick={() => {
          A.openTab(kind, node.id);
          if (!isRequest) A.expand(node.id);
        }}
        onDoubleClick={() => A.openTab(kind, node.id, { preview: false })}
        onKeyDown={(e) => {
          if (e.key === 'F2') setUi({ renaming: node.id });
          if (e.key === 'Delete') A.deleteNode(node.id);
          if (e.key === 'Enter') A.openTab(kind, node.id, { preview: false });
        }}
        onContextMenu={(e) => A.openMenu(e, nodeMenu(node))}
        onDragStart={(e) => {
          dragId.current = node.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', node.id);
        }}
        onDragEnd={() => {
          dragId.current = null;
          setDrop(null);
        }}
        onDragOver={(e) => onDragOver(e, node)}
        onDragLeave={() => drop?.id === node.id && setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId.current && drop) A.moveNode(dragId.current, drop.id, drop.pos);
          dragId.current = null;
          setDrop(null);
        }}
      >
        {container ? (
          <span
            className={`caret ${open ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              A.toggleExpand(node.id);
            }}
          >
            <IconCaret />
          </span>
        ) : (
          <span className="caret-spacer" />
        )}
        {isRequest ? (
          isHttp(node) ? (
            <span className={`method-tag m-${method}`}>{SHORT[method] || method}</span>
          ) : (
            <span className={`method-tag p-${node.protocol}`}>{PROTOCOL_TAG[node.protocol]}</span>
          )
        ) : node.type === 'folder' ? (
          <IconFolder className="node-ico" />
        ) : (
          <IconCollection className="node-ico" />
        )}
        {renaming === node.id ? (
          <RenameInput
            initial={node.name}
            onDone={(v) => {
              if (v != null) A.renameNode(node.id, v);
              setUi({ renaming: null });
            }}
          />
        ) : (
          <span className="name" title={node.name}>
            {drafts[node.id]?.name ?? node.name}
          </span>
        )}
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        {!isRequest && (
          <button
            className="row-btn"
            title={`Run ${node.type}`}
            onClick={(e) => {
              e.stopPropagation();
              A.openTab('runner', node.id, { preview: false });
            }}
          >
            ▶
          </button>
        )}
        <button className="row-btn" title="More" onClick={(e) => A.openMenu(e, nodeMenu(node))}>
          <IconMore />
        </button>
      </div>,
    );
    if (!open) return;
    if (isRequest) {
      for (const ex of examples) {
        const ref = `${node.id}/${ex.id}`;
        rows.push(
          <div
            key={ref}
            className={`tree-row example-row ${activeRef === ref ? 'active' : ''}`}
            style={{ paddingLeft: 6 + (depth + 1) * 14 + 16 }}
            onClick={() => A.openTab('example', ref)}
            onDoubleClick={() => A.openTab('example', ref, { preview: false })}
            onContextMenu={(e) => A.openMenu(e, [{ label: 'Delete example', danger: true, onClick: () => A.deleteExample(node.id, ex.id) }])}
          >
            <IconExample className="node-ico" />
            <span className="name">{ex.name}</span>
          </div>,
        );
      }
    } else node.items.forEach((c) => walk(c, depth + 1, parentMatched || (f && selfMatch(node))));
  };
  ws.collections.forEach((c) => walk(c, 0, false));

  if (!ws.collections.length) {
    return (
      <div className="tree-empty">
        <p>No collections yet.</p>
        <button className="btn small" onClick={() => A.createCollection()}>
          New collection
        </button>
        <button className="btn small ghost" onClick={() => setUi({ modal: { type: 'import' } })}>
          Import
        </button>
      </div>
    );
  }
  return <div className="tree">{rows.length ? rows : <p className="tree-empty">No matches.</p>}</div>;
}

function EnvList() {
  const envs = useWs((s) => s.ws.environments);
  const { envId, activeTab, filter } = useUi(useShallow((s) => ({ envId: s.envId, activeTab: s.activeTab, filter: s.filter })));
  const f = filter.trim().toLowerCase();
  const menu = (env) => [
    { label: env.id === envId ? 'Deactivate' : 'Set active', onClick: () => setUi({ envId: env.id === envId ? null : env.id }) },
    { label: 'Duplicate', onClick: () => A.duplicateEnvironment(env.id) },
    { label: 'Export', onClick: () => A.exportEnvironment(env.id) },
    { sep: true },
    { label: 'Delete', danger: true, onClick: () => A.deleteEnvironment(env.id) },
  ];
  return (
    <div className="env-list">
      <div className={`tree-row ${activeTab === 'globals:' ? 'active' : ''}`} onClick={() => A.openTab('globals', '')}>
        <IconGlobe className="node-ico" />
        <span className="name">Globals</span>
      </div>
      {envs
        .filter((e) => !f || e.name.toLowerCase().includes(f))
        .map((env) => (
          <div
            key={env.id}
            className={`tree-row ${activeTab === `env:${env.id}` ? 'active' : ''}`}
            onClick={() => A.openTab('env', env.id)}
            onDoubleClick={() => A.openTab('env', env.id, { preview: false })}
            onContextMenu={(e) => A.openMenu(e, menu(env))}
          >
            <IconEnv className="node-ico" />
            <span className="name">{env.name}</span>
            <button
              className={`env-check ${env.id === envId ? 'on' : ''}`}
              title={env.id === envId ? 'Active environment' : 'Set active'}
              onClick={(e) => {
                e.stopPropagation();
                setUi({ envId: env.id === envId ? null : env.id });
              }}
            >
              ✓
            </button>
            <button className="row-btn" title="More" onClick={(e) => A.openMenu(e, menu(env))}>
              <IconMore />
            </button>
          </div>
        ))}
      {!envs.length && <p className="tree-empty">No environments yet. Use + to create one.</p>}
    </div>
  );
}

const dayLabel = (t) => {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

function HistoryList() {
  const history = useUi((s) => s.history);
  const filter = useUi((s) => s.filter);
  const f = filter.trim().toLowerCase();
  const shown = history.filter((h) => !f || h.url.toLowerCase().includes(f) || h.name.toLowerCase().includes(f));
  if (!history.length) return <p className="tree-empty">Requests you send appear here.</p>;
  const rows = [];
  let lastDay = null;
  for (const h of shown) {
    const day = dayLabel(h.at);
    if (day !== lastDay) {
      rows.push(
        <div key={`d-${h.id}`} className="history-day">
          {day}
        </div>,
      );
      lastDay = day;
    }
    rows.push(
      <div
        key={h.id}
        className="tree-row history-row"
        title={`${h.method} ${h.url}\n${new Date(h.at).toLocaleString()}`}
        onClick={() => A.openHistoryEntry(h)}
        onContextMenu={(e) =>
          A.openMenu(e, [
            { label: 'Open in new tab', onClick: () => A.openHistoryEntry(h) },
            ...(h.refId ? [{ label: 'Go to saved request', onClick: () => A.openTab('request', h.refId, { preview: false }) }] : []),
            { sep: true },
            { label: 'Delete', danger: true, onClick: () => A.deleteHistoryEntry(h.id) },
          ])
        }
      >
        <span className={`method-tag m-${h.method}`}>{SHORT[h.method] || h.method}</span>
        <span className="name mono small">{h.url.replace(/^https?:\/\//, '')}</span>
        {h.response ? <span className={`hist-status ${statusClass(h.response.status)}`}>{h.response.status}</span> : <span className="hist-status s5">ERR</span>}
      </div>,
    );
  }
  return (
    <div className="history">
      {rows.length ? rows : <p className="tree-empty">No matches.</p>}
      <p className="hint small history-note">
        {history.length} request(s) · times are when they were sent{history[0]?.response ? `, last took ${formatMs(history[0].response.timeMs)}` : ''}
      </p>
    </div>
  );
}

const SIDE_TABS = [
  ['collections', 'Collections'],
  ['environments', 'Environments'],
  ['history', 'History'],
];

export default function Sidebar() {
  const filter = useUi((s) => s.filter);
  const width = useUi((s) => s.sidebarWidth);
  const tab = useUi((s) => s.sidebarTab);
  const historyCount = useUi((s) => s.history.length);
  const startResize = (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev) => setUi({ sidebarWidth: Math.max(220, Math.min(560, w0 + ev.clientX - x0)) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-h');
    };
    document.body.classList.add('resizing-h');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside className="sidebar glass" style={{ width }}>
      <div className="side-tabs">
        {SIDE_TABS.map(([k, label]) => (
          <button key={k} className={`side-tab ${tab === k ? 'on' : ''}`} onClick={() => setUi({ sidebarTab: k })}>
            {label}
          </button>
        ))}
      </div>
      <div className="side-section">
        <div className="side-actions">
          <label className="search">
            <IconSearch />
            <input value={filter} placeholder={tab === 'history' ? 'Filter history' : tab === 'environments' ? 'Filter environments' : 'Filter by name or URL'} onChange={(e) => setUi({ filter: e.target.value })} />
          </label>
          {tab === 'collections' && (
            <>
              <button className="icon-btn" title="Import" onClick={() => setUi({ modal: { type: 'import' } })}>
                <IconImport />
              </button>
              <button className="icon-btn" title="New collection" onClick={() => A.createCollection()}>
                <IconPlus />
              </button>
            </>
          )}
          {tab === 'environments' && (
            <button className="icon-btn" title="New environment" onClick={() => A.createEnvironment()}>
              <IconPlus />
            </button>
          )}
          {tab === 'history' && (
            <button className="link-btn" disabled={!historyCount} onClick={A.clearHistory}>
              Clear all
            </button>
          )}
        </div>
      </div>
      <div className="side-scroll">
        {tab === 'collections' && <Tree />}
        {tab === 'environments' && <EnvList />}
        {tab === 'history' && <HistoryList />}
      </div>
      <div className="splitter-v" onMouseDown={startResize} />
    </aside>
  );
}
