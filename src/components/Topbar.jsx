import { useShallow } from 'zustand/react/shallow';
import { useUi, useWs, setUi, toggleTheme } from '../store.js';
import { IconEnv, IconGear, IconImport, IconLogo, IconMoon, IconSun, IconCookie, IconPlus } from './icons.jsx';
import { newRequestTab, openMenu } from '../actions.js';
import { PROTOCOLS } from '../lib/model.js';
import { Select } from './Menu.jsx';

const SAVE_LABEL = { pending: 'Unsaved changes', saving: 'Saving…', saved: 'All changes saved', error: 'Save failed' };

export default function Topbar() {
  const envs = useWs((s) => s.ws.environments);
  const { envId, saveStatus, saveError, theme } = useUi(useShallow((s) => ({ envId: s.envId, saveStatus: s.saveStatus, saveError: s.saveError, theme: s.theme })));
  const activeId = envs.some((e) => e.id === envId) ? envId : '';

  return (
    <header className="topbar">
      <div className="brand">
        <IconLogo />
        <span>ApiCall Runner</span>
      </div>
      <span className="spacer" />
      <span className={`save-status ${saveStatus}`} title={saveError || ''}>
        {SAVE_LABEL[saveStatus]}
      </span>
      <div className="env-pick">
        <Select
          className="env-select"
          title="Active environment"
          ariaLabel="Active environment"
          value={activeId}
          minWidth={220}
          onChange={(v) => setUi({ envId: v || null })}
          display={
            <>
              <IconEnv /> {envs.find((e) => e.id === activeId)?.name || 'No environment'}
            </>
          }
          options={[{ value: '', label: 'No environment' }, ...envs.map((e) => ({ value: e.id, label: e.name }))]}
        />
      </div>
      <button
        className="topbar-btn"
        title="New request (Alt+N for HTTP)"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom + 8 }, PROTOCOLS.map(([k, label]) => ({ label: `${label} request`, onClick: () => newRequestTab({ protocol: k }) })));
        }}
      >
        <IconPlus /> New
      </button>
      <button className="topbar-btn" onClick={() => setUi({ modal: { type: 'import' } })}>
        <IconImport /> Import
      </button>
      <button className="topbar-btn icon" title="Cookies" onClick={() => setUi({ modal: { type: 'cookies' } })}>
        <IconCookie />
      </button>
      <button className="topbar-btn icon" title={theme === 'dark' ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}>
        {theme === 'dark' ? <IconSun /> : <IconMoon />}
      </button>
      <button className="topbar-btn icon" title="Settings" onClick={() => setUi({ modal: { type: 'settings' } })}>
        <IconGear />
      </button>
    </header>
  );
}
