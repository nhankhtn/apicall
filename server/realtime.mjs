// Realtime relay: one browser WebSocket on /api/realtime multiplexes many upstream sessions
// (WebSocket, Socket.IO, MQTT, gRPC calls), each keyed by a client-chosen id. All frames are JSON.
// The browser can't open raw TCP, set handshake headers or speak MQTT/gRPC, so the server does.
import { isUtf8 } from 'node:buffer';
import WebSocket, { WebSocketServer } from 'ws';
import { io } from 'socket.io-client';
import mqtt from 'mqtt';
import { startCall } from './grpc.mjs';
import { checkAccess } from './auth.mjs';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const timeoutOf = (o) => (Number(o?.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS);

function headerObject(list) {
  const out = {};
  for (const h of list || []) {
    const key = String(h?.key || '').trim();
    if (!key) continue;
    const value = h.value == null ? '' : String(h.value);
    out[key] = out[key] ? `${out[key]}, ${value}` : value;
  }
  return out;
}

function headerPairs(rawHeaders) {
  const out = [];
  for (let i = 0; i + 1 < (rawHeaders || []).length; i += 2) out.push({ key: rawHeaders[i].toLowerCase(), value: rawHeaders[i + 1] });
  return out;
}

// Buffers inside Socket.IO args become base64 strings so they survive JSON.
function plain(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

// Common session lifecycle: connect timeout and a single terminal status.
function lifecycle(ctx, id, timeoutMs, closeUpstream) {
  let connected = false;
  let ended = false;
  const timer = setTimeout(() => fail(`Connection timed out after ${timeoutMs} ms`), timeoutMs);
  const end = (status, extra) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    ctx.send({ type: 'status', id, status, ...extra });
    ctx.drop();
    closeUpstream();
  };
  const fail = (error, info) => end('error', { error, ...(info ? { info } : {}) });
  return {
    get connected() {
      return connected;
    },
    get ended() {
      return ended;
    },
    open(info) {
      if (ended) return;
      connected = true;
      clearTimeout(timer);
      ctx.send({ type: 'status', id, status: 'connected', ...(info ? { info } : {}) });
    },
    closed: (info) => end('disconnected', info ? { info } : {}),
    fail,
    // Browser socket went away or the id was reused: close upstream without reporting.
    silence() {
      ended = true;
      clearTimeout(timer);
      closeUpstream();
    },
  };
}

function connectWebsocket(ctx, msg) {
  const o = msg.options || {};
  const timeoutMs = timeoutOf(o);
  const protocols = (o.subprotocols || []).map(String).filter(Boolean);
  const ws = new WebSocket(String(msg.url), protocols, {
    headers: headerObject(msg.headers),
    rejectUnauthorized: o.verifySsl !== false,
    handshakeTimeout: timeoutMs,
    maxPayload: MAX_FRAME_BYTES,
  });
  let handshake = null;
  const life = lifecycle(ctx, msg.id, timeoutMs, () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  });

  ws.on('upgrade', (res) => (handshake = { status: res.statusCode, headers: headerPairs(res.rawHeaders) }));
  ws.on('unexpected-response', (req, res) => {
    life.fail(`Unexpected server response: ${res.statusCode}`, { status: res.statusCode, headers: headerPairs(res.rawHeaders) });
    req.destroy();
  });
  ws.on('open', () => life.open({ ...handshake, protocol: ws.protocol }));
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    ctx.send({ type: 'message', id: msg.id, at: Date.now(), direction: 'in', data: isBinary ? buf.toString('base64') : buf.toString('utf8'), binary: isBinary });
  });
  ws.on('error', (err) => {
    if (life.ended) return;
    console.error(`connectWebsocket.WebSocket: url=${msg.url}: ${err.message}`);
    life.fail(err.message);
  });
  ws.on('close', (code, reason) => life.closed({ code, reason: reason.toString('utf8') }));

  return {
    life,
    send(frame) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
      ws.send(frame.binary ? Buffer.from(String(frame.data ?? ''), 'base64') : String(frame.data ?? ''), { binary: !!frame.binary });
    },
    disconnect: () => (life.connected ? ws.close(1000) : life.closed()),
  };
}

function connectSocketio(ctx, msg) {
  const o = msg.options || {};
  const timeoutMs = timeoutOf(o);
  if (o.version === 'v2') {
    ctx.send({ type: 'status', id: msg.id, status: 'error', error: 'Socket.IO v2 servers are not supported (they need the v2 client protocol); use a v3 or v4 server' });
    return null;
  }
  const socket = io(String(msg.url), {
    path: o.path || '/socket.io',
    auth: o.auth || {},
    query: o.query || {},
    extraHeaders: headerObject(msg.headers),
    rejectUnauthorized: o.verifySsl !== false,
    reconnection: false,
    forceNew: true,
    timeout: timeoutMs,
  });
  const listening = new Set((o.events || []).map(String).filter(Boolean));
  const life = lifecycle(ctx, msg.id, timeoutMs, () => socket.disconnect());

  socket.on('connect', () => life.open({ sid: socket.id }));
  socket.on('connect_error', (err) => {
    if (life.ended) return;
    console.error(`connectSocketio.connect_error: url=${msg.url}: ${err.message}`);
    life.fail(err.message);
  });
  socket.on('disconnect', (reason) => life.closed({ reason }));
  socket.onAny((event, ...args) => {
    if (!listening.has('*') && !listening.has(event)) return;
    ctx.send({ type: 'message', id: msg.id, at: Date.now(), direction: 'in', event, args: plain(args) });
  });

  return {
    life,
    emit(frame) {
      if (!socket.connected) throw new Error('Not connected');
      const event = String(frame.event || '');
      if (!event) throw new Error('Event name is required');
      const args = Array.isArray(frame.args) ? frame.args : [];
      if (!frame.ack) return void socket.emit(event, ...args);
      socket.timeout(timeoutMs).emit(event, ...args, (err, ...resp) => {
        if (err) return ctx.send({ type: 'error', id: msg.id, error: `No ack for '${event}' within ${timeoutMs} ms` });
        ctx.send({ type: 'message', id: msg.id, at: Date.now(), direction: 'in', event, args: plain(resp), ack: true });
      });
    },
    listen: (frame) => listening.add(String(frame.event || '*')),
    unlisten: (frame) => listening.delete(String(frame.event || '*')),
    disconnect: () => (life.connected ? socket.disconnect() : life.closed()),
  };
}

function connectMqtt(ctx, msg) {
  const o = msg.options || {};
  const timeoutMs = timeoutOf(o);
  const verify = o.verifySsl !== false;
  const will = o.will?.topic
    ? { topic: String(o.will.topic), payload: String(o.will.payload ?? ''), qos: Number(o.will.qos) || 0, retain: !!o.will.retain }
    : undefined;
  const client = mqtt.connect(String(msg.url), {
    clientId: o.clientId || `apicall_${Math.random().toString(16).slice(2, 10)}`,
    username: o.username || undefined,
    password: o.password || undefined,
    clean: o.clean !== false,
    keepalive: Number.isFinite(Number(o.keepalive)) ? Number(o.keepalive) : 60,
    protocolVersion: Number(o.protocolVersion) === 5 ? 5 : 4,
    will,
    rejectUnauthorized: verify,
    connectTimeout: timeoutMs,
    reconnectPeriod: 0,
    wsOptions: { headers: headerObject(msg.headers), rejectUnauthorized: verify },
  });
  const life = lifecycle(ctx, msg.id, timeoutMs, () => client.end(true));

  client.on('connect', (connack) => life.open({ sessionPresent: !!connack?.sessionPresent }));
  client.on('error', (err) => {
    if (life.ended) return;
    console.error(`connectMqtt.connect: url=${msg.url}: ${err.message}`);
    if (!life.connected) life.fail(err.message);
    else ctx.send({ type: 'error', id: msg.id, error: err.message });
  });
  client.on('close', () => (life.connected ? life.closed() : life.fail('Connection closed before CONNACK')));
  client.on('message', (topic, payload, packet) => {
    const text = isUtf8(payload);
    ctx.send({
      type: 'message',
      id: msg.id,
      at: Date.now(),
      direction: 'in',
      topic,
      payload: text ? payload.toString('utf8') : payload.toString('base64'),
      binary: !text,
      qos: packet.qos,
      retain: !!packet.retain,
    });
  });

  const requireConnected = () => {
    if (!client.connected) throw new Error('Not connected');
  };
  const report = (what) => (err) => {
    if (err) ctx.send({ type: 'error', id: msg.id, error: `${what}: ${err.message}` });
  };
  return {
    life,
    subscribe(frame) {
      requireConnected();
      const topic = String(frame.topic || '');
      client.subscribe(topic, { qos: Number(frame.qos) || 0 }, (err, granted) => {
        if (err) return report(`Subscribe ${topic}`)(err);
        if (granted?.some((g) => g.qos >= 128)) ctx.send({ type: 'error', id: msg.id, error: `Subscribe ${topic}: refused by broker` });
      });
    },
    unsubscribe(frame) {
      requireConnected();
      const topic = String(frame.topic || '');
      client.unsubscribe(topic, report(`Unsubscribe ${topic}`));
    },
    publish(frame) {
      requireConnected();
      const topic = String(frame.topic || '');
      const payload = frame.binary ? Buffer.from(String(frame.payload ?? ''), 'base64') : String(frame.payload ?? '');
      client.publish(topic, payload, { qos: Number(frame.qos) || 0, retain: !!frame.retain }, report(`Publish ${topic}`));
    },
    disconnect: () => (life.connected ? client.end(false) : life.closed()),
  };
}

function callGrpc(ctx, msg) {
  let silenced = false;
  const call = startCall(msg, {
    onMessage: (message) => !silenced && ctx.send({ type: 'grpc-message', id: msg.id, at: Date.now(), message }),
    onStatus: (status) => {
      if (!silenced) ctx.send({ type: 'grpc-status', id: msg.id, ...status });
      ctx.drop();
    },
  });
  return {
    life: {
      silence() {
        silenced = true;
        call.cancel();
      },
    },
    'grpc-write': (frame) => call.write(frame.message),
    'grpc-end': () => call.end(),
    'grpc-cancel': () => call.cancel(),
    disconnect: () => call.cancel(),
  };
}

const CONNECTORS = { websocket: connectWebsocket, socketio: connectSocketio, mqtt: connectMqtt };

function handleConnection(browser) {
  const sessions = new Map();
  const send = (frame) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(frame));
  };
  // Each session gets its own ctx: once it has ended or been replaced (same id reconnecting) it
  // can neither send frames nor remove its successor.
  const ctxFor = (id, slot) => ({
    send: (frame) => sessions.get(id) === slot && send(frame),
    drop: () => sessions.get(id) === slot && sessions.delete(id),
  });

  const start = (msg, ctx) => {
    if (msg.type === 'grpc-call') return callGrpc(ctx, msg);
    const connector = CONNECTORS[msg.protocol];
    if (!connector) throw new Error(`Unknown protocol: ${msg.protocol}`);
    send({ type: 'status', id: msg.id, status: 'connecting' });
    if (!msg.url) {
      send({ type: 'status', id: msg.id, status: 'error', error: 'URL is required' });
      return null;
    }
    try {
      return connector(ctx, msg);
    } catch (err) {
      send({ type: 'status', id: msg.id, status: 'error', error: err.message });
      return null;
    }
  };

  const handle = (msg) => {
    if (msg.type === 'connect' || msg.type === 'grpc-call') {
      const old = sessions.get(msg.id);
      sessions.delete(msg.id);
      old?.life?.silence();
      // Registered before the connector runs, so callbacks that end the session can drop it.
      const slot = {};
      sessions.set(msg.id, slot);
      let session = null;
      try {
        session = start(msg, ctxFor(msg.id, slot));
      } finally {
        if (session) Object.assign(slot, session);
        else if (sessions.get(msg.id) === slot) sessions.delete(msg.id);
      }
      return;
    }
    const session = sessions.get(msg.id);
    if (!session) throw new Error(`No open session with id ${msg.id}`);
    const op = session[msg.type];
    if (typeof op !== 'function') throw new Error(`'${msg.type}' is not supported for this session`);
    op(msg);
  };

  browser.on('message', (raw, isBinary) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return send({ type: 'error', id: null, error: 'Frame is not valid JSON' });
    }
    if (isBinary || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return send({ type: 'error', id: msg?.id ?? null, error: 'Frame must be a JSON object with a type' });
    if (typeof msg.id !== 'string' || !msg.id) return send({ type: 'error', id: null, error: 'Frame needs a non-empty string id' });
    try {
      handle(msg);
    } catch (err) {
      send({ type: 'error', id: msg.id, error: err.message });
    }
  });
  browser.on('close', () => {
    for (const session of sessions.values()) session.life?.silence();
    sessions.clear();
  });
  browser.on('error', (err) => console.error(`handleConnection.WebSocket: ${err.message}`));
}

// Browsers send Origin on WebSocket handshakes and CORS doesn't apply, so refuse other sites;
// otherwise any page could use this relay to reach the local network.
export function attachRealtime(server, { path = '/api/realtime' } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  wss.on('connection', handleConnection);
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    // Same policy as the HTTP API: allowed host, login when enabled, same-origin pages only.
    const denied = checkAccess(req);
    if (denied) {
      const extra = Object.entries(denied.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.end(`HTTP/1.1 ${denied.status} ${denied.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n${extra}Connection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return wss;
}
