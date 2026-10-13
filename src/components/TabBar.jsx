import { useRef } from 'react';
import { useUi, useWs, setUi } from '../store.js';
import { findNode, isHttp, PROTOCOL_TAG } from '../lib/model.js';
import * as A from '../actions.js';
import { IconCollection, IconEnv, IconExample, IconFolder, IconGlobe, IconPlay, IconPlus, IconX } from './icons.jsx';

const SHORT = { DELETE: 'DEL', OPTIONS: 'OPT' };

function tabInfo(tab, ws, drafts) {
  if (tab.kind === 'request') {
    const r = drafts[tab.refId] || findNode(ws, tab.refId)?.node;
    if (!r) return { title: 'Deleted request', missing: true };
    return isHttp(r) ? { title: r.name, method: r.method } : { title: r.name, tag: PROTOCOL_TAG[r.protocol], protocol: r.protocol };
  }
  if (tab.kind === 'example') {
    const [reqId, exId] = tab.refId.split('/');
    const r = findNode(ws, reqId)?.node;
    const ex = r?.examples?.find((e) => e.id === exId);
    return ex ? { title: ex.name, icon: IconExample } : { title: 'Deleted example', missing: true };
  }
  if (tab.kind === 'env') {
    const env = ws.environments.find((e) => e.id === tab.refId);
    return env ? { title: env.name, icon: IconEnv } : { title: 'Deleted environment', missing: true };
  }
  if (tab.kind === 'globals') return { title: 'Globals', icon: IconGlobe };
  const n = findNode(ws, tab.refId)?.node;
  if (!n) return { title: 'Deleted', missing: true };
  if (tab.kind === 'runner') return { title: `Runner · ${n.name}`, icon: IconPlay };
  return { title: n.name, icon: n.type === 'folder' ? IconFolder : IconCollection };
}

export default function TabBar() {
  const ws = useWs((s) => s.ws);
  const tabs = useUi((s) => s.openTabs);
  const active = useUi((s) => s.activeTab);
  const drafts = useUi((s) => s.drafts);
  const state = useUi.getState();
  const dragId = useRef(null);

  const menu = (e, tab) =>
    A.openMenu(e, [
      { label: 'Close', onClick: () => A.closeTab(tab.id) },
      { label: 'Close other tabs', onClick: () => A.closeOtherTabs(tab.id) },
      { label: 'Close all tabs', onClick: () => A.closeAllTabs() },
      ...(tab.kind === 'request' ? [{ sep: true }, { label: 'Duplicate tab', onClick: () => A.newRequestTab({ ...A.getRequest(tab.refId), name: `${A.getRequest(tab.refId)?.name} Copy` }) }] : []),
    ]);

  return (
    <div className="tabbar">
      <div className="tabbar-scroll">
        {tabs.map((tab) => {
          const info = tabInfo(tab, ws, drafts);
          const dirty = tab.kind === 'request' && A.isDirty(tab.refId, state);
          const Icon = info.icon;
          return (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === active ? 'active' : ''} ${tab.preview ? 'preview' : ''} ${info.missing ? 'missing' : ''}`}
              title={info.title}
              draggable
              onClick={() => setUi({ activeTab: tab.id })}
              onDoubleClick={() => A.pinTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  A.closeTab(tab.id);
                }
              }}
              onContextMenu={(e) => menu(e, tab)}
              onDragStart={(e) => {
                dragId.current = tab.id;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => dragId.current && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId.current) A.moveTab(dragId.current, tab.id);
                dragId.current = null;
              }}
            >
              {info.method ? (
                <span className={`method-tag m-${info.method}`}>{SHORT[info.method] || info.method}</span>
              ) : info.tag ? (
                <span className={`method-tag p-${info.protocol}`}>{info.tag}</span>
              ) : Icon ? (
                <Icon className="tab-ico" />
              ) : null}
              <span className="tab-title">{info.title}</span>
              {dirty && <span className="dirty-dot" />}
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  A.closeTab(tab.id);
                }}
              >
                <IconX />
              </button>
            </div>
          );
        })}
      </div>
      <button className="icon-btn tab-new" title="New request" onClick={() => A.newRequestTab()}>
        <IconPlus />
      </button>
    </div>
  );
}
