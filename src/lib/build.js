// Turns an editable request (after pre-request scripts) into the exact spec sent to the proxy.
import { eqi } from './util.js';
import { unresolvedIn } from './vars.js';
import { awsSigV4, signJwt } from './authsign.js';
import { cookiesFor, cookieHeader } from './cookies.js';

const RAW_CONTENT_TYPE = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
};

export const ensureProtocol = (u) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`);
const hasHeader = (list, k) => list.some((x) => eqi(x.key, k));
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// ---------- URL helpers (raw strings, so {{vars}} survive edits) ----------

export function splitUrl(raw) {
  const hashAt = raw.indexOf('#');
  const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const q = noHash.indexOf('?');
  const base = q >= 0 ? noHash.slice(0, q) : noHash;
  const query = q >= 0 ? noHash.slice(q + 1) : '';
  const params = query
    ? query.split('&').map((p) => {
        const i = p.indexOf('=');
        return i < 0 ? { key: p, value: null } : { key: p.slice(0, i), value: p.slice(i + 1) };
      })
    : [];
  return { base, params, hash };
}

export const parseQuery = (raw) => splitUrl(raw).params.map((p) => ({ key: p.key, value: p.value ?? '', enabled: true }));

export function withQuery(raw, params) {
  const { base, hash } = splitUrl(raw);
  const q = params.filter((p) => p.key || p.value).map((p) => (p.value == null ? p.key : `${p.key}=${p.value}`));
  return `${base}${q.length ? `?${q.join('&')}` : ''}${hash}`;
}

// Path part of a raw URL, skipping the scheme and host (which may itself be a {{var}}).
function pathStart(base) {
  const scheme = base.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  const from = scheme ? scheme[0].length : 0;
  const slash = base.indexOf('/', from);
  return slash < 0 ? base.length : slash;
}

// Names of `/:name` path variables in a raw URL, in order.
export function pathVarNames(raw) {
  const { base } = splitUrl(raw);
  const path = base.slice(pathStart(base));
  return [...path.matchAll(/\/:([A-Za-z_][\w.-]*)/g)].map((m) => m[1]);
}

// Keeps the path-variable table in step with the URL, preserving values that still apply.
export function syncPathVars(raw, current = []) {
  return pathVarNames(raw).map((key) => current.find((v) => v.key === key) || { key, value: '', description: '' });
}

function applyPathVars(raw, pathVars) {
  if (!pathVars?.length) return raw;
  const { base } = splitUrl(raw);
  const at = pathStart(base);
  const path = base.slice(at).replace(/\/:([A-Za-z_][\w.-]*)/g, (m, name) => {
    const v = pathVars.find((p) => p.key === name);
    return v && v.value !== '' ? `/${v.value}` : m;
  });
  return base.slice(0, at) + path + raw.slice(base.length);
}

// ---------- Body ----------

function buildBody(draft, R, headers) {
  const b = draft.body || { mode: 'none' };
  if (draft.method === 'GET' || draft.method === 'HEAD') return { body: { type: 'none' }, bodyText: '' };
  const setType = (t) => !hasHeader(headers, 'content-type') && t && headers.push({ key: 'Content-Type', value: t });
  switch (b.mode) {
    case 'raw': {
      const text = R(b.raw);
      setType(RAW_CONTENT_TYPE[b.rawLang]);
      return { body: { type: 'text', text }, bodyText: text };
    }
    case 'graphql': {
      let variables;
      const raw = R(b.graphql?.variables || '').trim();
      if (raw) {
        try {
          variables = JSON.parse(raw);
        } catch (e) {
          throw new Error(`GraphQL variables are not valid JSON: ${e.message}`);
        }
      }
      const text = JSON.stringify({ query: R(b.graphql?.query || ''), ...(variables ? { variables } : {}) });
      setType('application/json');
      return { body: { type: 'text', text }, bodyText: text };
    }
    case 'urlencoded': {
      const fields = (b.urlencoded || []).filter((f) => f.enabled !== false && f.key).map((f) => ({ key: R(f.key), value: R(f.value) }));
      return { body: { type: 'urlencoded', fields }, bodyText: fields.map((f) => `${f.key}=${f.value}`).join('&') };
    }
    case 'formdata': {
      const fields = (b.formdata || [])
        .filter((f) => f.enabled !== false && f.key)
        .map((f) =>
          f.type === 'file'
            ? { key: R(f.key), type: 'file', fileId: f.fileId, fileName: f.fileName }
            : { key: R(f.key), type: 'text', value: R(f.value) },
        );
      const bodyText = fields.map((f) => (f.type === 'file' ? `${f.key}=@${f.fileName || '(no file)'}` : `${f.key}=${f.value}`)).join('\n');
      return { body: { type: 'formdata', fields }, bodyText };
    }
    case 'binary':
      return b.binary?.fileId
        ? { body: { type: 'binary', fileId: b.binary.fileId, fileName: b.binary.fileName }, bodyText: `<binary file ${b.binary.fileName}>` }
        : { body: { type: 'none' }, bodyText: '' };
    default:
      return { body: { type: 'none' }, bodyText: '' };
  }
}

// ---------- Auth ----------

async function applyAuth(a, spec, R, ctx) {
  const headers = spec.headers;
  const addQuery = (k, v) => (spec.url = withQuery(spec.url, [...parseQuery(spec.url), { key: encodeURIComponent(k), value: encodeURIComponent(v) }]));
  const setAuthorization = (value) => !hasHeader(headers, 'authorization') && headers.push({ key: 'Authorization', value });
  switch (a?.type) {
    case 'bearer':
      return setAuthorization(`Bearer ${R(a.bearer?.token)}`);
    case 'basic':
      return setAuthorization(`Basic ${b64(`${R(a.basic?.username)}:${R(a.basic?.password)}`)}`);
    case 'apikey': {
      if (!a.apikey?.key) return undefined;
      const k = R(a.apikey.key);
      const v = R(a.apikey.value);
      if (a.apikey.in === 'query') return addQuery(k, v);
      return !hasHeader(headers, k) && headers.push({ key: k, value: v });
    }
    case 'oauth2': {
      const o = a.oauth2 || {};
      const token = R(o.accessToken) || ctx.oauth2Token || '';
      if (!token) return undefined;
      if (o.addTo === 'query') return addQuery('access_token', token);
      return setAuthorization(`${o.headerPrefix ?? 'Bearer'} ${token}`.trim());
    }
    case 'jwt': {
      const j = a.jwt || {};
      const token = await signJwt({
        algorithm: j.algorithm || 'HS256',
        secret: R(j.secret),
        privateKey: R(j.privateKey),
        secretBase64: !!j.secretBase64,
        payload: R(j.payload || '{}'),
        header: j.header ? JSON.parse(R(j.header)) : {},
      });
      if (j.addTo === 'query') return addQuery(j.queryParamKey || 'token', token);
      return setAuthorization(`${j.headerPrefix ?? 'Bearer'} ${token}`.trim());
    }
    case 'awsv4': {
      const c = a.awsv4 || {};
      const signed = awsSigV4(spec, {
        accessKey: R(c.accessKey),
        secretKey: R(c.secretKey),
        sessionToken: R(c.sessionToken),
        region: R(c.region) || 'us-east-1',
        service: R(c.service) || 'execute-api',
      });
      for (const h of signed) {
        spec.headers = spec.headers.filter((x) => !eqi(x.key, h.key));
        spec.headers.push(h);
      }
      return undefined;
    }
    default:
      return undefined; // noauth, digest (handled as a challenge/retry by the engine), unsupported
  }
}

// draft: { method, url, pathVars, headers, body, auth (effective), settings }
// ctx:   { settings (workspace defaults), cookies (jar), oauth2Token }
export async function buildRequest(draft, vars, ctx = {}) {
  const R = (s) => vars.replaceIn(s);
  const spec = {
    method: draft.method,
    url: ensureProtocol(R(applyPathVars(draft.url, draft.pathVars)).trim()),
    headers: (draft.headers || []).filter((x) => x.enabled !== false && x.key).map((x) => ({ key: R(x.key), value: R(x.value) })),
  };
  const { body, bodyText } = buildBody(draft, R, spec.headers);
  spec.body = body;
  await applyAuth(draft.auth, spec, R, ctx);

  const settings = { ...(ctx.settings || {}), ...(draft.settings || {}) };
  if (settings.cookieJar !== false && ctx.cookies?.length) {
    try {
      const jarCookies = cookiesFor(ctx.cookies, spec.url);
      if (jarCookies.length) {
        const existing = spec.headers.find((x) => eqi(x.key, 'cookie'));
        if (existing) {
          const names = new Set(existing.value.split(';').map((p) => p.split('=')[0].trim()));
          const extra = jarCookies.filter((c) => !names.has(c.name));
          if (extra.length) existing.value = `${existing.value}; ${cookieHeader(extra)}`;
        } else spec.headers.push({ key: 'Cookie', value: cookieHeader(jarCookies) });
      }
    } catch {
      /* invalid URL: the transport will report it */
    }
  }
  Object.assign(spec, {
    timeoutMs: settings.timeoutMs,
    verifySsl: settings.verifySsl,
    followRedirects: settings.followRedirects,
    proxyUrl: settings.proxyUrl,
    noProxy: settings.noProxy,
    clientCerts: settings.clientCerts,
  });

  const unresolved = [...new Set([spec.url, bodyText, ...spec.headers.flatMap((x) => [x.key, x.value])].flatMap(unresolvedIn))];
  return { spec, bodyText, unresolved, digest: draft.auth?.type === 'digest' ? draft.auth.digest : null };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function toCurl({ spec, bodyText }) {
  const parts = [`curl -X ${spec.method} ${shq(spec.url)}`];
  for (const x of spec.headers) parts.push(`-H ${shq(`${x.key}: ${x.value}`)}`);
  if (spec.body.type === 'text') parts.push(`--data-raw ${shq(bodyText)}`);
  // --data-urlencode only encodes the value, so encode both halves ourselves.
  if (spec.body.type === 'urlencoded') for (const f of spec.body.fields) parts.push(`--data ${shq(`${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)}`);
  if (spec.body.type === 'formdata') {
    for (const f of spec.body.fields) parts.push(`-F ${shq(f.type === 'file' ? `${f.key}=@/path/to/${f.fileName}` : `${f.key}=${f.value}`)}`);
  }
  if (spec.body.type === 'binary') parts.push(`--data-binary ${shq(`@/path/to/${spec.body.fileName}`)}`);
  if (spec.verifySsl === false) parts.splice(1, 0, '-k');
  return parts.join(' \\\n  ');
}
