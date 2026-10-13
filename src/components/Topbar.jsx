import { useShallow } from 'zustand/react/shallow';
import { useUi, useWs, setUi, toggleTheme } from '../store.js';
import { IconEnv, IconGear, IconImport, IconLogo, IconMoon, IconSun, IconCookie, IconPlus } from './icons.jsx';
import { newRequestTab } from '../actions.js';

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
      <label className="env-pick" title="Active environment">
        <IconEnv />
        <select value={activeId} onChange={(e) => setUi({ envId: e.target.value || null })}>
          <option value="">No environment</option>
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <button className="topbar-btn" title="New request (Alt+N)" onClick={() => newRequestTab()}>
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
