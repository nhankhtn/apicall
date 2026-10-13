import { useRef, useState } from 'react';
import { VarInput } from './vars.jsx';
import { uploadFile, toast } from '../actions.js';
import { errMsg } from '../lib/util.js';
import { IconX } from './icons.jsx';
import { Select } from './Menu.jsx';

const toBulk = (rows) => rows.map((r) => `${r.enabled === false ? '//' : ''}${r.key}: ${r.value ?? ''}`).join('\n');

function fromBulk(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const off = l.trimStart().startsWith('//');
      const line = off ? l.trimStart().slice(2) : l;
      const i = line.indexOf(':');
      return i < 0 ? { key: line.trim(), value: '', enabled: !off } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim(), enabled: !off };
    });
}

// Same props as VarInput, for tables that should not treat {{…}} specially.
function PlainInput({ value, onChange, ...p }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...p} />;
}

function FileCell({ row, onChange }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    setBusy(true);
    try {
      const meta = await uploadFile(file);
      onChange({ fileId: meta.id, fileName: meta.name });
    } catch (e) {
      toast(`Cannot attach ${file.name}: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kv-file">
      <input ref={input} type="file" hidden onChange={(e) => e.target.files[0] && pick(e.target.files[0])} />
      {row.fileName ? (
        <span className={`file-chip ${row.fileId ? '' : 'missing'}`} title={row.fileId ? row.fileName : 'Imported from Postman: select the file again'}>
          {row.fileName}
          <button className="chip-x" onClick={() => onChange({ fileId: null, fileName: '' })} title="Remove file">
            ×
          </button>
        </span>
      ) : null}
      <button className="link-btn" disabled={busy} onClick={() => input.current.click()}>
        {busy ? 'Uploading…' : row.fileId ? 'Change' : 'Select file'}
      </button>
    </div>
  );
}

// Editable key/value table. The trailing "ghost" row shares its React key with the row
// it turns into, so focus stays in the input while the first character creates the row.
//  - description: show a Description column (Postman's params/headers/body tables)
//  - files: rows can switch between Text and File (form-data)
//  - fixedKeys: keys are not editable and rows cannot be added/removed (path variables)
export default function KeyValueEditor({
  rows,
  onChange,
  toggle = true,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  bulk = true,
  description = false,
  files = false,
  fixedKeys = false,
  vars = true,
}) {
  const [bulkText, setBulkText] = useState(null);
  const update = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (patch) => onChange([...rows, { key: '', value: '', enabled: true, ...(files ? { type: 'text' } : {}), ...patch }]);
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const Field = vars ? VarInput : PlainInput;
  const cols = ['toggle', 'key', 'value', description && 'desc', 'del'].filter(Boolean).filter((c) => toggle || c !== 'toggle');
  const template = cols.map((c) => ({ toggle: '32px', key: 'minmax(0,1fr)', value: 'minmax(0,1.5fr)', desc: 'minmax(0,1fr)', del: '32px' })[c]).join(' ');

  return (
    <div className="kv">
      {bulk && !fixedKeys && (
        <div className="kv-tools">
          <button className="link-btn" onClick={() => setBulkText(bulkText == null ? toBulk(rows) : null)}>
            {bulkText == null ? 'Bulk edit' : 'Key-value edit'}
          </button>
        </div>
      )}
      {bulkText != null ? (
        <textarea
          className="bulk"
          spellCheck={false}
          value={bulkText}
          placeholder={'Key: Value\n//Disabled-Key: Value'}
          onChange={(e) => {
            setBulkText(e.target.value);
            onChange(fromBulk(e.target.value));
          }}
        />
      ) : (
        <div className="kv-table">
          <div className="kv-row kv-head" style={{ gridTemplateColumns: template }}>
            {toggle && <span />}
            <span>Key</span>
            <span>Value</span>
            {description && <span>Description</span>}
            <span />
          </div>
          {[...rows, ...(fixedKeys ? [] : [null])].map((row, i) => {
            const ghost = row === null;
            const isFile = files && row?.type === 'file';
            return (
              <div key={i} className={`kv-row ${ghost ? 'ghost' : ''} ${row?.enabled === false ? 'off' : ''}`} style={{ gridTemplateColumns: template }}>
                {toggle && (
                  <input type="checkbox" disabled={ghost} checked={ghost ? false : row.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })} />
                )}
                <div className="kv-cell">
                  {fixedKeys ? (
                    <span className="kv-fixed mono">{row.key}</span>
                  ) : (
                    <Field
                      value={ghost ? '' : row.key}
                      placeholder={keyPlaceholder}
                      onChange={(v) => (ghost ? add({ key: v }) : update(i, { key: v }))}
                    />
                  )}
                  {files && !ghost && (
                    <Select
                      className="kv-type"
                      value={row.type || 'text'}
                      minWidth={110}
                      onChange={(t) => update(i, t === 'file' ? { type: 'file', value: '' } : { type: 'text', fileId: null, fileName: '' })}
                      options={[
                        { value: 'text', label: 'Text' },
                        { value: 'file', label: 'File' },
                      ]}
                    />
                  )}
                </div>
                <div className="kv-cell">
                  {isFile ? (
                    <FileCell row={row} onChange={(patch) => update(i, patch)} />
                  ) : (
                    <Field value={ghost ? '' : row.value ?? ''} placeholder={valuePlaceholder} onChange={(v) => (ghost ? add({ value: v }) : update(i, { value: v }))} />
                  )}
                </div>
                {description && (
                  <div className="kv-cell">
                    <input
                      value={ghost ? '' : row.description || ''}
                      placeholder="Description"
                      onChange={(e) => (ghost ? add({ description: e.target.value }) : update(i, { description: e.target.value }))}
                    />
                  </div>
                )}
                <button className="icon-btn" title="Remove" disabled={ghost || fixedKeys} onClick={() => remove(i)}>
                  <IconX />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
