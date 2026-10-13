// gRPC support for the realtime relay and POST /api/grpc/describe.
// Definitions come from user-supplied .proto files or from server reflection (v1, then v1alpha),
// are loaded into a protobufjs Root and cached, and calls go through @grpc/grpc-js with
// protobufjs doing the (de)serialization, so no generated code is needed.
import crypto from 'node:crypto';
import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor.js';

const DEFAULT_TIMEOUT_MS = 20000;
const EXAMPLE_DEPTH = 6;
const CACHE_LIMIT = 32;
const REFLECTION_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const TO_OBJECT = { longs: String, enums: String, bytes: String, defaults: true, arrays: true, objects: true, json: true };
const CODE_NAMES = Object.fromEntries(Object.entries(grpc.status).map(([name, code]) => [code, name]));

const REFLECTION_PROTO = `
syntax = "proto3";
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}
message ExtensionRequest { string containing_type = 1; int32 extension_number = 2; }
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse { string base_type_name = 1; repeated int32 extension_number = 2; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;
const reflectionRoot = protobuf.parse(REFLECTION_PROTO, { keepCase: true }).root;
const ReflectionRequest = reflectionRoot.lookupType('ServerReflectionRequest');
const ReflectionResponse = reflectionRoot.lookupType('ServerReflectionResponse');
const REFLECTION_PATHS = [
  '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
  '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
];

const cache = new Map();

class GrpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires && entry.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
  value.catch(() => cache.delete(key));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

// Accepts host:port, or a grpc(s):// / http(s):// URL, which also decides TLS.
function parseTarget(spec) {
  let target = String(spec.target || '').trim();
  let tls = !!spec.tls;
  const m = target.match(/^(grpcs?|https?):\/\//i);
  if (m) {
    tls = /s$/i.test(m[1]);
    target = target.slice(m[0].length).replace(/\/+$/, '');
  }
  if (!target) throw new GrpcError(grpc.status.INVALID_ARGUMENT, 'Target is required');
  return { target, tls };
}

function createClient(spec) {
  const { target, tls } = parseTarget(spec);
  const creds = tls
    ? grpc.credentials.createSsl(null, null, null, spec.verifySsl === false ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : {})
    : grpc.credentials.createInsecure();
  return new grpc.Client(target, creds, {
    'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
    'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
  });
}

function toMetadata(list) {
  const md = new grpc.Metadata();
  for (const h of list || []) {
    const key = String(h?.key || '').trim().toLowerCase();
    if (!key) continue;
    const value = h.value == null ? '' : String(h.value);
    md.add(key, key.endsWith('-bin') ? Buffer.from(value, 'base64') : value);
  }
  return md;
}

function fromMetadata(md) {
  const out = [];
  if (!md) return out;
  for (const [key, values] of Object.entries(md.toJSON())) {
    for (const v of values) out.push({ key, value: Buffer.isBuffer(v) ? v.toString('base64') : String(v) });
  }
  return out;
}

// ---- Definitions from .proto files ----

function resolveImport(files, origin, target) {
  const name = target.replace(/^\.\//, '');
  if (Object.hasOwn(files, name)) return name;
  if (origin) {
    const rel = path.posix.join(path.posix.dirname(origin), name);
    if (Object.hasOwn(files, rel)) return rel;
  }
  const base = path.posix.basename(name);
  const byBase = Object.keys(files).filter((k) => path.posix.basename(k) === base);
  return byBase.length === 1 ? byBase[0] : name;
}

async function loadProtoFiles(files) {
  const names = Object.keys(files);
  if (!names.length) throw new GrpcError(grpc.status.INVALID_ARGUMENT, 'No proto files given');
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => resolveImport(files, origin, target);
  // Answer asynchronously: Root.load counts pending files and finishes early on a synchronous reply.
  root.fetch = (name, cb) =>
    setImmediate(() => {
      if (Object.hasOwn(files, name)) cb(null, String(files[name] ?? ''));
      else cb(new Error(`Imported file not found: ${name}`));
    });
  try {
    await root.load(names, { keepCase: true });
  } catch (err) {
    throw new GrpcError(grpc.status.INVALID_ARGUMENT, `Proto: ${err.message}`);
  }
  return root;
}

// ---- Definitions from server reflection ----

// One bidi stream; requests are answered in order, so each ask() takes the next response.
function openReflection(client, streamPath, metadata, deadline) {
  const call = client.makeBidiStreamRequest(
    streamPath,
    (msg) => Buffer.from(ReflectionRequest.encode(ReflectionRequest.fromObject(msg)).finish()),
    (buf) => ReflectionResponse.decode(buf),
    metadata,
    { deadline },
  );
  const waiting = [];
  let failure = null;
  const fail = (err) => {
    failure = failure || err;
    while (waiting.length) waiting.shift().reject(failure);
  };
  call.on('data', (res) => waiting.shift()?.resolve(res));
  call.on('error', fail);
  call.on('end', () => fail(new GrpcError(grpc.status.UNAVAILABLE, 'Reflection stream ended')));
  const ask = (req) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting.push({ resolve, reject });
      call.write(req);
    });
  return { ask, close: () => call.cancel() };
}

function reflectionError(res) {
  const e = res.error_response;
  return e ? new GrpcError(e.error_code || grpc.status.UNKNOWN, e.error_message || 'Reflection error') : null;
}

async function fetchDescriptors(stream) {
  const list = await stream.ask({ list_services: '' });
  const listErr = reflectionError(list);
  if (listErr) throw listErr;
  const services = (list.list_services_response?.service || []).map((s) => s.name).filter((n) => !n.startsWith('grpc.reflection.'));
  const files = new Map();
  const take = (res) => {
    const err = reflectionError(res);
    if (err) throw err;
    for (const bytes of res.file_descriptor_response?.file_descriptor_proto || []) {
      const fd = descriptor.FileDescriptorProto.decode(bytes);
      if (!files.has(fd.name)) files.set(fd.name, fd);
    }
  };
  for (const name of services) take(await stream.ask({ file_containing_symbol: name }));
  // Servers usually send the transitive closure, but fetch any dependency that is still missing.
  const missing = () => [...files.values()].flatMap((fd) => fd.dependency || []).filter((d) => !files.has(d));
  for (let todo = missing(); todo.length; todo = missing()) {
    for (const dep of new Set(todo)) {
      try {
        take(await stream.ask({ file_by_filename: dep }));
      } catch (err) {
        if (err.code !== grpc.status.NOT_FOUND || !protobuf.common.get(dep)) throw err;
      }
      if (!files.has(dep)) files.set(dep, wellKnownDescriptor(dep));
    }
  }
  return { services, files: [...files.values()] };
}

// Descriptor for a google/protobuf/*.proto the server did not provide, from protobufjs' bundled copy.
function wellKnownDescriptor(name) {
  const json = protobuf.common.get(name);
  if (!json) throw new GrpcError(grpc.status.NOT_FOUND, `Dependency not found: ${name}`);
  const fd = protobuf.Root.fromJSON(json).toDescriptor('proto3').file[0];
  fd.name = name;
  return fd;
}

async function loadReflection(spec) {
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const client = createClient(spec);
  try {
    let lastErr;
    for (const streamPath of REFLECTION_PATHS) {
      const stream = openReflection(client, streamPath, toMetadata(spec.metadata), Date.now() + timeoutMs);
      try {
        const { services, files } = await fetchDescriptors(stream);
        const root = protobuf.Root.fromDescriptor({ file: files }, { keepCase: true });
        root.reflectedServices = services;
        return root;
      } catch (err) {
        lastErr = err;
        if (err.code !== grpc.status.UNIMPLEMENTED) break;
      } finally {
        stream.close();
      }
    }
    throw new GrpcError(lastErr.code ?? grpc.status.UNKNOWN, `Reflection: ${lastErr.details || lastErr.message}`);
  } finally {
    client.close();
  }
}

// ---- Shared loading, cached by proto content or by target ----

function definitionKey(spec) {
  if (spec.reflection) {
    const { target, tls } = parseTarget(spec);
    return `reflect:${JSON.stringify([target, tls, spec.verifySsl !== false])}`;
  }
  const files = spec.proto?.files || {};
  const hash = crypto.createHash('sha256').update(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]))).digest('hex');
  return `proto:${hash}`;
}

// fresh: describe always re-reads reflection, calls reuse what describe loaded.
function loadDefinition(spec, { fresh = false } = {}) {
  const key = definitionKey(spec);
  const cached = !fresh && cacheGet(key);
  if (cached) return cached;
  if (spec.reflection) return cacheSet(key, loadReflection(spec), REFLECTION_TTL_MS);
  if (!spec.proto?.files) return Promise.reject(new GrpcError(grpc.status.INVALID_ARGUMENT, 'Proto files are required when reflection is off'));
  return cacheSet(key, loadProtoFiles(spec.proto.files), 0);
}

function allServices(ns, out = []) {
  for (const nested of ns.nestedArray) {
    if (nested instanceof protobuf.Service) out.push(nested);
    else if (nested instanceof protobuf.Namespace) allServices(nested, out);
  }
  return out;
}

const fullName = (t) => t.fullName.replace(/^\./, '');

function sampleScalar(type) {
  if (type === 'string' || type === 'bytes') return '';
  if (type === 'bool') return false;
  return 0;
}

function sampleValue(field, depth) {
  const t = field.resolvedType;
  if (t instanceof protobuf.Enum) return Object.keys(t.values)[0] ?? 0;
  if (t instanceof protobuf.Type) return depth >= EXAMPLE_DEPTH ? {} : requestExample(t, depth + 1);
  return sampleScalar(field.type);
}

// Every field filled with a sample; only the first member of each oneof, since setting all of
// them would send just the last one.
function requestExample(type, depth = 0) {
  const skip = new Set();
  for (const oneof of type.oneofsArray) for (const f of oneof.fieldsArray.slice(1)) skip.add(f.name);
  const out = {};
  for (const field of type.fieldsArray) {
    if (skip.has(field.name)) continue;
    field.resolve();
    if (field.map) out[field.name] = { [field.keyType === 'string' ? 'key' : String(sampleScalar(field.keyType))]: sampleValue(field, depth) };
    else if (field.repeated) out[field.name] = [sampleValue(field, depth)];
    else out[field.name] = sampleValue(field, depth);
  }
  return out;
}

function describeRoot(root) {
  let services = allServices(root);
  if (root.reflectedServices) services = services.filter((s) => root.reflectedServices.includes(fullName(s)));
  return services.map((svc) => ({
    name: fullName(svc),
    methods: svc.methodsArray.map((m) => {
      m.resolve();
      return {
        name: m.name,
        requestStream: !!m.requestStream,
        responseStream: !!m.responseStream,
        requestType: fullName(m.resolvedRequestType),
        responseType: fullName(m.resolvedResponseType),
        requestExample: requestExample(m.resolvedRequestType),
      };
    }),
  }));
}

// spec: { target, tls, verifySsl, proto:{files}|null, reflection, metadata }
// Never throws: failures come back as { ok: false, error }.
export async function describe(spec) {
  try {
    const root = await loadDefinition(spec || {}, { fresh: true });
    return { ok: true, services: describeRoot(root) };
  } catch (err) {
    console.error(`describe.loadDefinition: target=${spec?.target}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function findMethod(root, serviceName, methodName) {
  let svc;
  try {
    svc = root.lookupService(String(serviceName || ''));
  } catch {
    throw new GrpcError(grpc.status.UNIMPLEMENTED, `Service not found: ${serviceName}`);
  }
  const method = svc.methods[methodName];
  if (!method) throw new GrpcError(grpc.status.UNIMPLEMENTED, `Method not found: ${serviceName}/${methodName}`);
  method.resolve();
  return { svc, method };
}

function toRequest(Type, message) {
  try {
    return Type.fromObject(message || {});
  } catch (err) {
    throw new GrpcError(grpc.status.INVALID_ARGUMENT, `Request message: ${err.message}`);
  }
}

// spec: the grpc-call frame. handlers: { onMessage(obj), onStatus(statusFrameFields) }.
// Returns { write(message), end(), cancel() }; onStatus is called exactly once.
export function startCall(spec, { onMessage, onStatus }) {
  const started = performance.now();
  let call = null;
  let client = null;
  let finished = false;
  let cancelled = false;
  let headers = [];
  const pending = [];

  const finish = (code, details, trailers) => {
    if (finished) return;
    finished = true;
    client?.close();
    onStatus({
      code,
      codeName: CODE_NAMES[code] || 'UNKNOWN',
      details: details || '',
      metadata: headers,
      trailers: fromMetadata(trailers),
      timeMs: Math.round(performance.now() - started),
    });
  };

  const run = async () => {
    const root = await loadDefinition(spec);
    if (cancelled) return finish(grpc.status.CANCELLED, 'Cancelled before start');
    const { svc, method } = findMethod(root, spec.service, spec.method);
    const Req = method.resolvedRequestType;
    const Res = method.resolvedResponseType;
    const methodPath = `/${fullName(svc)}/${method.name}`;
    const serialize = (msg) => Buffer.from(Req.encode(msg).finish());
    const deserialize = (buf) => Res.decode(buf);
    const metadata = toMetadata(spec.metadata);
    const options = Number(spec.deadlineMs) > 0 ? { deadline: Date.now() + Number(spec.deadlineMs) } : {};
    const emitMessage = (msg) => onMessage(Res.toObject(msg, TO_OBJECT));
    const first = spec.message == null ? null : toRequest(Req, spec.message);
    client = createClient(spec);

    if (!method.requestStream && !method.responseStream) {
      call = client.makeUnaryRequest(methodPath, serialize, deserialize, first || Req.create(), metadata, options, (err, res) => {
        if (!err && res) emitMessage(res);
      });
    } else if (!method.requestStream) {
      call = client.makeServerStreamRequest(methodPath, serialize, deserialize, first || Req.create(), metadata, options);
      call.on('data', emitMessage);
      call.on('error', () => {});
    } else if (!method.responseStream) {
      call = client.makeClientStreamRequest(methodPath, serialize, deserialize, metadata, options, (err, res) => {
        if (!err && res) emitMessage(res);
      });
    } else {
      call = client.makeBidiStreamRequest(methodPath, serialize, deserialize, metadata, options);
      call.on('data', emitMessage);
      call.on('error', () => {});
    }
    call.on('metadata', (md) => (headers = fromMetadata(md)));
    call.on('status', (s) => finish(s.code, s.details, s.metadata));
    call.requestType = Req;
    if (method.requestStream) {
      if (first) call.write(first);
      for (const op of pending.splice(0)) {
        try {
          op();
        } catch (err) {
          console.error(`startCall.write: method=${spec.service}/${spec.method}: ${err.message}`);
        }
      }
    }
  };

  run().catch((err) => {
    console.error(`startCall.run: target=${spec.target}, method=${spec.service}/${spec.method}: ${err.message}`);
    finish(typeof err.code === 'number' ? err.code : grpc.status.UNKNOWN, err.details || err.message);
  });

  const streaming = () => {
    if (call && typeof call.write === 'function') return true;
    throw new Error('This call does not accept streamed messages');
  };
  return {
    write(message) {
      if (finished) throw new Error('Call already finished');
      if (!call) return void pending.push(() => this.write(message));
      streaming();
      call.write(toRequest(call.requestType, message));
    },
    end() {
      if (finished) return;
      if (!call) return void pending.push(() => this.end());
      streaming();
      call.end();
    },
    cancel() {
      if (finished) return;
      cancelled = true;
      call?.cancel();
    },
  };
}
