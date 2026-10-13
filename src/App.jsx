import { useEffect, useState } from 'react';
import { useUi, useWs, setUi } from './store.js';
import { loadWorkspace, saveNow } from './persist.js';
import { errMsg } from './lib/util.js';
import * as A from './actions.js';
import Topbar from './components/Topbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import RequestView from './components/RequestView.jsx';
import ExampleView from './components/ExampleView.jsx';
import NodeView from './components/NodeView.jsx';
import RunnerView from './components/RunnerView.jsx';
import { EnvView, GlobalsView } from './components/EnvView.jsx';
import Welcome from './components/Welcome.jsx';
import { ContextMenu, Modals, Toasts } from './components/Overlays.jsx';

function MainView() {
  const tab = useUi((s) => s.openTabs.find((t) => t.id === s.activeTab));
  if (!tab) return <Welcome />;
  switch (tab.kind) {
    case 'request':
      return <RequestView key={tab.refId} refId={tab.refId} />;
    case 'example':
      return <ExampleView key={tab.refId} refId={tab.refId} />;
    case 'node':
      return <NodeView key={tab.refId} id={tab.refId} />;
    case 'runner':
      return <RunnerView key={tab.refId} id={tab.refId} />;
    case 'env':
      return <EnvView key={tab.refId} id={tab.refId} />;
    case 'globals':
      return <GlobalsView />;
    default:
      return <Welcome />;
  }
}

// The OAuth 2.0 provider redirects the login popup here; hand the code back to the app.
function OAuthCallback() {
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    window.opener?.postMessage({ type: 'apicall-oauth', code: p.get('code'), state: p.get('state'), error: p.get('error_description') || p.get('error') }, location.origin);
    setTimeout(() => window.close(), 300);
  }, []);
  return <div className="boot">Signing in… you can close this window.</div>;
}

export default function App() {
  const ready = useWs((s) => !!s.ws);
  const [error, setError] = useState(null);
  const isCallback = location.pathname === '/oauth/callback';

  useEffect(() => {
    if (!isCallback) loadWorkspace().catch((e) => setError(errMsg(e)));
  }, [isCallback]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) {
          const s = useUi.getState();
          const tab = s.openTabs.find((t) => t.id === s.activeTab);
          if (tab?.kind === 'request') setUi({ modal: { type: 'saveAs', refId: tab.refId } });
          return;
        }
        if (A.saveActiveTab()) saveNow();
      } else if (e.altKey && !mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        A.newRequestTab();
      } else if (e.altKey && !mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const id = useUi.getState().activeTab;
        if (id) A.closeTab(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (isCallback) return <OAuthCallback />;
  if (error) {
    return (
      <div className="boot">
        <h2>Cannot load the workspace</h2>
        <p className="mono">{error}</p>
        <p className="hint">Is the server running? Start it with npm run dev (development) or npm start (after npm run build).</p>
      </div>
    );
  }
  if (!ready) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      <Topbar />
      <div className="workspace">
        <Sidebar />
        <main className="main glass">
          <TabBar />
          <div className="main-body">
            <MainView />
          </div>
        </main>
      </div>
      <ContextMenu />
      <Modals />
      <Toasts />
    </div>
  );
}
