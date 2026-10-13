import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi, useWs, setSubTab, setUi } from '../store.js';
import { effectiveAuth, findNode, isHttp, convertRequest, PROTOCOLS } from '../lib/model.js';
import RealtimeView from './RealtimeView.jsx';
import GrpcView from './GrpcView.jsx';
import { Select, MethodSelect } from './Menu.jsx';
import { parseQuery, withQuery, syncPathVars } from '../lib/build.js';
import * as A from '../actions.js';
import KeyValueEditor from './KeyValueEditor.jsx';
import CodeEditor from './CodeEditor.jsx';
import AuthEditor from './AuthEditor.jsx';
import ScriptEditor from './ScriptEditor.jsx';
import ResponseView from './ResponseView.jsx';
import { VarsProvider, VarInput, useVars } from './vars.jsx';
import { IconMore, IconCode, IconCaretDown } from './icons.jsx';
import { errMsg } from '../lib/util.js';

const BODY_MODES = [
  ['none', 'none'],
  ['formdata', 'form-data'],
  ['urlencoded', 'x-www-form-urlencoded'],
  ['raw', 'raw'],
  ['binary', 'binary'],
  ['graphql', 'GraphQL'],
];
const RAW_LANGS = [
  ['json', 'JSON'],
  ['text', 'Text'],
  ['xml', 'XML'],
  ['html', 'HTML'],
  ['javascript', 'JavaScript'],
];

function BinaryPicker({ binary, onChange }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    setBusy(true);
    try {
      const meta = await A.uploadFile(file);
      onChange({ fileId: meta.id, fileName: meta.name });
    } catch (e) {
      A.toast(`Cannot attach ${file.name}: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="binary-picker">
      <input ref={input} type="file" hidden onChange={(e) => e.target.files[0] && pick(e.target.files[0])} />
      {binary?.fileName && <span className={`file-chip ${binary.fileId ? '' : 'missing'}`}>{binary.fileName}</span>}
      <button className="btn small" disabled={busy} onClick={() => input.current.click()}>
        {busy ? 'Uploading…' : binary?.fileId ? 'Change file' : 'Select file'}
      </button>
      {binary?.fileName && !binary.fileId && <span className="hint small">Imported from Postman: select the file again.</span>}
      <p className="hint small">The file is sent as the raw request body. Content-Type defaults to the file's type.</p>
    </div>
  );
}

function BodyEditor({ body, onChange }) {
  const vars = useVars();
  const b = body;
  const set = (patch) => onChange({ ...b, ...patch });
  const beautify = () => {
    try {
      set({ raw: JSON.stringify(JSON.parse(b.raw), null, 2) });
    } catch {
      A.toast('Body is not valid JSON (it may contain {{variables}} outside strings)', 'error');
    }
  };
  return (
    <div className="body-editor">
      <div className="body-modes">
        {BODY_MODES.map(([k, label]) => (
          <label key={k} className="radio">
            <input type="radio" checked={b.mode === k} onChange={() => set({ mode: k })} />
            {label}
          </label>
        ))}
        {b.mode === 'raw' && (
          <>
            <Select className="small-select" value={b.rawLang || 'text'} minWidth={140} onChange={(rawLang) => set({ rawLang })} options={RAW_LANGS.map(([value, label]) => ({ value, label }))} />
            {b.rawLang === 'json' && (
              <button className="link-btn" onClick={beautify}>
                Beautify
              </button>
            )}
          </>
        )}
      </div>
      {b.mode === 'none' && <p className="hint">This request does not have a body.</p>}
      {b.mode === 'raw' && (
        <div className="body-raw">
          <CodeEditor
            value={b.raw}
            vars={vars}
            onChange={(raw) => set({ raw })}
            language={b.rawLang === 'json' ? 'json' : b.rawLang === 'javascript' ? 'javascript' : 'text'}
            placeholder='{"key": "{{value}}"}'
          />
        </div>
      )}
      {b.mode === 'urlencoded' && <KeyValueEditor rows={b.urlencoded} description onChange={(urlencoded) => set({ urlencoded })} />}
      {b.mode === 'formdata' && <KeyValueEditor rows={b.formdata} description files onChange={(formdata) => set({ formdata })} />}
      {b.mode === 'binary' && <BinaryPicker binary={b.binary} onChange={(binary) => set({ binary })} />}
      {b.mode === 'graphql' && (
        <div className="graphql">
          <div className="graphql-pane">
            <div className="pane-label">Query</div>
            <div className="body-raw">
              <CodeEditor value={b.graphql?.query} vars={vars} placeholder="query { viewer { id } }" onChange={(query) => set({ graphql: { ...b.graphql, query } })} />
            </div>
          </div>
          <div className="graphql-pane">
            <div className="pane-label">GraphQL variables (JSON)</div>
            <div className="body-raw">
              <CodeEditor value={b.graphql?.variables} vars={vars} language="json" placeholder='{"id": "{{id}}"}' onChange={(variables) => set({ graphql: { ...b.graphql, variables } })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TriState({ label, hint, value, onChange, globalValue }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        <div className="hint small">{hint}</div>
      </div>
      <Select
        className="setting-select"
        value={value === undefined ? 'default' : value ? 'on' : 'off'}
        onChange={(v) => onChange(v === 'default' ? undefined : v === 'on')}
        options={[
          { value: 'default', label: `Default (${globalValue ? 'on' : 'off'})` },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
    </div>
  );
}

function SettingsTab({ settings, onChange }) {
  const g = useWs((s) => s.ws.settings);
  const set = (k, v) => {
    const next = { ...settings };
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="settings-tab pad">
      <TriState label="Enable SSL certificate verification" hint="Off accepts self-signed and expired certificates for this request." value={settings.verifySsl} globalValue={g.verifySsl !== false} onChange={(v) => set('verifySsl', v)} />
      <TriState label="Automatically follow redirects" hint="Off returns the 3xx response itself." value={settings.followRedirects} globalValue={g.followRedirects !== false} onChange={(v) => set('followRedirects', v)} />
      <TriState label="Use the cookie jar" hint="Send stored cookies and store cookies this response sets." value={settings.cookieJar} globalValue={g.cookieJar !== false} onChange={(v) => set('cookieJar', v)} />
      <div className="setting-row">
        <div>
          <div className="setting-label">Request timeout (ms)</div>
          <div className="hint small">Empty uses the workspace default ({g.timeoutMs} ms).</div>
        </div>
        <input type="number" min="1" placeholder={String(g.timeoutMs)} value={settings.timeoutMs ?? ''} onChange={(e) => set('timeoutMs', e.target.value ? Number(e.target.value) : undefined)} />
      </div>
    </div>
  );
}

function useSplitter() {
  const height = useUi((s) => s.editorHeight);
  const start = (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev) => setUi({ editorHeight: Math.max(120, Math.min(window.innerHeight - 220, h0 + ev.clientY - y0)) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-v');
    };
    document.body.classList.add('resizing-v');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return [height, start];
}

// Name, unsaved dot, Save / Save As, code snippet and "more" menu; shared by every request kind.
export function RequestHeader({ refId, r, found }) {
  const dirty = useUi((s) => A.isDirty(refId, s));
  const http = isHttp(r);
  const chain = found?.chain || [];
  const upd = (fn) => A.updateRequest(refId, fn);
  const saveMenu = (e) =>
    A.openMenu(e, [
      { label: 'Save As…', onClick: () => setUi({ modal: { type: 'saveAs', refId } }) },
      { label: 'Revert changes', disabled: !dirty || r._tmp, onClick: () => A.revertRequest(refId) },
    ]);
  const more = (e) =>
    A.openMenu(e, [
      ...(http
        ? [
            { label: 'Copy as cURL', onClick: () => A.copyAsCurl(refId) },
            { label: 'Generate code snippet', onClick: () => setUi({ modal: { type: 'code', refId } }) },
          ]
        : []),
      ...(found
        ? [
            { label: 'Duplicate', onClick: () => A.duplicateNode(refId) },
            { sep: true },
            { label: 'Delete', danger: true, onClick: () => A.deleteNode(refId) },
          ]
        : []),
    ]);
  return (
    <div className="view-head">
      <div className="crumbs">{found ? chain.map((n) => <span key={n.id}>{n.name} /</span>) : <span className="unsaved-tag">Unsaved request</span>}</div>
      <input className="title-input" value={r.name} spellCheck={false} onChange={(e) => upd((n) => void (n.name = e.target.value))} />
      {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      <Select
        className="type-select"
        title="Request type"
        ariaLabel="Request type"
        value={r.protocol || 'http'}
        minWidth={170}
        onChange={(protocol) => upd((n) => convertRequest(n, protocol))}
        options={PROTOCOLS.map(([value, label]) => ({ value, label }))}
      />
      <div className="split-btn">
        <button className="btn small" disabled={!dirty} onClick={() => A.saveRequest(refId)} title="Save (Ctrl+S)">
          Save
        </button>
        <button className="btn small split-caret" onClick={saveMenu} title="More save options">
          <IconCaretDown />
        </button>
      </div>
      {http && (
        <button className="icon-btn" title="Code snippet" onClick={() => setUi({ modal: { type: 'code', refId } })}>
          <IconCode />
        </button>
      )}
      <button className="icon-btn" title="More" onClick={more}>
        <IconMore />
      </button>
    </div>
  );
}

function RequestEditor({ refId, r, found }) {
  const tab = useUi((s) => s.subTabs.req);
  const record = useUi((s) => s.responses[refId]);
  const sending = useUi((s) => !!s.sending[refId]);
  const [editorHeight, startResize] = useSplitter();
  const urlRef = useRef(null);
  const upd = (fn) => A.updateRequest(refId, fn);
  const chain = found?.chain || [];

  useEffect(() => {
    if (!r.url) urlRef.current?.focus();
    // Focus the URL only when switching to a fresh request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId]);

  const params = [...parseQuery(r.url), ...(r.disabledQuery || []).map((q) => ({ ...q, enabled: false }))];
  const pathVars = syncPathVars(r.url, r.pathVars);
  const enabledHeaders = r.headers.filter((x) => x.enabled !== false && x.key).length;
  const inherited = effectiveAuth({ auth: { type: 'inherit' } }, chain);
  const settingsCount = Object.keys(r.settings || {}).length;
  const tabs = [
    ['params', `Params${params.length + pathVars.length ? ` (${params.length + pathVars.length})` : ''}`],
    ['auth', 'Authorization', r.auth.type !== 'inherit'],
    ['headers', `Headers${enabledHeaders ? ` (${enabledHeaders})` : ''}`],
    ['body', 'Body', r.body.mode !== 'none'],
    ['pre', 'Pre-request', !!r.preRequest?.trim()],
    ['tests', 'Tests', !!r.test?.trim()],
    ['settings', `Settings${settingsCount ? ` (${settingsCount})` : ''}`],
    ['docs', 'Docs', !!r.description?.trim()],
  ];

  const setUrl = (url) =>
    upd((n) => {
      n.url = url;
      n.pathVars = syncPathVars(url, n.pathVars);
    });

  return (
    <div className="request-view">
      <RequestHeader refId={refId} r={r} found={found} />

      <div className="url-bar">
        <MethodSelect value={r.method} onChange={(method) => upd((n) => void (n.method = method))} />
        <VarInput
          inputRef={urlRef}
          className="url-input mono"
          value={r.url}
          placeholder="Enter URL, {{baseUrl}}/items/:id — or paste a cURL command"
          onChange={setUrl}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/^\s*curl\s/i.test(text)) {
              e.preventDefault();
              A.applyCurl(refId, text);
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && A.sendRequest(refId)}
        />
        {sending ? (
          <button className="btn send" onClick={() => A.cancelRequest(refId)}>
            Cancel
          </button>
        ) : (
          <button className="btn primary send" onClick={() => A.sendRequest(refId)}>
            Send
          </button>
        )}
      </div>

      <div className="tabs req-tabs">
        {tabs.map(([k, label, dot]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setSubTab('req', k)}>
            {label}
            {dot && <span className="dot" />}
          </button>
        ))}
      </div>

      <div className="editor-pane" style={{ height: editorHeight }}>
        {tab === 'params' && (
          <div className="params-tab">
            <div className="pane-label">Query Params</div>
            <KeyValueEditor
              rows={params}
              bulk
              onChange={(rows) =>
                upd((n) => {
                  n.url = withQuery(n.url, rows.filter((p) => p.enabled !== false));
                  n.disabledQuery = rows.filter((p) => p.enabled === false).map(({ key, value }) => ({ key, value }));
                  n.pathVars = syncPathVars(n.url, n.pathVars);
                })
              }
            />
            {pathVars.length > 0 && (
              <>
                <div className="pane-label">Path Variables</div>
                <KeyValueEditor rows={pathVars} toggle={false} fixedKeys description onChange={(rows) => upd((n) => void (n.pathVars = rows))} />
              </>
            )}
            {!pathVars.length && <p className="hint small">Add path variables by writing <code>/:name</code> in the URL, e.g. <code>/orders/:orderId</code>.</p>}
          </div>
        )}
        {tab === 'headers' && (
          <div className="headers-tab">
            <KeyValueEditor rows={r.headers} description onChange={(rows) => upd((n) => void (n.headers = rows))} />
            <p className="hint small">
              Added automatically when sent: Content-Type (from the body), Authorization (from auth), Cookie (from the cookie jar), User-Agent. Headers you set here win.
            </p>
          </div>
        )}
        {tab === 'body' && <BodyEditor body={r.body} onChange={(body) => upd((n) => void (n.body = body))} />}
        {tab === 'auth' && <AuthEditor auth={r.auth} inherited={inherited} refId={refId} onChange={(auth) => upd((n) => void (n.auth = auth))} />}
        {tab === 'pre' && <ScriptEditor kind="pre" value={r.preRequest} onChange={(v) => upd((n) => void (n.preRequest = v))} />}
        {tab === 'tests' && <ScriptEditor kind="test" value={r.test} onChange={(v) => upd((n) => void (n.test = v))} />}
        {tab === 'settings' && <SettingsTab settings={r.settings || {}} onChange={(settings) => upd((n) => void (n.settings = settings))} />}
        {tab === 'docs' && (
          <textarea
            className="docs"
            placeholder="Describe what this request does, expected inputs, edge cases…"
            value={r.description || ''}
            onChange={(e) => upd((n) => void (n.description = e.target.value))}
          />
        )}
      </div>

      <div className="splitter-h" onMouseDown={startResize} />

      <div className="response-pane">
        <ResponseView record={record} sending={sending} onCancel={() => A.cancelRequest(refId)} refId={refId} />
      </div>
    </div>
  );
}

export default function RequestView({ refId }) {
  const ws = useWs((s) => s.ws);
  const draft = useUi((s) => s.drafts[refId]);
  const found = useMemo(() => findNode(ws, refId), [ws, refId]);
  const r = draft ?? (found?.node.type === 'request' ? found.node : null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        A.sendRequest(refId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refId]);

  if (!r) return <div className="empty-view">This request no longer exists.</div>;
  return (
    <VarsProvider refId={refId}>
      {isHttp(r) ? (
        <RequestEditor refId={refId} r={r} found={found} />
      ) : r.protocol === 'grpc' ? (
        <GrpcView refId={refId} r={r} found={found} />
      ) : (
        <RealtimeView refId={refId} r={r} found={found} />
      )}
    </VarsProvider>
  );
}
