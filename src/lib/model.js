// Workspace data model, tree helpers, Postman v2.1 import/export and cURL import.
import { uid, clone, stringifyValue } from './util.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const kv = (key = '', value = '', enabled = true) => ({ key, value, enabled });

export const emptyBody = () => ({
  mode: 'none',
  raw: '',
  rawLang: 'json',
  urlencoded: [],
  formdata: [],
  graphql: { query: '', variables: '' },
  binary: null,
});

export function newRequest(name = 'New Request') {
  return {
    id: uid(),
    type: 'request',
    name,
    method: 'GET',
    url: '',
    pathVars: [],
    disabledQuery: [],
    headers: [],
    body: emptyBody(),
    auth: { type: 'inherit' },
    settings: {},
    preRequest: '',
    test: '',
    description: '',
    examples: [],
  };
}

export function newFolder(name = 'New Folder') {
  return { id: uid(), type: 'folder', name, items: [], auth: { type: 'inherit' }, preRequest: '', test: '', description: '' };
}

export function newCollection(name = 'New Collection') {
  return {
    id: uid(),
    type: 'collection',
    name,
    items: [],
    variables: [],
    auth: { type: 'noauth' },
    preRequest: '',
    test: '',
    description: '',
  };
}

export const newEnvironment = (name = 'New Environment') => ({ id: uid(), name, values: [] });

// Fills fields added in later versions so older workspaces keep working.
export function normalizeRequest(r) {
  r.pathVars ||= [];
  r.disabledQuery ||= [];
  r.settings ||= {};
  r.examples ||= [];
  r.body = { ...emptyBody(), ...(r.body || {}) };
  r.body.graphql ||= { query: '', variables: '' };
  return r;
}

export function normalizeWorkspace(ws) {
  const walk = (n) => {
    if (n.type === 'request') normalizeRequest(n);
    else n.items?.forEach(walk);
  };
  const out = {
    version: 1,
    collections: Array.isArray(ws?.collections) ? ws.collections : [],
    environments: Array.isArray(ws?.environments) ? ws.environments : [],
    globals: Array.isArray(ws?.globals) ? ws.globals : [],
    cookies: Array.isArray(ws?.cookies) ? ws.cookies : [],
    settings: { timeoutMs: 120000, verifySsl: true, followRedirects: true, cookieJar: true, proxyUrl: '', noProxy: 'localhost,127.0.0.1', clientCerts: [], ...(ws?.settings || {}) },
  };
  out.collections.forEach(walk);
  return out;
}

// ---------- Tree helpers ----------

// Locates a node anywhere in the workspace. `chain` = [collection, ...folders] above the node.
export function findNode(ws, id) {
  for (const col of ws.collections) {
    if (col.id === id) return { node: col, parent: null, collection: col, chain: [] };
    const hit = findIn(col, id, [col]);
    if (hit) return { ...hit, collection: col };
  }
  return null;
}

function findIn(parent, id, chain) {
  for (const it of parent.items) {
    if (it.id === id) return { node: it, parent, chain };
    if (it.type === 'folder') {
      const hit = findIn(it, id, [...chain, it]);
      if (hit) return hit;
    }
  }
  return null;
}

export function flattenRequests(node, chain) {
  const out = [];
  const walk = (n, ch) => {
    for (const it of n.items) {
      if (it.type === 'folder') walk(it, [...ch, it]);
      else out.push({ item: it, chain: ch });
    }
  };
  if (node.type === 'request') out.push({ item: node, chain });
  else walk(node, [...chain, node]);
  return out;
}

export function countRequests(node) {
  if (node.type === 'request') return 1;
  return node.items.reduce((n, it) => n + countRequests(it), 0);
}

export function isDescendant(ancestor, id) {
  if (!ancestor.items) return false;
  return ancestor.items.some((it) => it.id === id || isDescendant(it, id));
}

export function cloneWithNewIds(node) {
  const c = clone(node);
  const reid = (n) => {
    n.id = uid();
    n.items?.forEach(reid);
    n.examples?.forEach((e) => (e.id = uid()));
  };
  reid(c);
  return c;
}

// The auth that actually applies to a request (walks up through "inherit").
export function effectiveAuth(item, chain) {
  for (const n of [item, ...[...chain].reverse()]) {
    if (n.auth && n.auth.type !== 'inherit') return { auth: n.auth, from: n };
  }
  return { auth: { type: 'noauth' }, from: null };
}

// ---------- Postman v2.1 import ----------

const scriptText = (exec) => (Array.isArray(exec) ? exec.join('\n') : exec || '');
const textOf = (d) => (typeof d === 'string' ? d : d?.content || '');
const authParams = (list) => (Array.isArray(list) ? Object.fromEntries(list.map((p) => [p.key, p.value])) : list || {});
const str = (v) => (v === undefined || v === null ? '' : stringifyValue(v));
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function convEvents(events) {
  const out = { preRequest: '', test: '' };
  for (const e of events || []) {
    if (e.disabled) continue;
    if (e.listen === 'prerequest') out.preRequest = scriptText(e.script?.exec);
    if (e.listen === 'test') out.test = scriptText(e.script?.exec);
  }
  return out;
}

function convAuth(a, dflt) {
  if (!a) return { type: dflt };
  const p = authParams(a[a.type]);
  switch (a.type) {
    case 'noauth':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: { token: str(p.token) } };
    case 'basic':
      return { type: 'basic', basic: { username: str(p.username), password: str(p.password) } };
    case 'apikey':
      return { type: 'apikey', apikey: { key: str(p.key), value: str(p.value), in: str(p.in) || 'header' } };
    case 'digest':
      return { type: 'digest', digest: { username: str(p.username), password: str(p.password) } };
    case 'awsv4':
      return {
        type: 'awsv4',
        awsv4: { accessKey: str(p.accessKey), secretKey: str(p.secretKey), sessionToken: str(p.sessionToken), region: str(p.region), service: str(p.service) },
      };
    case 'jwt':
      return {
        type: 'jwt',
        jwt: {
          algorithm: str(p.algorithm) || 'HS256',
          secret: str(p.secret),
          privateKey: str(p.privateKey),
          secretBase64: !!p.isSecretBase64Encoded,
          payload: str(p.payload) || '{}',
          header: str(p.header) || '',
          headerPrefix: p.headerPrefix === undefined ? 'Bearer' : str(p.headerPrefix),
          addTo: p.addTokenTo === 'queryParam' ? 'query' : 'header',
          queryParamKey: str(p.queryParamKey) || 'token',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: str(p.accessToken),
          headerPrefix: p.headerPrefix === undefined ? 'Bearer' : str(p.headerPrefix),
          addTo: p.addTokenTo === 'queryParams' ? 'query' : 'header',
          grantType: { client_credentials: 'client_credentials', password_credentials: 'password', authorization_code: 'authorization_code', authorization_code_with_pkce: 'authorization_code' }[p.grant_type] || 'client_credentials',
          usePkce: p.grant_type === 'authorization_code_with_pkce',
          authUrl: str(p.authUrl),
          accessTokenUrl: str(p.accessTokenUrl),
          clientId: str(p.clientId),
          clientSecret: str(p.clientSecret),
          scope: str(p.scope),
          username: str(p.username),
          password: str(p.password),
          redirectUri: str(p.redirect_uri),
          clientAuth: p.client_authentication === 'body' ? 'body' : 'header',
          autoFetch: false,
        },
      };
    default:
      // Kept as-is so it survives an export, but not applied when sending.
      return { type: 'unsupported', original: a };
  }
}

function urlToString(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) {
    // raw keeps disabled params in some exports; enabled ones are what the request sends.
    const disabled = new Set((u.query || []).filter((q) => q.disabled).map((q) => `${q.key}=${q.value ?? ''}`));
    if (!disabled.size) return u.raw;
    const [base, query = ''] = u.raw.split('?');
    const kept = query.split('&').filter((p) => p && !disabled.has(p.includes('=') ? p : `${p}=`));
    return kept.length ? `${base}?${kept.join('&')}` : base;
  }
  const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
  const p = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
  const q = (u.query || []).filter((x) => !x.disabled).map((x) => (x.value == null ? x.key : `${x.key}=${x.value}`));
  return `${u.protocol ? `${u.protocol}://` : ''}${host}${u.port ? `:${u.port}` : ''}${p ? `/${p}` : ''}${q.length ? `?${q.join('&')}` : ''}`;
}

const convKV = (list) => (list || []).map((x) => kv(x.key ?? '', str(x.value), !x.disabled));

function convBody(b) {
  const body = emptyBody();
  if (!b || b.disabled) return body;
  if (b.mode === 'raw') {
    body.mode = 'raw';
    body.raw = b.raw || '';
    body.rawLang = b.options?.raw?.language || (/^\s*[[{]/.test(body.raw) ? 'json' : 'text');
  } else if (b.mode === 'urlencoded') {
    body.mode = 'urlencoded';
    body.urlencoded = convKV(b.urlencoded);
  } else if (b.mode === 'formdata') {
    body.mode = 'formdata';
    body.formdata = (b.formdata || []).map((f) =>
      f.type === 'file'
        ? { key: f.key, value: '', enabled: !f.disabled, type: 'file', fileId: null, fileName: baseName(Array.isArray(f.src) ? f.src[0] : f.src) }
        : { ...kv(f.key, str(f.value), !f.disabled), type: 'text' },
    );
  } else if (b.mode === 'graphql') {
    body.mode = 'graphql';
    body.graphql = { query: b.graphql?.query || '', variables: str(b.graphql?.variables) };
  } else if (b.mode === 'file') {
    body.mode = 'binary';
    body.binary = { fileId: null, fileName: baseName(b.file?.src) };
  }
  return body;
}

function convExamples(responses) {
  return (responses || []).map((r) => ({
    id: uid(),
    name: r.name || 'Example',
    request: r.originalRequest
      ? { method: r.originalRequest.method || 'GET', url: urlToString(r.originalRequest.url), headers: convKV(r.originalRequest.header), body: convBody(r.originalRequest.body) }
      : null,
    response: {
      status: r.code || 200,
      statusText: r.status || '',
      headers: (r.header || []).map((h) => ({ key: h.key, value: str(h.value) })),
      body: r.body || '',
      encoding: 'utf8',
    },
  }));
}

function convItem(it) {
  if (Array.isArray(it.item)) {
    const f = newFolder(it.name || 'Folder');
    f.description = textOf(it.description);
    f.auth = convAuth(it.auth, 'inherit');
    Object.assign(f, convEvents(it.event));
    f.items = it.item.map(convItem);
    return f;
  }
  const r = newRequest(it.name || 'Request');
  const req = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request || {};
  r.method = String(req.method || 'GET').toUpperCase();
  r.url = urlToString(req.url);
  if (req.url && typeof req.url === 'object') {
    r.pathVars = (req.url.variable || []).map((v) => ({ key: v.key, value: str(v.value), description: textOf(v.description) }));
    r.disabledQuery = (req.url.query || []).filter((q) => q.disabled).map((q) => ({ key: q.key, value: str(q.value) }));
  }
  r.headers = Array.isArray(req.header) ? convKV(req.header) : [];
  r.body = convBody(req.body);
  r.auth = convAuth(req.auth, 'inherit');
  r.description = textOf(req.description);
  const ppb = it.protocolProfileBehavior || {};
  if (ppb.strictSSL === false) r.settings.verifySsl = false;
  if (ppb.followRedirects === false) r.settings.followRedirects = false;
  if (ppb.disableCookies === true) r.settings.cookieJar = false;
  r.examples = convExamples(it.response);
  Object.assign(r, convEvents(it.event));
  return r;
}

export function importPostmanCollection(json) {
  const info = json.info || {};
  const col = newCollection(info.name || 'Imported Collection');
  col.description = textOf(info.description);
  col.variables = convKV(json.variable);
  col.auth = convAuth(json.auth, 'noauth');
  Object.assign(col, convEvents(json.event));
  col.items = (json.item || []).map(convItem);
  return col;
}

export function importPostmanEnvironment(json) {
  const env = newEnvironment(json.name || 'Imported Environment');
  env.values = (json.values || []).map((v) => ({ ...kv(v.key ?? '', str(v.value), v.enabled !== false), type: v.type === 'secret' ? 'secret' : 'default' }));
  return env;
}

// ---------- Postman v2.1 export ----------

function expEvents(n) {
  const ev = [];
  if (n.preRequest?.trim()) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: n.preRequest.split('\n') } });
  if (n.test?.trim()) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: n.test.split('\n') } });
  return ev.length ? ev : undefined;
}

function expAuth(a) {
  if (!a || a.type === 'inherit') return undefined;
  const p = (obj) => Object.entries(obj || {}).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value, type: typeof value === 'boolean' ? 'boolean' : 'string' }));
  switch (a.type) {
    case 'noauth':
      return { type: 'noauth' };
    case 'bearer':
    case 'basic':
    case 'apikey':
    case 'digest':
    case 'awsv4':
      return { type: a.type, [a.type]: p(a[a.type]) };
    case 'jwt': {
      const j = a.jwt || {};
      return {
        type: 'jwt',
        jwt: p({
          algorithm: j.algorithm,
          secret: j.secret,
          privateKey: j.privateKey,
          isSecretBase64Encoded: !!j.secretBase64,
          payload: j.payload,
          header: j.header,
          headerPrefix: j.headerPrefix,
          addTokenTo: j.addTo === 'query' ? 'queryParam' : 'header',
          queryParamKey: j.queryParamKey,
        }),
      };
    }
    case 'oauth2': {
      const o = a.oauth2 || {};
      const grant = o.grantType === 'password' ? 'password_credentials' : o.grantType === 'authorization_code' ? (o.usePkce ? 'authorization_code_with_pkce' : 'authorization_code') : 'client_credentials';
      return {
        type: 'oauth2',
        oauth2: p({
          accessToken: o.accessToken,
          headerPrefix: o.headerPrefix,
          addTokenTo: o.addTo === 'query' ? 'queryParams' : 'header',
          grant_type: grant,
          authUrl: o.authUrl,
          accessTokenUrl: o.accessTokenUrl,
          clientId: o.clientId,
          clientSecret: o.clientSecret,
          scope: o.scope,
          username: o.username,
          password: o.password,
          redirect_uri: o.redirectUri,
          client_authentication: o.clientAuth === 'body' ? 'body' : 'header',
        }),
      };
    }
    case 'unsupported':
      return a.original;
    default:
      return undefined;
  }
}

const expKV = (list) => list.map((x) => ({ key: x.key, value: x.value, ...(x.enabled === false ? { disabled: true } : {}) }));

function expBody(b) {
  if (!b || b.mode === 'none') return undefined;
  if (b.mode === 'raw') return { mode: 'raw', raw: b.raw, options: { raw: { language: b.rawLang || 'text' } } };
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: expKV(b.urlencoded) };
  if (b.mode === 'formdata') {
    return {
      mode: 'formdata',
      formdata: b.formdata.map((f) =>
        f.type === 'file'
          ? { key: f.key, type: 'file', src: f.fileName || '', ...(f.enabled === false ? { disabled: true } : {}) }
          : { key: f.key, value: f.value, type: 'text', ...(f.enabled === false ? { disabled: true } : {}) },
      ),
    };
  }
  if (b.mode === 'graphql') return { mode: 'graphql', graphql: { query: b.graphql?.query || '', variables: b.graphql?.variables || '' } };
  if (b.mode === 'binary') return { mode: 'file', file: { src: b.binary?.fileName || '' } };
  return undefined;
}

function expUrl(n) {
  if (!n.pathVars?.length && !n.disabledQuery?.length) return n.url;
  const [, query = ''] = n.url.split('?');
  const enabled = query ? query.split('&').map((p) => ({ key: p.split('=')[0], value: p.includes('=') ? p.slice(p.indexOf('=') + 1) : null })) : [];
  return {
    raw: n.url,
    query: [...enabled, ...n.disabledQuery.map((q) => ({ ...q, disabled: true }))],
    variable: n.pathVars.map((v) => ({ key: v.key, value: v.value, ...(v.description ? { description: v.description } : {}) })),
  };
}

function expItem(n) {
  if (n.type === 'folder') {
    return { name: n.name, description: n.description || undefined, item: n.items.map(expItem), auth: expAuth(n.auth), event: expEvents(n) };
  }
  const ppb = {};
  if (n.settings?.verifySsl === false) ppb.strictSSL = false;
  if (n.settings?.followRedirects === false) ppb.followRedirects = false;
  if (n.settings?.cookieJar === false) ppb.disableCookies = true;
  return {
    name: n.name,
    event: expEvents(n),
    protocolProfileBehavior: Object.keys(ppb).length ? ppb : undefined,
    request: {
      method: n.method,
      header: expKV(n.headers),
      body: expBody(n.body),
      url: expUrl(n),
      auth: expAuth(n.auth),
      description: n.description || undefined,
    },
    response: (n.examples || []).map((e) => ({
      name: e.name,
      originalRequest: e.request ? { method: e.request.method, header: expKV(e.request.headers || []), url: e.request.url, body: expBody(e.request.body) } : undefined,
      status: e.response.statusText,
      code: e.response.status,
      header: e.response.headers,
      body: e.response.body,
    })),
  };
}

export function exportPostmanCollection(col) {
  return {
    info: {
      _postman_id: col.id,
      name: col.name,
      description: col.description || undefined,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: col.items.map(expItem),
    auth: expAuth(col.auth),
    event: expEvents(col),
    variable: col.variables.map((v) => ({ key: v.key, value: v.value, ...(v.enabled === false ? { disabled: true } : {}) })),
  };
}

export function exportPostmanEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: env.values.map((v) => ({ key: v.key, value: v.value, type: v.type === 'secret' ? 'secret' : 'default', enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment',
  };
}

// ---------- cURL import ----------

function shellSplit(s) {
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (c === "'") {
      has = true;
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting, e.g. --data-raw $'{"a":"b\'c"}' as produced by Chrome.
      has = true;
      i += 2;
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          cur += { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }[n] ?? `\\${n}`;
        } else cur += s[i];
      }
    } else if (c === '"') {
      has = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && /["\\$`]/.test(s[i + 1])) i++;
        cur += s[i];
      }
    } else if (c === '\\' && i + 1 < s.length) {
      has = true;
      cur += s[++i];
    } else {
      has = true;
      cur += c;
    }
  }
  if (has) out.push(cur);
  return out;
}

const CURL_FLAGS_WITH_ARG = new Set(['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--retry', '-x', '--proxy', '--cacert', '--cert', '--key', '-T', '--upload-file']);

// Chrome's "Copy as cURL (cmd)" escapes with ^ and continues lines with a trailing ^.
const fromCmdSyntax = (s) => s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');

export function parseCurl(cmd) {
  let src = cmd.replace(/\\\r?\n/g, ' ').trim();
  if (/\^["\r\n]/.test(src)) src = fromCmdSyntax(src);
  const tokens = shellSplit(src);
  if (tokens[0] !== 'curl') throw new Error('Not a cURL command');
  const r = newRequest('Imported cURL');
  let method = null;
  let url = '';
  let forceGet = false;
  const data = [];
  const form = [];
  for (let i = 1; i < tokens.length; i++) {
    let t = tokens[i];
    let inline = null;
    const m = t.match(/^(-[XHdbuAeF])(.+)$/); // -XPOST, -H'k: v'
    if (m) {
      t = m[1];
      inline = m[2];
    }
    const next = () => (inline != null ? inline : tokens[++i] ?? '');
    switch (t) {
      case '-X':
      case '--request':
        method = next().toUpperCase();
        break;
      case '-H':
      case '--header': {
        const hv = next();
        const idx = hv.indexOf(':');
        if (idx > 0) r.headers.push(kv(hv.slice(0, idx).trim(), hv.slice(idx + 1).trim()));
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
      case '--data-urlencode':
        data.push(next());
        break;
      case '--json':
        data.push(next());
        if (!r.headers.some((x) => x.key.toLowerCase() === 'content-type')) r.headers.push(kv('Content-Type', 'application/json'));
        if (!r.headers.some((x) => x.key.toLowerCase() === 'accept')) r.headers.push(kv('Accept', 'application/json'));
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-F':
      case '--form':
        form.push(next());
        break;
      case '-u':
      case '--user': {
        const [username, ...rest] = next().split(':');
        r.auth = { type: 'basic', basic: { username, password: rest.join(':') } };
        break;
      }
      case '-b':
      case '--cookie':
        r.headers.push(kv('Cookie', next()));
        break;
      case '-A':
      case '--user-agent':
        r.headers.push(kv('User-Agent', next()));
        break;
      case '-e':
      case '--referer':
        r.headers.push(kv('Referer', next()));
        break;
      case '--url':
        url = next();
        break;
      case '-G':
      case '--get':
        forceGet = true;
        break;
      default:
        if (CURL_FLAGS_WITH_ARG.has(t)) i++;
        else if (!t.startsWith('-') && !url) url = t;
    }
  }
  r.url = url;
  const ctHeader = r.headers.find((x) => x.key.toLowerCase() === 'content-type');
  if (forceGet && data.length) {
    r.url += (r.url.includes('?') ? '&' : '?') + data.join('&');
  } else if (form.length) {
    r.body.mode = 'formdata';
    r.body.formdata = form.map((f) => {
      const idx = f.indexOf('=');
      return kv(f.slice(0, idx), f.slice(idx + 1));
    });
  } else if (data.length) {
    const raw = data.join('&');
    const isJSON = (() => {
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    })();
    if (!isJSON && (!ctHeader || /x-www-form-urlencoded/i.test(ctHeader.value))) {
      r.body.mode = 'urlencoded';
      r.body.urlencoded = raw.split('&').filter(Boolean).map((p) => {
        const idx = p.indexOf('=');
        const dec = (s) => {
          try {
            return decodeURIComponent(s.replace(/\+/g, ' '));
          } catch {
            return s;
          }
        };
        return idx < 0 ? kv(dec(p), '') : kv(dec(p.slice(0, idx)), dec(p.slice(idx + 1)));
      });
      if (ctHeader) r.headers = r.headers.filter((x) => x !== ctHeader);
    } else {
      r.body.mode = 'raw';
      r.body.rawLang = isJSON ? 'json' : 'text';
      r.body.raw = isJSON ? JSON.stringify(JSON.parse(raw), null, 2) : raw;
      if (!ctHeader) r.headers.push(kv('Content-Type', isJSON ? 'application/json' : 'application/x-www-form-urlencoded'));
    }
  }
  r.method = method || (!forceGet && (data.length || form.length) ? 'POST' : 'GET');
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(r.url) ? r.url : `http://${r.url}`);
    r.name = `${r.method} ${u.pathname}`;
  } catch {
    /* keep default name */
  }
  return r;
}
