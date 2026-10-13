import { useState } from 'react';
import { persistAllValues, resetAllValues } from '../actions.js';
import { IconX } from './icons.jsx';
import { Select } from './Menu.jsx';

const blank = () => ({ key: '', value: '', enabled: true, type: 'default' });

// Postman-style variable table: Variable | Type | Initial value | Current value.
// Initial values are shared/exported; current values are local and what requests use.
export default function VariablesEditor({ rows, onChange, search = true }) {
  const [reveal, setReveal] = useState(false);
  const [filter, setFilter] = useState('');
  const update = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (patch) => onChange([...rows, { ...blank(), ...patch }]);
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const f = filter.trim().toLowerCase();
  const hasCurrent = rows.some((r) => r.current !== undefined);

  return (
    <div className="vars-editor">
      <div className="vars-tools">
        {search && <input className="vars-filter" placeholder="Filter variables" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="spacer" />
        <label className="check inline-check">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show secret values
        </label>
        <button className="btn small" disabled={!hasCurrent} title="Copy every current value into its initial value" onClick={() => onChange(persistAllValues(rows))}>
          Persist all
        </button>
        <button className="btn small" disabled={!hasCurrent} title="Discard current values; initial values apply again" onClick={() => onChange(resetAllValues(rows))}>
          Reset all
        </button>
      </div>
      <div className="kv-table vars-table">
        <div className="kv-row kv-head">
          <span />
          <span>Variable</span>
          <span>Type</span>
          <span>Initial value</span>
          <span>Current value</span>
          <span />
        </div>
        {[...rows, null].map((row, i) => {
          const ghost = row === null;
          if (!ghost && f && !row.key.toLowerCase().includes(f)) return null;
          const secret = !ghost && row.type === 'secret' && !reveal;
          return (
            <div key={i} className={`kv-row ${ghost ? 'ghost' : ''} ${row?.enabled === false ? 'off' : ''}`}>
              <input type="checkbox" disabled={ghost} checked={ghost ? false : row.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })} />
              <div className="kv-cell">
                <input value={ghost ? '' : row.key} placeholder="Add new variable" spellCheck={false} onChange={(e) => (ghost ? add({ key: e.target.value }) : update(i, { key: e.target.value }))} />
              </div>
              <div className="kv-cell">
                <Select
                  className="kv-type"
                  disabled={ghost}
                  value={ghost ? 'default' : row.type || 'default'}
                  minWidth={120}
                  onChange={(type) => update(i, { type })}
                  options={[
                    { value: 'default', label: 'default' },
                    { value: 'secret', label: 'secret' },
                  ]}
                />
              </div>
              <div className="kv-cell">
                <input
                  type={secret ? 'password' : 'text'}
                  value={ghost ? '' : row.value ?? ''}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => (ghost ? add({ value: e.target.value }) : update(i, { value: e.target.value }))}
                />
              </div>
              <div className="kv-cell">
                <input
                  type={secret ? 'password' : 'text'}
                  value={ghost ? '' : row.current ?? row.value ?? ''}
                  className={!ghost && row.current !== undefined && row.current !== row.value ? 'changed' : ''}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={ghost}
                  onChange={(e) => update(i, { current: e.target.value })}
                />
              </div>
              <button className="icon-btn" title="Remove" disabled={ghost} onClick={() => remove(i)}>
                <IconX />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
