import { useMemo } from 'react';
import { useUi, useWs, updateNode, setSubTab } from '../store.js';
import { countRequests, effectiveAuth, findNode } from '../lib/model.js';
import * as A from '../actions.js';
import AuthEditor from './AuthEditor.jsx';
import ScriptEditor from './ScriptEditor.jsx';
import VariablesEditor from './VariablesEditor.jsx';
import { VarsProvider } from './vars.jsx';
import { IconCollection, IconFolder, IconMore, IconPlay } from './icons.jsx';

// Settings page for a collection or a folder. Edits save immediately.
export default function NodeView({ id }) {
  const ws = useWs((s) => s.ws);
  const found = useMemo(() => findNode(ws, id), [ws, id]);
  let tab = useUi((s) => s.subTabs.node);
  if (!found || found.node.type === 'request') return <div className="empty-view">This item no longer exists.</div>;
  const n = found.node;
  const isCol = n.type === 'collection';
  if (tab === 'variables' && !isCol) tab = 'overview';
  const upd = (fn) => updateNode(n.id, fn);
  const folders = (function count(x) {
    return x.items.reduce((c, it) => c + (it.type === 'folder' ? 1 + count(it) : 0), 0);
  })(n);

  const tabs = [
    ['overview', 'Overview'],
    ['auth', 'Authorization', n.auth.type !== (isCol ? 'noauth' : 'inherit')],
    ['pre', 'Pre-request', !!n.preRequest.trim()],
    ['tests', 'Tests', !!n.test.trim()],
    isCol && ['variables', `Variables${n.variables.length ? ` (${n.variables.length})` : ''}`],
  ].filter(Boolean);

  const more = (e) =>
    A.openMenu(
      e,
      [
        { label: 'Duplicate', onClick: () => A.duplicateNode(n.id) },
        isCol && { label: 'Export (Postman v2.1)', onClick: () => A.exportCollection(n.id) },
        { sep: true },
        { label: 'Delete', danger: true, onClick: () => A.deleteNode(n.id) },
      ].filter(Boolean),
    );

  return (
    <VarsProvider refId={n.id}>
      <div className="node-view">
        <div className="view-head">
          {isCol ? <IconCollection className="head-ico" /> : <IconFolder className="head-ico" />}
          <div className="crumbs">
            {found.chain.map((c) => (
              <span key={c.id}>{c.name} /</span>
            ))}
          </div>
          <input className="title-input" value={n.name} spellCheck={false} onChange={(e) => upd((x) => void (x.name = e.target.value))} />
          <button className="btn small" onClick={() => A.addRequest(n.id)}>
            Add request
          </button>
          <button className="btn small" onClick={() => A.addFolder(n.id)}>
            Add folder
          </button>
          <button className="btn small primary" onClick={() => A.openTab('runner', n.id, { preview: false })}>
            <IconPlay /> Run
          </button>
          <button className="icon-btn" title="More" onClick={more}>
            <IconMore />
          </button>
        </div>

        <div className="tabs">
          {tabs.map(([k, label, dot]) => (
            <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setSubTab('node', k)}>
              {label}
              {dot && <span className="dot" />}
            </button>
          ))}
        </div>

        <div className="node-body">
          {tab === 'overview' && (
            <div className="overview">
              <div className="stats">
                <div className="stat">
                  <b>{countRequests(n)}</b>
                  <span>requests</span>
                </div>
                <div className="stat">
                  <b>{folders}</b>
                  <span>folders</span>
                </div>
                {isCol && (
                  <div className="stat">
                    <b>{n.variables.length}</b>
                    <span>variables</span>
                  </div>
                )}
              </div>
              <label className="field">
                <span className="field-label">Description</span>
                <textarea
                  className="docs"
                  value={n.description || ''}
                  placeholder="What this collection covers, how to set up the environment, run order notes…"
                  onChange={(e) => upd((x) => void (x.description = e.target.value))}
                />
              </label>
              <p className="hint">Scripts and auth set here apply to every request inside. Pre-request scripts run collection → folder → request, and tests run in the same order.</p>
            </div>
          )}
          {tab === 'auth' && (
            <div className="pad">
              <AuthEditor auth={n.auth} allowInherit={!isCol} refId={n.id} inherited={effectiveAuth({ auth: { type: 'inherit' } }, found.chain)} onChange={(auth) => upd((x) => void (x.auth = auth))} />
            </div>
          )}
          {tab === 'pre' && <ScriptEditor kind="pre" value={n.preRequest} onChange={(v) => upd((x) => void (x.preRequest = v))} />}
          {tab === 'tests' && <ScriptEditor kind="test" value={n.test} onChange={(v) => upd((x) => void (x.test = v))} />}
          {tab === 'variables' && isCol && (
            <div className="pad">
              <p className="hint">
                Collection variables are available to every request as {'{{name}}'}. Environment variables with the same name take precedence. Scripts change the current value with{' '}
                <code>pm.collectionVariables.set()</code>.
              </p>
              <VariablesEditor rows={n.variables} onChange={(rows) => upd((x) => void (x.variables = rows))} />
            </div>
          )}
        </div>
      </div>
    </VarsProvider>
  );
}
