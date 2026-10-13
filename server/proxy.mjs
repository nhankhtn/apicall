// Sends one HTTP request on behalf of the UI (via /api/proxy) or the CLI.
// Shared so both get identical TLS, proxy, redirect and multipart behavior.
import { Agent, ProxyAgent, fetch, FormData } from 'undici';
import { readStoredFile } from './files.mjs';

const SKIP_REQUEST_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);
const dispatchers = new Map();

const matchesHost = (pattern, host) => {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
  return host === p || host.endsWith(`.${p}`);
};

function dispatcherFor(url, opts) {
  const host = url.hostname.toLowerCase();
  const verifySsl = opts.verifySsl !== false;
  const bypass = (opts.noProxy || '').split(',').some((p) => matchesHost(p, host));
  const proxyUrl = opts.proxyUrl && !bypass ? opts.proxyUrl : '';
  const cert = (opts.clientCerts || []).find((c) => c.host && matchesHost(c.host, host) && c.cert && c.key);
  const key = JSON.stringify([verifySsl, proxyUrl, cert ? [cert.host, cert.cert.length, cert.key.length] : null]);
  let d = dispatchers.get(key);
  if (!d) {
    const tls = { rejectUnauthorized: verifySsl };
    if (cert) Object.assign(tls, { cert: cert.cert, key: cert.key, passphrase: cert.passphrase || undefined });
    d = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls: tls }) : new Agent({ connect: tls });
    dispatchers.set(key, d);
  }
  return d;
}

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
        if (!f.fileId) continue;
        const file = await readStoredFile(dataDir, f.fileId);
        fd.append(f.key, new Blob([file.data], { type: file.meta.type || 'application/octet-stream' }), f.fileName || file.meta.name);
      } else fd.append(f.key, f.value ?? '');
    }
    headers.delete('content-type'); // fetch writes the multipart boundary itself
    return fd;
  }
  if (b.type === 'binary' && b.fileId) {
    const file = await readStoredFile(dataDir, b.fileId);
    if (!headers.has('content-type')) headers.set('content-type', file.meta.type || 'application/octet-stream');
    return file.data;
  }
  return undefined;
}

// spec: { method, url, headers:[{key,value}], body, timeoutMs, verifySsl, followRedirects, proxyUrl, noProxy, clientCerts }
// Never throws: transport failures come back as { ok: false, error }.
export async function performRequest(spec, { dataDir }) {
  const method = String(spec.method || 'GET').toUpperCase();
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 120000;
  const started = performance.now();
  try {
    const url = new URL(spec.url);
    const headers = new Headers();
    for (const h of spec.headers || []) {
      if (!h?.key || SKIP_REQUEST_HEADERS.has(String(h.key).toLowerCase())) continue;
      headers.append(h.key, h.value == null ? '' : String(h.value));
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'ApiCallRunner/1.0');
    const body = await buildBody(spec.body, method, headers, dataDir);

    const r = await fetch(url, {
      method,
      headers,
      body,
      redirect: spec.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherFor(url, spec),
    });
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
  }
}
