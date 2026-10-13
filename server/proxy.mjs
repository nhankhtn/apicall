// Sends one HTTP request on behalf of the UI (via /api/proxy) or the CLI.
// Shared so both get identical TLS, proxy, redirect and multipart behavior.
import { Agent, ProxyAgent, fetch, FormData } from 'undici';
import { readStoredFile } from './files.mjs';
import { ntlmFetch } from './ntlm.mjs';

const SKIP_REQUEST_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);
const dispatchers = new Map();

const matchesHost = (pattern, host) => {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
  return host === p || host.endsWith(`.${p}`);
};

function dispatcherConfig(url, opts) {
  const host = url.hostname.toLowerCase();
  const verifySsl = opts.verifySsl !== false;
  const bypass = (opts.noProxy || '').split(',').some((p) => matchesHost(p, host));
  const proxyUrl = opts.proxyUrl && !bypass ? opts.proxyUrl : '';
  const cert = (opts.clientCerts || []).find((c) => c.host && matchesHost(c.host, host) && c.cert && c.key);
  const tls = { rejectUnauthorized: verifySsl };
  if (cert) Object.assign(tls, { cert: cert.cert, key: cert.key, passphrase: cert.passphrase || undefined });
  const key = JSON.stringify([verifySsl, proxyUrl, cert ? [cert.host, cert.cert.length, cert.key.length] : null]);
  return { key, proxyUrl, tls };
}

const createDispatcher = ({ proxyUrl, tls }, extra = {}) =>
  proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls: tls, ...extra }) : new Agent({ connect: tls, ...extra });

function dispatcherFor(url, opts) {
  const cfg = dispatcherConfig(url, opts);
  let d = dispatchers.get(cfg.key);
  if (!d) {
    d = createDispatcher(cfg);
    dispatchers.set(cfg.key, d);
  }
  return d;
}

// NTLM authenticates the connection, so the handshake gets its own single keep-alive socket.
const ntlmDispatcher = (url, opts) => createDispatcher(dispatcherConfig(url, opts), { connections: 1, pipelining: 1 });

function isTextual(contentType, buf) {
  if (/json|text|xml|javascript|html|x-www-form-urlencoded|csv|yaml|graphql/i.test(contentType)) return true;
  if (contentType) return false;
  return !buf.subarray(0, 1024).includes(0);
}

function describeError(err, timeoutMs) {
  if (err.name === 'TimeoutError') return `Request timed out after ${timeoutMs} ms`;
  const cause = err.cause;
  if (cause) return `${cause.code ? `${cause.code}: ` : ''}${cause.message || err.message}`;
  return err.message;
}

// File parts carry their bytes inline (base64, from the browser's IndexedDB). A fileId refers to
// the server-side store used by older workspaces.
async function fileContent(f, dataDir) {
  if (f.data != null) return { data: Buffer.from(f.data, 'base64'), type: f.contentType || 'application/octet-stream', name: f.fileName || 'file' };
  if (f.fileId) {
    const file = await readStoredFile(dataDir, f.fileId);
    return { data: file.data, type: file.meta.type || 'application/octet-stream', name: f.fileName || file.meta.name };
  }
  return null;
}

async function buildBody(b, method, headers, dataDir) {
  if (method === 'GET' || method === 'HEAD' || !b) return undefined;
  if (b.type === 'text') return b.text ?? '';
  if (b.type === 'urlencoded') {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    return new URLSearchParams((b.fields || []).map((f) => [f.key, f.value ?? ''])).toString();
  }
  if (b.type === 'formdata') {
    const fd = new FormData();
    for (const f of b.fields || []) {
      if (f.type === 'file') {
        const file = await fileContent(f, dataDir);
        if (file) fd.append(f.key, new Blob([file.data], { type: file.type }), file.name);
      } else fd.append(f.key, f.value ?? '');
    }
    headers.delete('content-type'); // fetch writes the multipart boundary itself
    return fd;
  }
  if (b.type === 'binary') {
    const file = await fileContent(b, dataDir);
    if (!file) return undefined;
    if (!headers.has('content-type')) headers.set('content-type', file.type);
    return file.data;
  }
  return undefined;
}

// spec: { method, url, headers:[{key,value}], body, timeoutMs, verifySsl, followRedirects, proxyUrl, noProxy, clientCerts,
//         ntlm: { username, password, domain, workstation } }
// Never throws: transport failures come back as { ok: false, error }.
export async function performRequest(spec, { dataDir }) {
  const method = String(spec.method || 'GET').toUpperCase();
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 120000;
  const started = performance.now();
  let dedicated = null;
  try {
    const url = new URL(spec.url);
    const headers = new Headers();
    for (const h of spec.headers || []) {
      if (!h?.key || SKIP_REQUEST_HEADERS.has(String(h.key).toLowerCase())) continue;
      headers.append(h.key, h.value == null ? '' : String(h.value));
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'ApiCallRunner/1.0');
    const body = await buildBody(spec.body, method, headers, dataDir);

    const init = {
      method,
      headers,
      body,
      redirect: spec.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (spec.ntlm) dedicated = ntlmDispatcher(url, spec);
    const r = dedicated
      ? await ntlmFetch(url, { ...init, dispatcher: dedicated }, spec.ntlm)
      : await fetch(url, { ...init, dispatcher: dispatcherFor(url, spec) });
    const headersAt = performance.now();
    const buf = Buffer.from(await r.arrayBuffer());
    const done = performance.now();

    const respHeaders = [];
    r.headers.forEach((value, key) => {
      if (key !== 'set-cookie') respHeaders.push({ key, value });
    });
    for (const c of r.headers.getSetCookie()) respHeaders.push({ key: 'set-cookie', value: c });
    const text = isTextual(r.headers.get('content-type') || '', buf);
    return {
      ok: true,
      status: r.status,
      statusText: r.statusText,
      headers: respHeaders,
      body: text ? buf.toString('utf8') : buf.toString('base64'),
      encoding: text ? 'utf8' : 'base64',
      size: buf.length,
      timeMs: Math.round(done - started),
      timings: { ttfb: Math.round(headersAt - started), download: Math.round(done - headersAt) },
      url: r.url || spec.url,
      redirected: r.redirected,
    };
  } catch (err) {
    return { ok: false, error: describeError(err, timeoutMs), timeMs: Math.round(performance.now() - started) };
  } finally {
    dedicated?.destroy().catch(() => {});
  }
}
