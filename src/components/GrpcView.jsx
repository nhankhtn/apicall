import { useMemo, useRef, useState } from 'react';
import { useUi, useWs, setSubTab } from '../store.js';
import * as A from '../actions.js';
import { useRt, startSession, sendFrame, stopSession, clearLog, describeGrpc, logLocal } from '../realtime.js';
import { formatMs, readFileText, errMsg } from '../lib/util.js';
import { RequestHeader } from './RequestView.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import CodeEditor from './CodeEditor.jsx';
import { VarInput, useVars } from './vars.jsx';
import { Select } from './Menu.jsx';
import { IconLock } from './icons.jsx';

// Loaded service definitions per request tab (not saved: they come from the server or the .proto files).
const described = new Map();

const kind = (m) => (m.requestStream && m.responseStream ? 'Bidirectional streaming' : m.requestStream ? 'Client streaming' : m.responseStream ? 'Server streaming' : 'Unary');

function ProtoFiles({ files, onChange }) {
  const input = useRef(null);
  const add = async (list) => {
    const next = { ...files };
    for (const f of list) next[f.name] = await readFileText(f);
    onChange(next);
  };
  const names = Object.keys(files);
  return (
    <div className="proto-files">
      <input ref={input} type="file" accept=".proto" multiple hidden onChange={(e) => add([...e.target.files])} />
      {names.map((n) => (
        <span key={n} className="file-chip">
          {n}
          <button className="chip-x" title="Remove" onClick={() => onChange(Object.fromEntries(Object.entries(files).filter(([k]) => k !== n)))}>
            ×
          </button>
        </span>
      ))}
      <button className="btn small" onClick={() => input.current.click()}>
        Import .proto files
      </button>
      <p className="hint small">Import every file the service needs (imports are resolved by file name). google/protobuf/* types are built in.</p>
    </div>
  );
}

export default function GrpcView({ refId, r, found }) {
  const g = r.grpc;
  const vars = useVars();
  const tab = useUi((s) => s.subTabs.grpc) || 'message';
  const settings = useWs((s) => s.ws.settings);
  const session = useRt((s) => s.sessions[refId]);
  const [services, setServices] = useState(() => described.get(refId) || null);
  const [loading, setLoading] = useState(false);
  const upd = (fn) => A.updateRequest(refId, fn);
  const setG = (patch) => upd((n) => void Object.assign(n.grpc, patch));
  const realtimeOk = useUi((s) => s.capabilities.realtime !== false);
  const status = session?.status || 'idle';
  const running = status === 'connecting' || status === 'connected';

  const methods = useMemo(() => (services || []).flatMap((s) => s.methods.map((m) => ({ ...m, service: s.name }))), [services]);
  const current = methods.find((m) => m.service === g.service && m.name === g.method);

  const target = () => {
    const v = A.varsFor(refId);
    return { R: (s) => v.replaceIn(s ?? ''), target: v.replaceIn(r.url).trim().replace(/^(grpcs?|https?):\/\//, '') };
  };
  const definition = () => ({
    tls: !!g.tls,
    verifySsl: g.verifySsl ?? settings.verifySsl !== false,
    reflection: !!g.reflection,
    proto: g.reflection ? null : { files: g.protoFiles },
  });

  const load = async () => {
    const t = target();
    if (!t.target) return A.toast('Enter the server address (host:port) first', 'error');
    if (!g.reflection && !Object.keys(g.protoFiles).length) return A.toast('Import .proto files or turn on server reflection', 'error');
    setLoading(true);
    try {
      const list = await describeGrpc({ target: t.target, ...definition(), metadata: g.metadata.filter((m) => m.enabled !== false && m.key).map((m) => ({ key: t.R(m.key), value: t.R(m.value) })) });
      described.set(refId, list);
      setServices(list);
      if (!list.some((s) => s.name === g.service && s.methods.some((m) => m.name === g.method)) && list[0]?.methods[0]) {
        setG({ service: list[0].name, method: list[0].methods[0].name });
      }
      A.toast(`Loaded ${list.reduce((n, s) => n + s.methods.length, 0)} method(s)`, 'success');
    } catch (e) {
      A.toast(`Cannot load the service definition: ${errMsg(e)}`, 'error', 7000);
    } finally {
      setLoading(false);
    }
    return undefined;
  };

  const parseMessage = (R) => {
    try {
      return JSON.parse(R(g.message || '{}'));
    } catch (e) {
      A.toast(`Message is not valid JSON: ${e.message}`, 'error');
      return undefined;
    }
  };

  const invoke = () => {
    const t = target();
    if (!t.target || !g.service || !g.method) return A.toast('Pick a server and a method first (Load methods)', 'error');
    const message = parseMessage(t.R);
    if (message === undefined) return undefined;
    clearLog(refId);
    startSession(refId, 'grpc', {
      type: 'grpc-call',
      target: t.target,
      ...definition(),
      service: g.service,
      method: g.method,
      metadata: g.metadata.filter((m) => m.enabled !== false && m.key).map((m) => ({ key: t.R(m.key), value: t.R(m.value) })),
      message,
      deadlineMs: Number(g.deadlineMs) || 0,
    }).then(() => logLocal(refId, { dir: 'out', message }));
    return undefined;
  };

  const writeMessage = () => {
    const t = target();
    const message = parseMessage(t.R);
    if (message !== undefined) sendFrame(refId, { type: 'grpc-write', message }, { message });
  };

  const tabs = [
    ['message', 'Message'],
    ['metadata', `Metadata${g.metadata.filter((m) => m.enabled !== false && m.key).length ? ` (${g.metadata.filter((m) => m.enabled !== false && m.key).length})` : ''}`],
    ['definition', 'Service definition'],
    ['settings', 'Settings'],
  ];
  const gs = session?.grpcStatus;
  const log = session?.log || [];

  return (
    <div className="request-view">
      <RequestHeader refId={refId} r={r} found={found} />
      <div className="url-bar">
        <span className="proto-tag p-grpc">gRPC</span>
        <button className={`icon-btn tls-toggle ${g.tls ? 'on' : ''}`} title={g.tls ? 'TLS on (click for plaintext)' : 'Plaintext (click for TLS)'} onClick={() => setG({ tls: !g.tls })}>
          <IconLock />
        </button>
        <VarInput className="url-input mono" value={r.url} placeholder="localhost:50051 or {{grpcHost}}" onChange={(url) => upd((n) => void (n.url = url))} />
        <Select
          className="grpc-method"
          value={current ? `${current.service}/${current.name}` : ''}
          minWidth={320}
          display={g.method ? `${g.service.split('.').pop()}/${g.method}` : 'Select a method'}
          onChange={(v) => {
            const [service, method] = v.split('/');
            setG({ service, method });
          }}
          options={methods.length ? methods.map((m) => ({ value: `${m.service}/${m.name}`, label: `${m.service.split('.').pop()} / ${m.name} · ${kind(m)}` })) : [{ value: '', label: 'Load methods first', disabled: true }]}
        />
        <button className="btn small" disabled={loading} onClick={load} title="Load services via reflection or the imported .proto files">
          {loading ? 'Loading…' : 'Load methods'}
        </button>
        {running ? (
          <button className="btn send" onClick={() => stopSession(refId)}>
            Cancel
          </button>
        ) : (
          <button className="btn primary send" onClick={invoke}>
            Invoke
          </button>
        )}
      </div>

      {!realtimeOk && (
        <div className="hint warn rt-banner">
          This deployment cannot invoke gRPC (Vercel has no realtime relay); Load methods still works. Run the Docker image or <code>npm start</code> to call methods.
        </div>
      )}
      <div className="tabs req-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setSubTab('grpc', k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="rt-editor">
        {tab === 'message' && (
          <div className="composer">
            <div className="composer-editor">
              <CodeEditor value={g.message} vars={vars} language="json" placeholder='{"id": "{{id}}"}' onChange={(message) => setG({ message })} />
            </div>
            <div className="composer-actions">
              <span className="hint small">{current ? `${kind(current)} · ${current.requestType} → ${current.responseType}` : 'Load methods to see the request type.'}</span>
              <span className="spacer" />
              <button className="btn small ghost" disabled={!current?.requestExample} onClick={() => setG({ message: JSON.stringify(current.requestExample, null, 2) })}>
                Use example message
              </button>
              {current?.requestStream && (
                <>
                  <button className="btn small" disabled={status !== 'connected' && status !== 'connecting'} onClick={writeMessage}>
                    Send message
                  </button>
                  <button className="btn small" disabled={status !== 'connected' && status !== 'connecting'} onClick={() => sendFrame(refId, { type: 'grpc-end' }, { dir: 'sys', text: 'Stream ended by client' })}>
                    End streaming
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {tab === 'metadata' && (
          <div className="pad">
            <KeyValueEditor rows={g.metadata} onChange={(metadata) => setG({ metadata })} keyPlaceholder="authorization" valuePlaceholder="Bearer {{token}}" />
          </div>
        )}
        {tab === 'definition' && (
          <div className="pad">
            <div className="setting-row">
              <div>
                <div className="setting-label">Use server reflection</div>
                <div className="hint small">Ask the server for its services (grpc.reflection v1 / v1alpha). Turn off to use .proto files.</div>
              </div>
              <input type="checkbox" className="switch" checked={!!g.reflection} onChange={(e) => setG({ reflection: e.target.checked })} />
            </div>
            {!g.reflection && <ProtoFiles files={g.protoFiles} onChange={(protoFiles) => setG({ protoFiles })} />}
            {services && (
              <div className="services">
                {services.map((s) => (
                  <div key={s.name} className="service">
                    <div className="setting-label mono">{s.name}</div>
                    {s.methods.map((m) => (
                      <div key={m.name} className="hint small mono">
                        {m.name}({m.requestStream ? 'stream ' : ''}
                        {m.requestType}) → {m.responseStream ? 'stream ' : ''}
                        {m.responseType}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === 'settings' && (
          <div className="pad settings-tab">
            <div className="setting-row">
              <div>
                <div className="setting-label">Deadline (ms)</div>
                <div className="hint small">0 = no deadline.</div>
              </div>
              <input type="number" min="0" value={g.deadlineMs} onChange={(e) => setG({ deadlineMs: Number(e.target.value) })} />
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">SSL certificate verification</div>
                <div className="hint small">With TLS on. Off accepts self-signed certificates.</div>
              </div>
              <input type="checkbox" className="switch" checked={g.verifySsl ?? settings.verifySsl !== false} onChange={(e) => setG({ verifySsl: e.target.checked })} />
            </div>
          </div>
        )}
      </div>

      <div className="response-pane">
        <div className="rt-log">
          <div className="rt-log-tools">
            <span className="pane-label">Response</span>
            {gs ? (
              <>
                <span className={`status ${gs.code === 0 ? 's2' : 's5'}`}>
                  {gs.code} {gs.codeName}
                </span>
                <span className="hint small">{formatMs(gs.timeMs)}</span>
                {gs.details && gs.code !== 0 && <span className="bad-text small">{gs.details}</span>}
              </>
            ) : running ? (
              <span className="hint small">Waiting for the server…</span>
            ) : null}
            <span className="spacer" />
            <button className="btn small ghost" disabled={!log.length} onClick={() => clearLog(refId)}>
              Clear
            </button>
          </div>
          <div className="rt-list">
            {!log.length && <p className="hint pad">Pick a method, write the message and press Invoke.</p>}
            {log.map((e) => (
              <div key={e.id} className={`rt-entry ${e.dir}`}>
                <div className="rt-line">
                  <span className={`rt-dir ${e.dir}`}>{e.dir === 'in' ? '↓' : e.dir === 'out' ? '↑' : '•'}</span>
                  <span className="rt-time">{new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}</span>
                </div>
                {e.dir === 'sys' ? <div className="hint small">{e.text}</div> : <pre className="rt-detail mono">{JSON.stringify(e.message, null, 2)}</pre>}
              </div>
            ))}
            {gs && (gs.metadata?.length > 0 || gs.trailers?.length > 0) && (
              <div className="grpc-meta">
                {gs.metadata?.length > 0 && (
                  <>
                    <div className="pane-label">Response metadata</div>
                    {gs.metadata.map((m, i) => (
                      <div key={`m${i}`} className="mono small">
                        {m.key}: {m.value}
                      </div>
                    ))}
                  </>
                )}
                {gs.trailers?.length > 0 && (
                  <>
                    <div className="pane-label">Trailers</div>
                    {gs.trailers.map((m, i) => (
                      <div key={`t${i}`} className="mono small">
                        {m.key}: {m.value}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

