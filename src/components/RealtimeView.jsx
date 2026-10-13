import { useEffect, useRef, useState } from 'react';
import { useUi, useWs, setSubTab } from '../store.js';
import * as A from '../actions.js';
import { useRt, startSession, sendFrame, stopSession, clearLog } from '../realtime.js';
import { prettyBody, uid } from '../lib/util.js';
import { RequestHeader } from './RequestView.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import CodeEditor from './CodeEditor.jsx';
import { VarInput, useVars } from './vars.jsx';
import { Select } from './Menu.jsx';
import { IconSearch, IconX } from './icons.jsx';

const LABEL = { websocket: 'WebSocket', socketio: 'Socket.IO', mqtt: 'MQTT' };
const PLACEHOLDER = {
  websocket: 'wss://echo.websocket.org or {{wsUrl}}',
  socketio: 'http://localhost:3000 (Socket.IO server URL)',
  mqtt: 'mqtt://broker.hivemq.com:1883, mqtts://…, ws://…/mqtt',
};
const cfgKey = (p) => (p === 'websocket' ? 'ws' : p);

const time = (t) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

function entryText(e) {
  if (e.dir === 'sys') return e.text;
  if (e.event !== undefined || e.args !== undefined) return `${e.event ?? ''}${e.ack ? ' (ack)' : ''}  ${JSON.stringify(e.args ?? [])}`;
  if (e.topic !== undefined) return e.payload ?? '';
  return e.binary ? `<binary ${Math.round(((e.data || '').length * 3) / 4)} bytes>` : String(e.data ?? '');
}

function LogEntry({ e }) {
  const [open, setOpen] = useState(false);
  const text = entryText(e);
  const body = e.topic !== undefined ? e.payload : e.args !== undefined ? JSON.stringify(e.args) : e.data;
  const pretty = open && typeof body === 'string' && !e.binary ? prettyBody(body) : null;
  return (
    <div className={`rt-entry ${e.dir}`} onClick={() => e.dir !== 'sys' && setOpen(!open)}>
      <div className="rt-line">
        <span className={`rt-dir ${e.dir}`}>{e.dir === 'in' ? '↓' : e.dir === 'out' ? '↑' : '•'}</span>
        {e.topic !== undefined && <span className="rt-topic mono">{e.topic}</span>}
        {e.event !== undefined && <span className="rt-topic mono">{e.event}</span>}
        <span className="rt-text mono">{e.event !== undefined ? JSON.stringify(e.args ?? []) : text}</span>
        <span className="rt-time">{time(e.at)}</span>
      </div>
      {open && <pre className="rt-detail mono">{pretty?.text ?? text}</pre>}
    </div>
  );
}

function MessageLog({ refId, session }) {
  const [q, setQ] = useState('');
  const [dir, setDir] = useState('all');
  const end = useRef(null);
  const log = session?.log || [];
  const f = q.trim().toLowerCase();
  const shown = log.filter((e) => (dir === 'all' || e.dir === dir || e.dir === 'sys') && (!f || entryText(e).toLowerCase().includes(f) || (e.topic || e.event || '').toLowerCase().includes(f)));
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [log.length]);
  return (
    <div className="rt-log">
      <div className="rt-log-tools">
        <span className="pane-label">Messages</span>
        <label className="search rt-search">
          <IconSearch />
          <input value={q} placeholder="Search messages" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg">
          {[
            ['all', 'All'],
            ['in', 'Received'],
            ['out', 'Sent'],
          ].map(([k, l]) => (
            <button key={k} className={dir === k ? 'on' : ''} onClick={() => setDir(k)}>
              {l}
            </button>
          ))}
        </div>
        <button className="btn small ghost" disabled={!log.length} onClick={() => clearLog(refId)}>
          Clear
        </button>
      </div>
      <div className="rt-list">
        {!log.length && <p className="hint pad">Connect, then send messages. Everything sent and received shows up here.</p>}
        {shown.map((e) => (
          <LogEntry key={e.id} e={e} />
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

function SavedMessages({ saved, onLoad, onDelete }) {
  if (!saved.length) return <p className="hint pad">Save the message you are composing to reuse it later.</p>;
  return (
    <div className="saved-list">
      {saved.map((m) => (
        <div key={m.id} className="saved-row" onClick={() => onLoad(m)}>
          <span className="name">{m.name}</span>
          <span className="hint small mono">{(m.topic || m.event || '').slice(0, 40)}</span>
          <button
            className="icon-btn"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(m.id);
            }}
          >
            <IconX />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function RealtimeView({ refId, r, found }) {
  const proto = r.protocol;
  const key = cfgKey(proto);
  const cfg = r[key];
  const vars = useVars();
  const session = useRt((s) => s.sessions[refId]);
  const settings = useWs((s) => s.ws.settings);
  const tab = useUi((s) => s.subTabs.rt) || 'message';
  const realtimeOk = useUi((s) => s.capabilities.realtime !== false);
  const status = session?.status || 'idle';
  const connected = status === 'connected';
  const busy = status === 'connecting';
  const upd = (fn) => A.updateRequest(refId, fn);
  const setCfg = (patch) => upd((n) => void Object.assign(n[key], patch));
  const subscribedOnce = useRef(null);

  const resolve = () => {
    const v = A.varsFor(refId);
    const R = (s) => v.replaceIn(s ?? '');
    return { R, headers: r.headers.filter((h) => h.enabled !== false && h.key).map((h) => ({ key: R(h.key), value: R(h.value) })) };
  };
  const common = () => ({ verifySsl: r.settings?.verifySsl ?? settings.verifySsl !== false, timeoutMs: r.settings?.timeoutMs || 20000 });

  const connect = () => {
    const { R, headers } = resolve();
    const url = R(r.url).trim();
    if (!url) return A.toast('Enter a URL first', 'error');
    let options;
    if (proto === 'websocket') options = { ...common(), subprotocols: R(cfg.subprotocols).split(',').map((x) => x.trim()).filter(Boolean) };
    if (proto === 'socketio') {
      let auth = {};
      try {
        auth = cfg.auth?.trim() ? JSON.parse(R(cfg.auth)) : {};
      } catch (e) {
        return A.toast(`Auth payload is not valid JSON: ${e.message}`, 'error');
      }
      options = { ...common(), path: R(cfg.path) || '/socket.io', version: cfg.version, auth, query: {}, events: cfg.events.filter((e) => e.enabled !== false && e.key).map((e) => R(e.key)) };
    }
    if (proto === 'mqtt') {
      options = {
        ...common(),
        clientId: R(cfg.clientId),
        username: R(cfg.username) || undefined,
        password: R(cfg.password) || undefined,
        clean: cfg.clean,
        keepalive: Number(cfg.keepalive) || 60,
        protocolVersion: Number(cfg.protocolVersion) || 4,
        will: null,
      };
    }
    subscribedOnce.current = null;
    startSession(refId, proto, { type: 'connect', protocol: proto, url, headers, options }, { keepLog: true });
  };

  // MQTT: subscribe to the enabled topics once the broker accepts the connection.
  useEffect(() => {
    if (proto !== 'mqtt' || !connected || subscribedOnce.current === session?.id) return;
    subscribedOnce.current = session.id;
    const { R } = resolve();
    for (const s of cfg.subscriptions.filter((x) => x.enabled !== false && x.key)) {
      sendFrame(refId, { type: 'subscribe', topic: R(s.key), qos: Number(s.value) || 0 }, { text: `Subscribed to ${R(s.key)} (QoS ${Number(s.value) || 0})`, dir: 'sys' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, session?.id]);

  const send = () => {
    const { R } = resolve();
    if (proto === 'websocket') {
      const data = R(cfg.message);
      if (cfg.format === 'binary') {
        sendFrame(refId, { type: 'send', data: btoa(unescape(encodeURIComponent(data))), binary: true }, { data, binary: false });
      } else sendFrame(refId, { type: 'send', data, binary: false }, { data });
    }
    if (proto === 'socketio') {
      let args;
      try {
        const parsed = cfg.args?.trim() ? JSON.parse(R(cfg.args)) : [];
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        return A.toast(`Arguments must be JSON (an array for several arguments): ${e.message}`, 'error');
      }
      sendFrame(refId, { type: 'emit', event: R(cfg.event), args, ack: !!cfg.ack }, { event: R(cfg.event), args });
    }
    if (proto === 'mqtt') {
      if (!cfg.topic) return A.toast('Enter a topic to publish to', 'error');
      sendFrame(refId, { type: 'publish', topic: R(cfg.topic), payload: R(cfg.payload), qos: Number(cfg.qos) || 0, retain: !!cfg.retain }, { topic: R(cfg.topic), payload: R(cfg.payload) });
    }
    return undefined;
  };

  const saveMessage = () => {
    const name = window.prompt('Message name', proto === 'mqtt' ? cfg.topic || 'Message' : proto === 'socketio' ? cfg.event : 'Message');
    if (!name) return;
    const m = { id: uid(), name };
    if (proto === 'websocket') Object.assign(m, { message: cfg.message, format: cfg.format });
    if (proto === 'socketio') Object.assign(m, { event: cfg.event, args: cfg.args, ack: cfg.ack });
    if (proto === 'mqtt') Object.assign(m, { topic: cfg.topic, payload: cfg.payload, qos: cfg.qos, retain: cfg.retain });
    setCfg({ saved: [...(cfg.saved || []), m] });
  };
  const loadMessage = (m) => {
    const { id, name, ...fields } = m;
    setCfg(fields);
    setSubTab('rt', 'message');
  };

  const listenNow = () => {
    const { R } = resolve();
    for (const e of cfg.events.filter((x) => x.enabled !== false && x.key)) sendFrame(refId, { type: 'listen', event: R(e.key) }, { dir: 'sys', text: `Listening to "${R(e.key)}"` });
  };
  const subscribeNow = () => {
    const { R } = resolve();
    for (const s of cfg.subscriptions.filter((x) => x.enabled !== false && x.key)) sendFrame(refId, { type: 'subscribe', topic: R(s.key), qos: Number(s.value) || 0 }, { dir: 'sys', text: `Subscribed to ${R(s.key)}` });
  };

  const tabs = [
    ['message', proto === 'mqtt' ? 'Publish' : 'Message'],
    ...(proto === 'socketio' ? [['events', `Events (${cfg.events.filter((e) => e.enabled !== false && e.key).length})`]] : []),
    ...(proto === 'mqtt' ? [['topics', `Subscriptions (${cfg.subscriptions.filter((e) => e.enabled !== false && e.key).length})`]] : []),
    ['headers', `Headers${r.headers.filter((h) => h.enabled !== false && h.key).length ? ` (${r.headers.filter((h) => h.enabled !== false && h.key).length})` : ''}`],
    ['settings', 'Settings'],
    ['saved', `Saved messages${cfg.saved?.length ? ` (${cfg.saved.length})` : ''}`],
  ];

  const info = session?.info;
  return (
    <div className="request-view">
      <RequestHeader refId={refId} r={r} found={found} />
      <div className="url-bar">
        <span className={`proto-tag p-${proto}`}>{LABEL[proto]}</span>
        <VarInput className="url-input mono" value={r.url} placeholder={PLACEHOLDER[proto]} onChange={(url) => upd((n) => void (n.url = url))} onKeyDown={(e) => e.key === 'Enter' && !connected && connect()} />
        {connected || busy ? (
          <button className="btn send" onClick={() => stopSession(refId)}>
            {busy ? 'Cancel' : 'Disconnect'}
          </button>
        ) : (
          <button className="btn primary send" onClick={connect}>
            Connect
          </button>
        )}
      </div>
      {!realtimeOk && (
        <div className="hint warn rt-banner">
          This deployment has no realtime relay (Vercel cannot keep connections open). Run the Docker image or <code>npm start</code> to use {LABEL[proto]}.
        </div>
      )}
      <div className="rt-status">
        <span className={`rt-dot ${status}`} />
        <span>{status === 'idle' ? 'Not connected' : status[0].toUpperCase() + status.slice(1)}</span>
        {session?.error && <span className="bad-text">{session.error}</span>}
        {info?.status && <span className="hint small">handshake {info.status}</span>}
      </div>

      <div className="tabs req-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setSubTab('rt', k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="rt-editor">
        {tab === 'message' && (
          <div className="composer">
            {proto === 'socketio' && (
              <div className="composer-row">
                <span className="field-label">Event</span>
                <VarInput className="mono" value={cfg.event} placeholder="message" onChange={(event) => setCfg({ event })} />
                <label className="check inline-check">
                  <input type="checkbox" checked={!!cfg.ack} onChange={(e) => setCfg({ ack: e.target.checked })} /> Wait for ack
                </label>
              </div>
            )}
            {proto === 'mqtt' && (
              <div className="composer-row">
                <span className="field-label">Topic</span>
                <VarInput className="mono" value={cfg.topic} placeholder="devices/1/state" onChange={(topic) => setCfg({ topic })} />
                <Select className="small-select" value={String(cfg.qos ?? 0)} onChange={(v) => setCfg({ qos: Number(v) })} options={['0', '1', '2'].map((q) => ({ value: q, label: `QoS ${q}` }))} />
                <label className="check inline-check">
                  <input type="checkbox" checked={!!cfg.retain} onChange={(e) => setCfg({ retain: e.target.checked })} /> Retain
                </label>
              </div>
            )}
            <div className="composer-editor">
              <CodeEditor
                value={proto === 'websocket' ? cfg.message : proto === 'socketio' ? cfg.args : cfg.payload}
                vars={vars}
                language={proto === 'socketio' || (proto === 'websocket' && cfg.format === 'json') ? 'json' : 'text'}
                placeholder={proto === 'socketio' ? '["arg1", {"key": "value"}]' : 'Message text, JSON, {{variables}}…'}
                onChange={(v) => setCfg(proto === 'websocket' ? { message: v } : proto === 'socketio' ? { args: v } : { payload: v })}
              />
            </div>
            <div className="composer-actions">
              {proto === 'websocket' && (
                <Select
                  className="small-select"
                  value={cfg.format || 'text'}
                  onChange={(format) => setCfg({ format })}
                  options={[
                    { value: 'text', label: 'Text' },
                    { value: 'json', label: 'JSON' },
                    { value: 'binary', label: 'Binary (UTF-8 bytes)' },
                  ]}
                />
              )}
              <span className="spacer" />
              <button className="btn small ghost" onClick={saveMessage}>
                Save message
              </button>
              <button className="btn small primary" disabled={!connected} onClick={send}>
                {proto === 'mqtt' ? 'Publish' : proto === 'socketio' ? 'Emit' : 'Send'}
              </button>
            </div>
          </div>
        )}
        {tab === 'events' && proto === 'socketio' && (
          <div className="pad">
            <p className="hint small">Events to listen to. Use * for every event. They are registered when connecting; use the button to add them to a live connection.</p>
            <KeyValueEditor rows={cfg.events} bulk={false} keyPlaceholder="event name" valuePlaceholder="description" onChange={(events) => setCfg({ events })} />
            <button className="btn small" disabled={!connected} onClick={listenNow}>
              Listen now
            </button>
          </div>
        )}
        {tab === 'topics' && proto === 'mqtt' && (
          <div className="pad">
            <p className="hint small">Topics (wildcards + and # allowed) with QoS 0, 1 or 2. Enabled topics are subscribed on connect.</p>
            <KeyValueEditor rows={cfg.subscriptions} bulk={false} keyPlaceholder="topic/#" valuePlaceholder="QoS (0-2)" onChange={(subscriptions) => setCfg({ subscriptions })} />
            <button className="btn small" disabled={!connected} onClick={subscribeNow}>
              Subscribe now
            </button>
          </div>
        )}
        {tab === 'headers' && (
          <div className="pad">
            <p className="hint small">Sent with the {proto === 'mqtt' ? 'WebSocket upgrade (ws:// and wss:// brokers)' : 'connection handshake'}.</p>
            <KeyValueEditor rows={r.headers} onChange={(headers) => upd((n) => void (n.headers = headers))} />
          </div>
        )}
        {tab === 'settings' && (
          <div className="pad settings-tab">
            {proto === 'websocket' && (
              <div className="field">
                <span className="field-label">Subprotocols (comma separated)</span>
                <VarInput value={cfg.subprotocols} placeholder="graphql-ws, mqtt" onChange={(subprotocols) => setCfg({ subprotocols })} />
              </div>
            )}
            {proto === 'socketio' && (
              <>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">Path</span>
                    <VarInput value={cfg.path} placeholder="/socket.io" onChange={(path) => setCfg({ path })} />
                  </div>
                  <div className="field">
                    <span className="field-label">Client version</span>
                    <Select value={cfg.version} onChange={(version) => setCfg({ version })} options={[{ value: 'v4', label: 'v4' }, { value: 'v3', label: 'v3' }, { value: 'v2', label: 'v2' }]} />
                  </div>
                </div>
                <div className="field">
                  <span className="field-label">Handshake auth (JSON)</span>
                  <VarInput className="mono" value={cfg.auth} placeholder='{"token": "{{token}}"}' onChange={(auth) => setCfg({ auth })} />
                </div>
              </>
            )}
            {proto === 'mqtt' && (
              <>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">Client ID</span>
                    <VarInput value={cfg.clientId} onChange={(clientId) => setCfg({ clientId })} />
                  </div>
                  <div className="field">
                    <span className="field-label">MQTT version</span>
                    <Select value={String(cfg.protocolVersion)} onChange={(v) => setCfg({ protocolVersion: Number(v) })} options={[{ value: '4', label: '3.1.1' }, { value: '5', label: '5.0' }]} />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">Username</span>
                    <VarInput value={cfg.username} onChange={(username) => setCfg({ username })} />
                  </div>
                  <div className="field">
                    <span className="field-label">Password</span>
                    <VarInput value={cfg.password} onChange={(password) => setCfg({ password })} />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">Keep alive (s)</span>
                    <input type="number" min="0" value={cfg.keepalive} onChange={(e) => setCfg({ keepalive: Number(e.target.value) })} />
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={!!cfg.clean} onChange={(e) => setCfg({ clean: e.target.checked })} /> Clean session
                  </label>
                </div>
              </>
            )}
            <div className="setting-row">
              <div>
                <div className="setting-label">SSL certificate verification</div>
                <div className="hint small">For wss:// and mqtts://. Off accepts self-signed certificates.</div>
              </div>
              <input type="checkbox" className="switch" checked={r.settings?.verifySsl ?? settings.verifySsl !== false} onChange={(e) => upd((n) => void (n.settings = { ...n.settings, verifySsl: e.target.checked }))} />
            </div>
          </div>
        )}
        {tab === 'saved' && <SavedMessages saved={cfg.saved || []} onLoad={loadMessage} onDelete={(id) => setCfg({ saved: cfg.saved.filter((m) => m.id !== id) })} />}
      </div>

      <div className="response-pane">
        <MessageLog refId={refId} session={session} />
      </div>
    </div>
  );
}

