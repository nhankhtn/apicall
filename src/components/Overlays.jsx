import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUi, useWs, setUi, mutate, LS } from '../store.js';
import { readFileText, errMsg } from '../lib/util.js';
import { parseSetCookie, formatCookie, isExpired } from '../lib/cookies.js';
import { LANGUAGES, generateCode } from '../lib/codegen.js';
import * as A from '../actions.js';
import CodeEditor from './CodeEditor.jsx';
import { IconX, IconCopy } from './icons.jsx';

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - width - 8), top: Math.min(menu.y, window.innerHeight - height - 8) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && ref.current?.contains(e.target)) return;
      A.closeMenu();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', A.closeMenu);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', A.closeMenu);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="menu glass" style={pos || { left: menu.x, top: menu.y, visibility: 'hidden' }}>
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              A.closeMenu();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Modal({ title, onClose, children, size = '' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal glass ${size}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ImportModal({ onClose }) {
  const collections = useWs((s) => s.ws.collections);
  const [tab, setTab] = useState('file');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const [curlTarget, setCurlTarget] = useState('');
  const isCurl = /^\s*curl\s/i.test(text);

  const importFiles = async (files) => {
    const msgs = [];
    const errs = [];
    for (const f of files) {
      try {
        msgs.push(A.importText(await readFileText(f), { curlTarget }));
      } catch (e) {
        errs.push(`${f.name}: ${errMsg(e)}`);
      }
    }
    if (msgs.length) A.toast(msgs.join('; '), 'success', 5000);
    if (errs.length) setError(errs.join('\n'));
    else onClose();
  };

  const importPasted = () => {
    try {
      A.toast(A.importText(text, { curlTarget }), 'success');
      onClose();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal title="Import" onClose={onClose} size="wide">
      <div className="tabs">
        <button className={`tab ${tab === 'file' ? 'on' : ''}`} onClick={() => setTab('file')}>
          File
        </button>
        <button className={`tab ${tab === 'paste' ? 'on' : ''}`} onClick={() => setTab('paste')}>
          Paste raw text / cURL
        </button>
      </div>
      <div className="modal-body">
        {tab === 'file' ? (
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              importFiles([...e.dataTransfer.files]);
            }}
          >
            <p>Drop Postman collection / environment JSON files here</p>
            <input ref={fileRef} type="file" accept=".json,application/json" multiple hidden onChange={(e) => importFiles([...e.target.files])} />
            <button className="btn" onClick={() => fileRef.current.click()}>
              Choose files
            </button>
            <p className="hint small">Supports Postman Collection v2.0 / v2.1, Postman environments, and ApiCall workspace backups.</p>
          </div>
        ) : (
          <>
            <textarea
              className="paste mono"
              autoFocus
              spellCheck={false}
              value={text}
              placeholder={"curl 'https://api.example.com/items' -H 'Authorization: Bearer …'\n\nor paste Postman collection / environment JSON"}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
            {isCurl && (
              <label className="field inline">
                <span className="field-label">Open as</span>
                <select value={curlTarget} onChange={(e) => setCurlTarget(e.target.value)}>
                  <option value="">New unsaved request tab</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      Request in "{c.name}"
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {error && <pre className="form-error">{error}</pre>}
      </div>
      {tab === 'paste' && (
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={importPasted}>
            Import
          </button>
        </div>
      )}
    </Modal>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="setting-row toggle-row">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className="hint small">{hint}</div>}
      </div>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function CertificateList({ certs, onChange }) {
  const readInto = async (i, field, file) => {
    const text = await readFileText(file);
    onChange(certs.map((c, j) => (j === i ? { ...c, [field]: text } : c)));
  };
  return (
    <div className="certs">
      {certs.map((c, i) => (
        <div key={i} className="cert-card">
          <div className="field-row">
            <label className="field">
              <span className="field-label">Host</span>
              <input value={c.host} placeholder="api.example.com or *.example.com" onChange={(e) => onChange(certs.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)))} />
            </label>
            <label className="field">
              <span className="field-label">Passphrase</span>
              <input type="password" value={c.passphrase || ''} onChange={(e) => onChange(certs.map((x, j) => (j === i ? { ...x, passphrase: e.target.value } : x)))} />
            </label>
          </div>
          <div className="field-row">
            {['cert', 'key'].map((field) => (
              <label key={field} className="field">
                <span className="field-label">{field === 'cert' ? 'Certificate (CRT/PEM)' : 'Private key (PEM)'}</span>
                <input type="file" onChange={(e) => e.target.files[0] && readInto(i, field, e.target.files[0])} />
                <span className="hint small">{c[field] ? `Loaded (${c[field].length} chars)` : 'Not set'}</span>
              </label>
            ))}
          </div>
          <button className="link-btn" onClick={() => onChange(certs.filter((_, j) => j !== i))}>
            Remove certificate
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...certs, { host: '', cert: '', key: '', passphrase: '' }])}>
        Add certificate
      </button>
    </div>
  );
}

function VaultEditor() {
  const vault = useUi((s) => s.vault);
  const [reveal, setReveal] = useState(false);
  const rows = [...vault, null];
  const set = (next) => setUi({ vault: next });
  return (
    <div>
      <p className="hint small">
        Vault secrets stay in this browser only (never sent to the server, never exported). Use them as <code>{'{{vault:name}}'}</code> or{' '}
        <code>await pm.vault.get("name")</code>.
      </p>
      <label className="check">
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show values
      </label>
      <div className="kv-table">
        {rows.map((row, i) => (
          <div key={i} className={`kv-row ${row ? '' : 'ghost'}`} style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.5fr) 32px' }}>
            <div className="kv-cell">
              <input value={row?.key ?? ''} placeholder="Secret name" onChange={(e) => set(row ? vault.map((v, j) => (j === i ? { ...v, key: e.target.value } : v)) : [...vault, { key: e.target.value, value: '' }])} />
            </div>
            <div className="kv-cell">
              <input type={reveal ? 'text' : 'password'} value={row?.value ?? ''} placeholder="Value" autoComplete="off" onChange={(e) => set(row ? vault.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)) : [...vault, { key: '', value: e.target.value }])} />
            </div>
            <button className="icon-btn" disabled={!row} onClick={() => set(vault.filter((_, j) => j !== i))}>
              <IconX />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsModal({ onClose }) {
  const settings = useWs((s) => s.ws.settings);
  const [tab, setTab] = useState('general');
  const set = (patch) => mutate((ws) => void Object.assign(ws.settings, patch));
  const tabs = [
    ['general', 'General'],
    ['proxy', 'Proxy'],
    ['certs', 'Certificates'],
    ['vault', 'Vault'],
    ['data', 'Data'],
  ];
  return (
    <Modal title="Settings" onClose={onClose} size="wide">
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="modal-body settings-body">
        {tab === 'general' && (
          <>
            <div className="setting-row">
              <div>
                <div className="setting-label">Request timeout (ms)</div>
                <div className="hint small">How long to wait for a response. Requests can override it in their Settings tab.</div>
              </div>
              <input type="number" min="1" value={settings.timeoutMs} onChange={(e) => set({ timeoutMs: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
            <Toggle label="SSL certificate verification" hint="Turn off to call servers with self-signed or expired certificates." checked={settings.verifySsl !== false} onChange={(v) => set({ verifySsl: v })} />
            <Toggle label="Automatically follow redirects" checked={settings.followRedirects !== false} onChange={(v) => set({ followRedirects: v })} />
            <Toggle label="Cookie jar" hint="Store cookies from responses and send them with later requests to the same domain." checked={settings.cookieJar !== false} onChange={(v) => set({ cookieJar: v })} />
          </>
        )}
        {tab === 'proxy' && (
          <>
            <label className="field">
              <span className="field-label">Proxy URL</span>
              <input value={settings.proxyUrl || ''} placeholder="http://user:pass@proxy.local:3128 (empty = direct)" onChange={(e) => set({ proxyUrl: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Bypass proxy for</span>
              <input value={settings.noProxy || ''} placeholder="localhost,127.0.0.1,*.internal" onChange={(e) => set({ noProxy: e.target.value })} />
              <span className="hint small">Comma-separated hosts; a leading *. matches subdomains.</span>
            </label>
          </>
        )}
        {tab === 'certs' && (
          <>
            <p className="hint small">Client certificates (mutual TLS) are sent to matching hosts. They are stored in the workspace on this machine.</p>
            <CertificateList certs={settings.clientCerts || []} onChange={(clientCerts) => set({ clientCerts })} />
          </>
        )}
        {tab === 'vault' && <VaultEditor />}
        {tab === 'data' && (
          <div className="field">
            <span className="field-label">Workspace backup</span>
            <div>
              <button className="btn" onClick={A.exportWorkspace}>
                Export all collections, environments, globals and settings
              </button>
            </div>
            <p className="hint small">Restore it through Import. Data lives on the server in data/ (workspace.json, history.json, runs.json, files/).</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CookiesModal({ onClose }) {
  const cookies = useWs((s) => s.ws.cookies);
  const domains = useMemo(() => [...new Set(cookies.map((c) => c.domain))].sort(), [cookies]);
  const [domain, setDomain] = useState(domains[0] || '');
  const [newDomain, setNewDomain] = useState('');
  const [draft, setDraft] = useState(null); // { index|-1, text }
  const setJar = (next) => mutate((ws) => void (ws.cookies = next));
  const inDomain = cookies.map((c, i) => ({ c, i })).filter(({ c }) => c.domain === domain);

  const saveDraft = () => {
    try {
      const c = parseSetCookie(draft.text, `https://${domain}/`);
      if (!c) throw new Error('Expected "name=value; Path=/; …"');
      const next = draft.index >= 0 ? cookies.map((x, i) => (i === draft.index ? c : x)) : [...cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)), c];
      setJar(next);
      setDraft(null);
    } catch (e) {
      A.toast(errMsg(e), 'error');
    }
  };

  return (
    <Modal title="Manage cookies" onClose={onClose} size="wide">
      <div className="modal-body cookies-modal">
        <div className="cookie-add">
          <input value={newDomain} placeholder="Add domain, e.g. api.example.com" onChange={(e) => setNewDomain(e.target.value)} />
          <button
            className="btn small"
            disabled={!newDomain.trim()}
            onClick={() => {
              setDomain(newDomain.trim().toLowerCase());
              setDraft({ index: -1, text: 'name=value; Path=/' });
              setNewDomain('');
            }}
          >
            Add
          </button>
        </div>
        <div className="cookie-grid">
          <div className="cookie-domains">
            {[...new Set([...domains, domain].filter(Boolean))].map((d) => (
              <button key={d} className={`side-item ${d === domain ? 'on' : ''}`} onClick={() => setDomain(d)}>
                <span className="name">{d}</span>
                <span className="hint small">{cookies.filter((c) => c.domain === d).length}</span>
              </button>
            ))}
            {!domains.length && !domain && <p className="hint small">No cookies yet. Responses with Set-Cookie fill the jar automatically.</p>}
          </div>
          <div className="cookie-list">
            {domain && (
              <>
                {inDomain.map(({ c, i }) => (
                  <div key={i} className={`cookie-row ${isExpired(c) ? 'expired' : ''}`}>
                    <span className="mono">{formatCookie(c)}</span>
                    <button className="link-btn" onClick={() => setDraft({ index: i, text: formatCookie(c) })}>
                      Edit
                    </button>
                    <button className="link-btn danger" onClick={() => setJar(cookies.filter((_, j) => j !== i))}>
                      Delete
                    </button>
                  </div>
                ))}
                {draft ? (
                  <div className="cookie-edit">
                    <textarea className="mono" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                    <div className="row-actions">
                      <button className="btn small" onClick={() => setDraft(null)}>
                        Cancel
                      </button>
                      <button className="btn small primary" onClick={saveDraft}>
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="row-actions">
                    <button className="btn small" onClick={() => setDraft({ index: -1, text: 'name=value; Path=/' })}>
                      Add cookie
                    </button>
                    <button className="btn small ghost" disabled={!inDomain.length} onClick={() => setJar(cookies.filter((c) => c.domain !== domain))}>
                      Clear {domain}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SaveAsModal({ refId, onClose }) {
  const ws = useWs((s) => s.ws);
  const req = A.getRequest(refId);
  const [name, setName] = useState(req?.name === 'Untitled Request' ? '' : req?.name || '');
  const [parentId, setParentId] = useState(ws.collections[0]?.id || '');
  const [newCol, setNewCol] = useState('');
  const options = [];
  const walk = (n, depth) => {
    options.push({ id: n.id, label: `${'  '.repeat(depth)}${n.type === 'collection' ? '▣' : '▸'} ${n.name}` });
    n.items.filter((x) => x.type === 'folder').forEach((x) => walk(x, depth + 1));
  };
  ws.collections.forEach((c) => walk(c, 0));
  const save = () => {
    let target = parentId;
    if (!target || newCol.trim()) target = A.createCollection(newCol.trim() || 'New Collection').id;
    A.saveRequestAs(refId, { name: name || req.name, parentId: target });
    setUi({ renaming: null });
    onClose();
  };
  if (!req) return null;
  return (
    <Modal title="Save request" onClose={onClose}>
      <div className="modal-body">
        <label className="field">
          <span className="field-label">Request name</span>
          <input autoFocus value={name} placeholder={req.name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
        <label className="field">
          <span className="field-label">Save to</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={!!newCol.trim()}>
            {!options.length && <option value="">(no collections yet)</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">…or a new collection</span>
          <input value={newCol} placeholder="New collection name" onChange={(e) => setNewCol(e.target.value)} />
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function UnsavedModal({ tabIds, dirtyIds, onClose }) {
  const tabs = useUi((s) => s.openTabs);
  const names = dirtyIds.map((id) => A.getRequest(tabs.find((t) => t.id === id)?.refId)?.name).filter(Boolean);
  const saveAll = () => {
    for (const id of dirtyIds) {
      const t = tabs.find((x) => x.id === id);
      // Unsaved new requests need a location; stop and ask.
      if (t && !A.saveRequest(t.refId)) return;
    }
    onClose();
    A.closeTabs(tabIds, { force: true });
  };
  return (
    <Modal title="Unsaved changes" onClose={onClose}>
      <div className="modal-body">
        <p>
          {names.length === 1 ? `"${names[0]}" has` : `${names.length} requests have`} unsaved changes. Save before closing?
        </p>
        {names.length > 1 && (
          <ul className="plain-list">
            {names.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal-foot">
        <button
          className="btn ghost"
          onClick={() => {
            onClose();
            A.closeTabs(tabIds, { force: true });
          }}
        >
          Don't save
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={saveAll}>
          Save changes
        </button>
      </div>
    </Modal>
  );
}

function CodeModal({ refId, onClose }) {
  const [lang, setLang] = useState(LS.get('codegenLang', 'curl'));
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    A.resolvedSpec(refId)
      .then(({ spec }) => live && setCode(generateCode(lang, spec)))
      .catch((e) => live && setError(errMsg(e)));
    LS.set('codegenLang', lang);
    return () => {
      live = false;
    };
  }, [refId, lang]);
  const meta = LANGUAGES.find((l) => l.id === lang);
  return (
    <Modal title="Code snippet" onClose={onClose} size="wide">
      <div className="modal-body code-modal">
        <div className="code-tools">
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="hint small">Variables resolved with the active environment. Pre-request scripts are not run.</span>
          <span className="spacer" />
          <button className="btn small" onClick={() => navigator.clipboard.writeText(code).then(() => A.toast('Snippet copied', 'success'))}>
            <IconCopy /> Copy
          </button>
        </div>
        {error ? <pre className="form-error">{error}</pre> : <div className="code-box"><CodeEditor value={code} readOnly language={meta?.editorLang || 'text'} /></div>}
      </div>
    </Modal>
  );
}

export function Modals() {
  const modal = useUi((s) => s.modal);
  const close = () => setUi({ modal: null });
  switch (modal?.type) {
    case 'import':
      return <ImportModal onClose={close} />;
    case 'settings':
      return <SettingsModal onClose={close} />;
    case 'cookies':
      return <CookiesModal onClose={close} />;
    case 'saveAs':
      return <SaveAsModal refId={modal.refId} onClose={close} />;
    case 'unsaved':
      return <UnsavedModal tabIds={modal.tabIds} dirtyIds={modal.dirtyIds} onClose={close} />;
    case 'code':
      return <CodeModal refId={modal.refId} onClose={close} />;
    default:
      return null;
  }
}

