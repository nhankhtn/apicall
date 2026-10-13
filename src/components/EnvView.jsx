import { useUi, useWs, setUi, updateEnv, mutate } from '../store.js';
import * as A from '../actions.js';
import VariablesEditor from './VariablesEditor.jsx';
import { IconEnv, IconGlobe, IconMore } from './icons.jsx';

export function EnvView({ id }) {
  const env = useWs((s) => s.ws.environments.find((e) => e.id === id));
  const envId = useUi((s) => s.envId);
  if (!env) return <div className="empty-view">This environment no longer exists.</div>;
  const active = envId === env.id;
  const more = (e) =>
    A.openMenu(e, [
      { label: 'Duplicate', onClick: () => A.duplicateEnvironment(env.id) },
      { label: 'Export', onClick: () => A.exportEnvironment(env.id) },
      { sep: true },
      { label: 'Delete', danger: true, onClick: () => A.deleteEnvironment(env.id) },
    ]);
  return (
    <div className="env-view">
      <div className="view-head">
        <IconEnv className="head-ico" />
        <input className="title-input" value={env.name} spellCheck={false} onChange={(e) => updateEnv(env.id, (x) => void (x.name = e.target.value))} />
        <button className={`btn small ${active ? '' : 'primary'}`} onClick={() => setUi({ envId: active ? null : env.id })}>
          {active ? 'Deactivate' : 'Set active'}
        </button>
        <button className="icon-btn" title="More" onClick={more}>
          <IconMore />
        </button>
      </div>
      <div className="pad env-body">
        <p className="hint">
          Use as {'{{name}}'} in URLs, headers, bodies and auth. Requests use the <b>current value</b>; scripts update it with <code>pm.environment.set()</code>. The{' '}
          <b>initial value</b> is what gets exported and shared. Secret values are masked.
        </p>
        <VariablesEditor rows={env.values} onChange={(rows) => updateEnv(env.id, (x) => void (x.values = rows))} />
      </div>
    </div>
  );
}

export function GlobalsView() {
  const globals = useWs((s) => s.ws.globals);
  return (
    <div className="env-view">
      <div className="view-head">
        <IconGlobe className="head-ico" />
        <h2 className="title-static">Globals</h2>
      </div>
      <div className="pad env-body">
        <p className="hint">Globals apply to every collection and environment, at the lowest precedence.</p>
        <VariablesEditor rows={globals} onChange={(rows) => mutate((ws) => void (ws.globals = rows))} />
      </div>
    </div>
  );
}
