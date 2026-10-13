// Browser side of the server relay (/api/realtime): one WebSocket carries every WebSocket,
// Socket.IO, MQTT and gRPC session. Session state lives in its own store so a busy message
// log does not re-render the rest of the app.
import { create } from 'zustand';
import { uid } from './lib/util.js';

const MAX_LOG = 2000;

// sessions[refId] = { id, protocol, status, error, info, log: [{ id, dir, at, ... }], startedAt }
export const useRt = create(() => ({ sessions: {} }));

const setSession = (refId, fn) =>
  useRt.setState((s) => {
    const cur = s.sessions[refId];
    if (!cur) return {};
    return { sessions: { ...s.sessions, [refId]: { ...cur, ...fn(cur) } } };
  });

const pushLog = (refId, entry) => setSession(refId, (cur) => ({ log: [...cur.log, { id: uid(), at: Date.now(), ...entry }].slice(-MAX_LOG) }));

let socket = null;
let ready = null;
const byId = new Map(); // relay session id -> refId

function relayUrl() {
  const u = new URL('/api/realtime', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function failAll(error) {
  for (const [id, refId] of byId) {
    setSession(refId, (cur) => (cur.id === id ? { status: 'error', error } : {}));
  }
  byId.clear();
}

function connectRelay() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl());
    ws.onopen = () => {
      socket = ws;
      resolve(ws);
    };
    ws.onerror = () => {
      reject(new Error('Cannot reach the realtime relay. WebSocket, Socket.IO, MQTT and gRPC need the Node/Docker server (they are not available on Vercel).'));
    };
    ws.onclose = () => {
      socket = null;
      ready = null;
      failAll('Connection to the realtime relay closed');
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      const refId = byId.get(m.id);
      if (!refId) return;
      handle(refId, m);
    };
  });
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

function handle(refId, m) {
  switch (m.type) {
    case 'status':
      setSession(refId, () => ({ status: m.status, error: m.error || null, ...(m.info ? { info: m.info } : {}) }));
      if (m.status === 'error' || m.status === 'disconnected') {
        pushLog(refId, { dir: 'sys', text: m.status === 'error' ? `Error: ${m.error}` : `Disconnected${m.info?.code ? ` (code ${m.info.code}${m.info.reason ? `: ${m.info.reason}` : ''})` : ''}` });
        if (m.status === 'disconnected') byId.delete(m.id);
      } else if (m.status === 'connected') pushLog(refId, { dir: 'sys', text: 'Connected' });
      break;
    case 'message':
      pushLog(refId, { dir: 'in', at: m.at, data: m.data, binary: m.binary, event: m.event, args: m.args, topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, ack: m.ack });
      break;
    case 'grpc-message':
      pushLog(refId, { dir: 'in', at: m.at, message: m.message });
      break;
    case 'grpc-status':
      setSession(refId, () => ({ status: m.code === 0 ? 'done' : 'error', error: m.code === 0 ? null : `${m.codeName}: ${m.details}`, grpcStatus: m }));
      byId.delete(m.id);
      break;
    case 'error':
      pushLog(refId, { dir: 'sys', text: `Error: ${m.error}` });
      break;
    default:
  }
}

async function post(msg) {
  const ws = await connectRelay();
  ws.send(JSON.stringify(msg));
}

// Starts a session for a request tab, replacing any previous one.
export async function startSession(refId, protocol, frame, { keepLog = false } = {}) {
  stopSession(refId);
  const id = uid();
  useRt.setState((s) => ({
    sessions: {
      ...s.sessions,
      [refId]: { id, protocol, status: 'connecting', error: null, info: null, grpcStatus: null, startedAt: Date.now(), log: keepLog ? s.sessions[refId]?.log || [] : [] },
    },
  }));
  byId.set(id, refId);
  try {
    await post({ ...frame, id });
  } catch (e) {
    byId.delete(id);
    setSession(refId, () => ({ status: 'error', error: e.message }));
    pushLog(refId, { dir: 'sys', text: e.message });
  }
  return id;
}

// Sends a frame for the tab's session and logs it as outgoing.
export async function sendFrame(refId, frame, logEntry) {
  const s = useRt.getState().sessions[refId];
  if (!s) return;
  try {
    await post({ ...frame, id: s.id });
    if (logEntry) pushLog(refId, { dir: 'out', ...logEntry });
  } catch (e) {
    pushLog(refId, { dir: 'sys', text: e.message });
  }
}

export function stopSession(refId) {
  const s = useRt.getState().sessions[refId];
  if (!s || !byId.has(s.id)) return;
  const type = s.protocol === 'grpc' ? 'grpc-cancel' : 'disconnect';
  socket?.send(JSON.stringify({ type, id: s.id }));
  byId.delete(s.id);
  setSession(refId, () => ({ status: s.protocol === 'grpc' ? 'cancelled' : 'disconnected' }));
  if (s.protocol !== 'grpc') pushLog(refId, { dir: 'sys', text: 'Disconnected' });
}

// Adds an entry to a session's log without sending anything.
export const logLocal = (refId, entry) => pushLog(refId, entry);

export const clearLog = (refId) => setSession(refId, () => ({ log: [] }));

export async function describeGrpc(body) {
  const r = await fetch('/api/grpc/describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.services;
}
