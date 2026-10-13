// The `pm` scripting API and script execution, mirroring Postman's sandbox.
import chai from 'chai';
import CryptoJS from 'crypto-js';
import _ from 'lodash';
import moment from 'moment';
import { uid, errMsg, formatLogArg, stringifyValue, eqi } from './util.js';
import { parseQuery, withQuery, splitUrl, ensureProtocol } from './build.js';
import { cookiesFor, storeCookie, parseSetCookie } from './cookies.js';

// ---------- Optional libraries, loaded only when a script mentions them ----------

const lazy = {};
const LAZY_MODULES = {
  ajv: { test: /jsonSchema|ajv|tv4/, load: () => import('ajv').then((m) => m.default) },
  cheerio: { test: /cheerio/, load: () => import('cheerio') },
  xml: { test: /xml2Json|fast-xml-parser|xml2js/, load: () => import('fast-xml-parser') },
};

export async function preloadModules(codes) {
  const text = codes.filter(Boolean).join('\n');
  await Promise.all(
    Object.entries(LAZY_MODULES)
      .filter(([name, m]) => !lazy[name] && m.test.test(text))
      .map(async ([name, m]) => {
        lazy[name] = await m.load();
      }),
  );
}

function needs(name) {
  if (!lazy[name]) throw new Error(`Module "${name}" failed to load`);
  return lazy[name];
}

function xml2Json(xml) {
  const { XMLParser } = needs('xml');
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '$', textNodeName: '_' }).parse(xml);
}

let ajvInstance;
function validateSchema(data, schema, options) {
  const Ajv = needs('ajv');
  const ajv = options ? new Ajv({ allErrors: true, strict: false, ...options }) : (ajvInstance ||= new Ajv({ allErrors: true, strict: false }));
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors || [], text: valid ? '' : ajv.errorsText(validate.errors) };
}

// Postman still ships tv4; most scripts only use tv4.validate + tv4.error.
const tv4 = {
  error: null,
  validate(data, schema) {
    const r = validateSchema(data, schema);
    tv4.error = r.valid ? null : { message: r.text };
    return r.valid;
  },
  validateResult(data, schema) {
    const r = validateSchema(data, schema);
    return { valid: r.valid, error: r.valid ? null : { message: r.text }, missing: [] };
  },
};

const MODULES = () => ({
  chai,
  'crypto-js': CryptoJS,
  lodash: _,
  moment,
  uuid: { v4: uid },
  atob: (s) => atob(s),
  btoa: (s) => btoa(s),
  ajv: lazy.ajv,
  tv4: lazy.ajv ? tv4 : undefined,
  cheerio: lazy.cheerio,
  'fast-xml-parser': lazy.xml,
});

// ---------- Collection-like helpers ----------

function kvListApi(getList, setList) {
  const norm = (x, v) => {
    if (typeof x === 'string' && v === undefined) {
      const i = x.indexOf(':');
      return { key: x.slice(0, i).trim(), value: x.slice(i + 1).trim(), enabled: true };
    }
    if (typeof x === 'string') return { key: x, value: stringifyValue(v), enabled: true };
    return { key: String(x.key), value: stringifyValue(x.value ?? ''), enabled: !x.disabled };
  };
  const active = () => getList().filter((x) => x.enabled !== false);
  return {
    add: (x, v) => void getList().push(norm(x, v)),
    upsert: (x, v) => {
      const n = norm(x, v);
      const ex = active().find((y) => eqi(y.key, n.key));
      if (ex) ex.value = n.value;
      else getList().push(n);
    },
    remove: (k) => setList(getList().filter((y) => !eqi(y.key, typeof k === 'string' ? k : k.key))),
    get: (k) => active().find((y) => eqi(y.key, k))?.value,
    has: (k, v) => active().some((y) => eqi(y.key, k) && (v === undefined || y.value === v)),
    toObject: () => Object.fromEntries(active().map((y) => [y.key, y.value])),
    all: () => active().map((y) => ({ key: y.key, value: y.value })),
    each: (fn) => active().forEach((y) => fn({ key: y.key, value: y.value })),
    count: () => active().length,
  };
}

function queryApi(r) {
  const list = () => parseQuery(r.url);
  const save = (l) => void (r.url = withQuery(r.url, l));
  const norm = (x, v) => {
    if (typeof x === 'string' && v === undefined) {
      const i = x.indexOf('=');
      return i < 0 ? { key: x, value: '' } : { key: x.slice(0, i), value: x.slice(i + 1) };
    }
    if (typeof x === 'string') return { key: x, value: stringifyValue(v) };
    return { key: String(x.key), value: stringifyValue(x.value ?? '') };
  };
  return {
    add: (x, v) => save([...list(), norm(x, v)]),
    upsert: (x, v) => {
      const n = norm(x, v);
      const l = list();
      const ex = l.find((p) => p.key === n.key);
      if (ex) ex.value = n.value;
      else l.push(n);
      save(l);
    },
    remove: (k) => save(list().filter((p) => p.key !== (typeof k === 'string' ? k : k.key))),
    get: (k) => list().find((p) => p.key === k)?.value,
    has: (k) => list().some((p) => p.key === k),
    toObject: () => Object.fromEntries(list().map((p) => [p.key, p.value])),
    all: () => list().map(({ key, value }) => ({ key, value })),
    each: (fn) => list().forEach(({ key, value }) => fn({ key, value })),
    count: () => list().length,
  };
}

function requestApi(r) {
  r.pathVars ||= [];
  const url = {
    toString: () => r.url,
    update: (s) => void (r.url = String(s)),
    getHost: () => splitUrl(r.url).base.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0],
    getPath: () => '/' + splitUrl(r.url).base.replace(/^[a-z]+:\/\//i, '').split('/').slice(1).join('/'),
    getQueryString: () => r.url.split('?')[1]?.split('#')[0] || '',
    query: queryApi(r),
    variables: kvListApi(
      () => r.pathVars,
      (l) => (r.pathVars = l),
    ),
  };
  const bodyApi = {
    get mode() {
      return r.body?.mode;
    },
    get raw() {
      return r.body?.raw;
    },
    set raw(v) {
      r.body.raw = stringifyValue(v);
      if (r.body.mode === 'none') r.body.mode = 'raw';
    },
    get graphql() {
      return r.body?.graphql;
    },
    update(v) {
      if (typeof v === 'string') {
        r.body.mode = 'raw';
        r.body.raw = v;
      } else if (v && v.mode) {
        r.body.mode = v.mode;
        if (v.mode === 'raw') r.body.raw = stringifyValue(v.raw);
        if (v.mode === 'urlencoded') r.body.urlencoded = (v.urlencoded || []).map((x) => ({ key: x.key, value: stringifyValue(x.value), enabled: true }));
        if (v.mode === 'formdata') r.body.formdata = (v.formdata || []).map((x) => ({ key: x.key, value: stringifyValue(x.value), enabled: true, type: 'text' }));
        if (v.mode === 'graphql') r.body.graphql = { query: v.graphql?.query || '', variables: stringifyValue(v.graphql?.variables ?? '') };
      } else {
        r.body.mode = 'raw';
        r.body.raw = JSON.stringify(v);
      }
    },
    urlencoded: kvListApi(
      () => r.body.urlencoded,
      (l) => (r.body.urlencoded = l),
    ),
    formdata: kvListApi(
      () => r.body.formdata,
      (l) => (r.body.formdata = l),
    ),
    toString: () => (r.body?.mode === 'raw' ? r.body.raw : ''),
    isEmpty: () => !r.body || r.body.mode === 'none',
  };
  const headers = kvListApi(
    () => r.headers,
    (l) => (r.headers = l),
  );
  return {
    id: r.id,
    name: r.name,
    get method() {
      return r.method;
    },
    set method(v) {
      r.method = String(v).toUpperCase();
    },
    get url() {
      return url;
    },
    set url(v) {
      r.url = String(v);
    },
    headers,
    addHeader: (x) => headers.add(x),
    removeHeader: (k) => headers.remove(k),
    upsertHeader: (x) => headers.upsert(x),
    body: bodyApi,
    auth: r.auth,
  };
}

export function responseApi(res) {
  let parsed;
  let parsedOk = false;
  const text = () => {
    if (res.encoding !== 'base64') return res.body ?? '';
    try {
      return atob(res.body);
    } catch {
      return '';
    }
  };
  const json = () => {
    if (!parsedOk) {
      try {
        parsed = JSON.parse(text());
      } catch (e) {
        const err = new SyntaxError(`pm.response.json(): response is not valid JSON (${e.message})`);
        err.name = 'JSONError';
        throw err;
      }
      parsedOk = true;
    }
    return parsed;
  };
  const headerList = res.headers || [];
  const headers = {
    get: (k) => headerList.find((x) => eqi(x.key, k))?.value,
    has: (k, v) => headerList.some((x) => eqi(x.key, k) && (v === undefined || x.value === v)),
    toObject: () => Object.fromEntries(headerList.map((x) => [x.key, x.value])),
    all: () => headerList.map((x) => ({ ...x })),
    each: (fn) => headerList.forEach((x) => fn({ ...x })),
    count: () => headerList.length,
  };
  const cookieList = headerList
    .filter((x) => eqi(x.key, 'set-cookie'))
    .map((x) => {
      const [pair] = x.value.split(';');
      const i = pair.indexOf('=');
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
    });
  const resp = {
    code: res.status,
    status: res.statusText,
    responseTime: res.timeMs,
    responseSize: res.size,
    headers,
    cookies: {
      get: (n) => cookieList.find((c) => c.name === n)?.value,
      has: (n) => cookieList.some((c) => c.name === n),
      toObject: () => Object.fromEntries(cookieList.map((c) => [c.name, c.value])),
      all: () => cookieList.map((c) => ({ ...c })),
    },
    text,
    json,
    reason: () => res.statusText,
    size: () => ({ body: res.size, header: headerList.reduce((n, x) => n + x.key.length + x.value.length + 4, 0), total: res.size }),
  };
  resp.to = assertionsFor(resp, false);
  return resp;
}

// pm.response.to.have.status(200), pm.response.to.be.ok, pm.response.to.not.have.header('x'), ...
function assertionsFor(resp, negate) {
  const expect = chai.expect;
  const chk = (val, msg) => (negate ? expect(val, msg).to.not.be.true : expect(val, msg).to.be.true);
  const inRange = (lo, hi) => resp.code >= lo && resp.code <= hi;
  const not = negate ? 'not ' : '';
  const have = {
    status(s) {
      const ok = typeof s === 'number' ? resp.code === s : resp.status === s;
      chk(ok, `expected response to ${not}have status ${s} but got ${resp.code} ${resp.status}`);
    },
    header(k, v) {
      chk(resp.headers.has(k, v), `expected response to ${not}have header ${k}${v !== undefined ? `: ${v}` : ''}`);
    },
    body(v) {
      const t = resp.text();
      const ok = v === undefined ? t.length > 0 : v instanceof RegExp ? v.test(t) : t === v;
      chk(ok, `expected response body to ${not}match ${v === undefined ? 'non-empty' : v}`);
    },
    jsonBody(path, value) {
      let j;
      try {
        j = resp.json();
      } catch {
        return chk(false, 'expected response body to be JSON');
      }
      if (path === undefined) return chk(true, '');
      if (typeof path === 'object') return chk(_.isEqual(j, path), `expected JSON body to ${not}deep equal the given object`);
      const got = _.get(j, path);
      const ok = value === undefined ? got !== undefined : _.isEqual(got, value);
      return chk(ok, `expected JSON body to ${not}have ${path}${value !== undefined ? ` = ${JSON.stringify(value)}` : ''}`);
    },
    jsonSchema(schema, options) {
      const r = validateSchema(resp.json(), schema, options);
      chk(r.valid, `expected response to ${not}match JSON schema${r.text ? `: ${r.text}` : ''}`);
    },
    cookie(name, value) {
      const ok = resp.cookies.has(name) && (value === undefined || resp.cookies.get(name) === value);
      chk(ok, `expected response to ${not}have cookie ${name}`);
    },
    responseTime: {
      below: (ms) => chk(resp.responseTime < ms, `expected response time ${resp.responseTime}ms to ${not}be below ${ms}ms`),
      above: (ms) => chk(resp.responseTime > ms, `expected response time ${resp.responseTime}ms to ${not}be above ${ms}ms`),
    },
  };
  const be = {};
  const defs = {
    ok: () => resp.code === 200,
    success: () => inRange(200, 299),
    accepted: () => resp.code === 202,
    withBody: () => resp.text().length > 0,
    badRequest: () => resp.code === 400,
    unauthorized: () => resp.code === 401,
    forbidden: () => resp.code === 403,
    notFound: () => resp.code === 404,
    rateLimited: () => resp.code === 429,
    clientError: () => inRange(400, 499),
    serverError: () => inRange(500, 599),
    error: () => inRange(400, 599),
    redirection: () => inRange(300, 399),
    info: () => inRange(100, 199),
    json: () => {
      try {
        resp.json();
        return true;
      } catch {
        return false;
      }
    },
  };
  for (const [name, fn] of Object.entries(defs)) {
    Object.defineProperty(be, name, {
      get() {
        chk(fn(), `expected response to ${not}be ${name} (status ${resp.code})`);
        return be;
      },
    });
  }
  const to = { have: have, be, an: be, a: be };
  if (!negate) Object.defineProperty(to, 'not', { get: () => assertionsFor(resp, true) });
  return to;
}

export function normalizeSendSpec(s) {
  const split = (x) => {
    const i = x.indexOf(':');
    return { key: x.slice(0, i).trim(), value: x.slice(i + 1).trim() };
  };
  if (typeof s === 'string') return { method: 'GET', url: ensureProtocol(s), headers: [], body: { type: 'none' } };
  const url = typeof s.url === 'string' ? s.url : s.url?.raw || String(s.url ?? '');
  const hd = s.header ?? s.headers;
  let headers = [];
  if (Array.isArray(hd)) headers = hd.map((x) => (typeof x === 'string' ? split(x) : { key: x.key, value: stringifyValue(x.value ?? '') }));
  else if (typeof hd === 'string') headers = [split(hd)];
  else if (hd && typeof hd === 'object') headers = Object.entries(hd).map(([key, value]) => ({ key, value: stringifyValue(value) }));
  let body = { type: 'none' };
  const b = s.body;
  if (typeof b === 'string') body = { type: 'text', text: b };
  else if (b?.mode === 'raw') body = { type: 'text', text: stringifyValue(b.raw) };
  else if (b?.mode === 'urlencoded') body = { type: 'urlencoded', fields: (b.urlencoded || []).map((f) => ({ key: f.key, value: stringifyValue(f.value ?? '') })) };
  else if (b?.mode === 'formdata') body = { type: 'formdata', fields: (b.formdata || []).map((f) => ({ key: f.key, value: stringifyValue(f.value ?? ''), type: 'text' })) };
  else if (b?.mode === 'graphql') body = { type: 'text', text: JSON.stringify(b.graphql || {}) };
  return { method: String(s.method || 'GET').toUpperCase(), url: ensureProtocol(url), headers, body };
}

function scopeApi(map, vars) {
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(String(k), v),
    unset: (k) => void map.delete(k),
    has: (k) => map.has(k),
    clear: () => map.clear(),
    toObject: () => Object.fromEntries(map),
    toJSON: () => Object.fromEntries(map),
    replaceIn: (s) => (vars ? vars.replaceIn(s) : s),
  };
}

// pm.cookies (cookies for the request URL) and pm.cookies.jar() (callback style, like Postman).
function cookiesApi(ctx, requestUrl) {
  const current = () => {
    try {
      return cookiesFor(ctx.jar.cookies, requestUrl);
    } catch {
      return [];
    }
  };
  const done = (cb, err, value) => {
    if (cb) cb(err, value);
    return err ? Promise.reject(err) : Promise.resolve(value);
  };
  const jar = () => ({
    get: (url, name, cb) => done(cb, null, cookiesFor(ctx.jar.cookies, ensureProtocol(url)).find((c) => c.name === name)?.value),
    getAll: (url, cb) => done(cb, null, cookiesFor(ctx.jar.cookies, ensureProtocol(url)).map((c) => ({ ...c }))),
    set: (url, name, value, cb) => {
      if (typeof value === 'function') [cb, value] = [value, undefined];
      const raw = typeof name === 'object' ? `${name.name}=${name.value}${name.path ? `; Path=${name.path}` : ''}${name.domain ? `; Domain=${name.domain}` : ''}` : `${name}=${value}`;
      const c = parseSetCookie(raw, ensureProtocol(url));
      if (!c) return done(cb, new Error(`Invalid cookie for ${url}`));
      ctx.jar.cookies = storeCookie(ctx.jar.cookies, c);
      return done(cb, null, c);
    },
    unset: (url, name, cb) => {
      const host = new URL(ensureProtocol(url)).hostname;
      ctx.jar.cookies = ctx.jar.cookies.filter((c) => !(c.name === name && (host === c.domain || host.endsWith(`.${c.domain}`))));
      return done(cb, null);
    },
    clear: (url, cb) => {
      const host = new URL(ensureProtocol(url)).hostname;
      ctx.jar.cookies = ctx.jar.cookies.filter((c) => !(host === c.domain || host.endsWith(`.${c.domain}`)));
      return done(cb, null);
    },
  });
  return {
    get: (n) => current().find((c) => c.name === n)?.value,
    has: (n) => current().some((c) => c.name === n),
    toObject: () => Object.fromEntries(current().map((c) => [c.name, c.value])),
    all: () => current().map((c) => ({ ...c })),
    jar,
  };
}

// ctx: { out, vars, info, request, response, send, where, jar: { cookies }, vault: Map }
export function makeSandbox({ out, vars, info, request, response, send, where, jar, vault }) {
  const console_ = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => out.logs.push({ level, where, text: args.map(formatLogArg).join(' ') })]),
  );

  const track = (p) => {
    out.pending.push(p);
    return p;
  };
  const timers = new Map();
  const setTimeout_ = (fn, ms, ...a) => {
    let finish;
    track(new Promise((r) => (finish = r)));
    const id = setTimeout(() => {
      timers.delete(id);
      try {
        fn(...a);
      } catch (e) {
        out.errors.push(`${where} (setTimeout): ${errMsg(e)}`);
      } finally {
        finish();
      }
    }, ms);
    timers.set(id, finish);
    return id;
  };
  const clearTimeout_ = (id) => {
    clearTimeout(id);
    timers.get(id)?.();
    timers.delete(id);
  };

  const test = (name, fn) => {
    const rec = { name: String(name), passed: true, error: null, skipped: false };
    out.tests.push(rec);
    try {
      const r = fn?.();
      if (r && typeof r.then === 'function') {
        track(
          r.then(
            () => {},
            (e) => {
              rec.passed = false;
              rec.error = errMsg(e);
            },
          ),
        );
      }
    } catch (e) {
      rec.passed = false;
      rec.error = errMsg(e);
    }
    return pm;
  };
  test.skip = (name) => {
    out.tests.push({ name: String(name), passed: true, error: null, skipped: true });
    return pm;
  };

  const sendRequest = (spec, cb) => {
    const p = send(normalizeSendSpec(spec)).then(responseApi);
    p.catch(() => {}); // a script that neither awaits nor passes a callback must not crash the run
    track(
      p
        .then(
          (res) => cb?.(null, res),
          (err) => cb?.(err, null),
        )
        .catch((e) => out.errors.push(`${where} (sendRequest callback): ${errMsg(e)}`)),
    );
    return p;
  };

  const setNext = (name) => void (out.nextRequest = name === null ? null : String(name));

  const variables = {
    ...scopeApi(vars.local, vars),
    get: (k) => vars.get(k),
    has: (k) => vars.get(k) !== undefined,
    toObject: () => Object.fromEntries([vars.globals, vars.collection, vars.environment, vars.data, vars.local].flatMap((m) => [...(m || new Map())])),
    replaceIn: (s) => vars.replaceIn(s),
  };

  const vaultMap = vault || new Map();
  const pm = {
    info: { ...info },
    environment: { ...scopeApi(vars.environment, vars), name: info.environmentName || '' },
    collectionVariables: scopeApi(vars.collection, vars),
    globals: scopeApi(vars.globals, vars),
    variables,
    iterationData: { ...scopeApi(vars.data, vars), set: undefined },
    request: requestApi(request),
    response: response ? responseApi(response) : undefined,
    cookies: cookiesApi({ jar }, request.url),
    vault: {
      get: async (k) => vaultMap.get(k),
      set: async (k, v) => void vaultMap.set(String(k), stringifyValue(v)),
      unset: async (k) => void vaultMap.delete(k),
    },
    visualizer: {
      set: (template, data, options) => void (out.visualizer = { template: String(template), data: data ?? {}, options: options ?? {} }),
      clear: () => void (out.visualizer = null),
    },
    test,
    expect: chai.expect,
    sendRequest,
    execution: {
      setNextRequest: setNext,
      skipRequest: () => void (out.skipped = true),
      location: Object.assign([...(info.location || [])], { current: info.locationCurrent || '' }),
    },
    setNextRequest: setNext,
    require: (n) => MODULES()[n],
  };

  const postman = {
    setNextRequest: setNext,
    setEnvironmentVariable: (k, v) => vars.environment.set(k, v),
    getEnvironmentVariable: (k) => vars.environment.get(k),
    clearEnvironmentVariable: (k) => vars.environment.delete(k),
    setGlobalVariable: (k, v) => vars.globals.set(k, v),
    getGlobalVariable: (k) => vars.globals.get(k),
    clearGlobalVariable: (k) => vars.globals.delete(k),
    getResponseHeader: (k) => pm.response?.headers.get(k),
    getResponseCookie: (n) => (pm.response?.cookies.has(n) ? { name: n, value: pm.response.cookies.get(n) } : undefined),
  };

  const require_ = (name) => {
    const mod = MODULES()[name];
    if (!mod) throw new Error(`Module "${name}" is not available (chai, crypto-js, lodash, moment, uuid, ajv, tv4, cheerio, fast-xml-parser, atob, btoa are)`);
    return mod;
  };

  let responseBody;
  if (response) {
    try {
      responseBody = pm.response.text();
    } catch {
      responseBody = '';
    }
  }

  return {
    pm,
    postman,
    console: console_,
    require: require_,
    tests: out.legacyTests,
    responseBody,
    responseCode: response ? { code: response.status, name: response.statusText } : undefined,
    responseTime: response?.timeMs,
    responseHeaders: response ? Object.fromEntries(response.headers.map((x) => [x.key, x.value])) : undefined,
    responseCookies: response ? pm.response.cookies.all() : undefined,
    setTimeout: setTimeout_,
    clearTimeout: clearTimeout_,
    CryptoJS,
    _,
    moment,
    chai,
    xml2Json: lazy.xml ? xml2Json : () => needs('xml'),
    tv4: lazy.ajv ? tv4 : undefined,
    cheerio: lazy.cheerio,
  };
}

const SANDBOX_NAMES = [
  'pm', 'postman', 'console', 'require', 'tests', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders',
  'responseCookies', 'setTimeout', 'clearTimeout', 'CryptoJS', '_', 'moment', 'chai', 'xml2Json', 'tv4', 'cheerio',
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function drain(out) {
  while (out.pending.length) await Promise.allSettled(out.pending.splice(0));
}

// Returns false when the script threw (or did not compile).
export async function runScript(code, label, sandbox, out) {
  if (!code || !code.trim()) return true;
  let fn;
  try {
    // Not strict on purpose: older Postman scripts assign undeclared variables.
    fn = new AsyncFunction(...SANDBOX_NAMES, code);
  } catch (e) {
    out.errors.push(`${label}: ${errMsg(e)}`);
    return false;
  }
  try {
    await fn(...SANDBOX_NAMES.map((n) => sandbox[n]));
    await drain(out);
    return true;
  } catch (e) {
    await drain(out);
    out.errors.push(`${label}: ${errMsg(e)}`);
    return false;
  }
}
