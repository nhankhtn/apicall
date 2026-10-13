// Execution engine: runs one request (scripts + HTTP + cookies + auth handshakes), a whole
// collection, or a load test. Runs in a Web Worker in the app and directly in Node for the CLI.
import { uid, clone, sleep, errMsg, eqi } from './util.js';
import { effectiveAuth } from './model.js';
import { createVars, toMap, writeBack, unresolvedIn, DYNAMIC_NAMES, sameScope } from './vars.js';
import { buildRequest, toCurl, parseQuery, withQuery } from './build.js';
import { makeSandbox, runScript, preloadModules } from './sandbox.js';
import { storeSetCookies } from './cookies.js';
import { digestAuthorization, parseChallenge } from './authsign.js';

export { createVars, toMap, writeBack, unresolvedIn, DYNAMIC_NAMES, sameScope, parseQuery, withQuery, toCurl };

// ---------- Transport ----------

async function browserTransport(spec, signal) {
  let r;
  try {
    r = await fetch('/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Aborted');
    throw new Error(`Cannot reach the ApiCall Runner server: ${e.message}`);
  }
  return r.json();
}

let transport = browserTransport;
// The CLI swaps in a function that calls the proxy implementation directly.
export const setTransport = (fn) => void (transport = fn);

async function send(spec, signal) {
  if (signal?.aborted) throw new Error('Aborted');
  const j = await transport(spec, signal);
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j;
}

// ---------- OAuth 2.0 token requests ----------

// Grants that need no browser: client_credentials, password, refresh_token.
// (authorization_code runs in the UI, which can open the login popup.)
export async function fetchOAuth2Token(o, vars, { signal, settings } = {}) {
  const R = (s) => vars.replaceIn(s ?? '');
  const grant = o.grantType || 'client_credentials';
  const fields = [{ key: 'grant_type', value: grant }];
  if (grant === 'password') fields.push({ key: 'username', value: R(o.username) }, { key: 'password', value: R(o.password) });
  if (grant === 'refresh_token') fields.push({ key: 'refresh_token', value: R(o.refreshToken) });
  if (grant === 'authorization_code') {
    fields.push({ key: 'code', value: R(o.code) }, { key: 'redirect_uri', value: R(o.redirectUri) });
    if (o.codeVerifier) fields.push({ key: 'code_verifier', value: o.codeVerifier });
  }
  if (o.scope) fields.push({ key: 'scope', value: R(o.scope) });
  if (o.audience) fields.push({ key: 'audience', value: R(o.audience) });
  const headers = [{ key: 'Accept', value: 'application/json' }];
  if (o.clientAuth === 'body') fields.push({ key: 'client_id', value: R(o.clientId) }, { key: 'client_secret', value: R(o.clientSecret) });
  else {
    const cred = `${encodeURIComponent(R(o.clientId))}:${encodeURIComponent(R(o.clientSecret))}`;
    headers.push({ key: 'Authorization', value: `Basic ${btoa(cred)}` });
  }
  const res = await send(
    { method: 'POST', url: R(o.accessTokenUrl), headers, body: { type: 'urlencoded', fields }, verifySsl: settings?.verifySsl, timeoutMs: settings?.timeoutMs },
    signal,
  );
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = Object.fromEntries(new URLSearchParams(res.body));
  }
  if (res.status >= 400 || !json.access_token) {
    throw new Error(`Token request failed (${res.status}): ${json.error_description || json.error || res.body.slice(0, 200)}`);
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type || 'Bearer',
    expiresIn: json.expires_in,
    refreshToken: json.refresh_token || '',
    obtainedAt: Date.now(),
    raw: json,
  };
}

// ---------- One request ----------

const labelOf = (n) => `${n.type === 'collection' ? 'Collection' : n.type === 'folder' ? 'Folder' : 'Request'} "${n.name}"`;

export const isFailed = (r) => !!(r.error || r.scriptErrors.length || r.tests.some((t) => !t.passed));

function draftOf(item, chain) {
  return {
    id: item.id,
    name: item.name,
    method: item.method,
    url: item.url,
    pathVars: clone(item.pathVars || []),
    headers: clone(item.headers || []),
    body: clone(item.body || { mode: 'none' }),
    auth: clone(effectiveAuth(item, chain).auth),
    settings: clone(item.settings || {}),
  };
}

// Resolves a request without running scripts ("Copy as cURL", code snippets).
export function resolveRequest(item, chain, vars, ctx = {}) {
  return buildRequest(draftOf(item, chain), vars, ctx);
}

async function oauth2TokenFor(auth, vars, ctx, signal) {
  const o = auth?.oauth2;
  if (auth?.type !== 'oauth2' || !o || vars.replaceIn(o.accessToken || '') || !o.autoFetch || !o.accessTokenUrl) return '';
  const key = JSON.stringify([o.accessTokenUrl, o.clientId, o.grantType, o.scope, o.username]);
  const cached = ctx.oauthCache?.get(key);
  if (cached && (!cached.expiresIn || Date.now() - cached.obtainedAt < (cached.expiresIn - 30) * 1000)) return cached.accessToken;
  const token = await fetchOAuth2Token(o, vars, { signal, settings: ctx.settings });
  ctx.oauthCache?.set(key, token);
  return token.accessToken;
}

// ctx: { settings, jar: { cookies }, vault: Map, oauthCache: Map }
export async function executeRequest({ item, chain, vars: given, info, signal, ctx = {} }) {
  const vars = ctx.vault && !given.vault ? createVars({ ...given, vault: ctx.vault }) : given;
  const out = { tests: [], logs: [], errors: [], pending: [], warnings: [], legacyTests: {}, nextRequest: undefined, skipped: false, visualizer: null };
  const jar = ctx.jar || { cookies: [] };
  const started = Date.now();
  const record = {
    id: uid(),
    itemId: item.id,
    name: item.name,
    method: item.method,
    iteration: info.iteration,
    request: null,
    response: null,
    error: null,
    skipped: false,
    tests: out.tests,
    logs: out.logs,
    scriptErrors: out.errors,
    warnings: out.warnings,
    nextRequest: undefined,
    startedAt: started,
  };
  const draft = draftOf(item, chain);
  const nodes = [...chain, item];
  const location = [...chain.map((n) => n.name), item.name];
  const sendForScript = (spec) => send({ ...spec, timeoutMs: ctx.settings?.timeoutMs, verifySsl: ctx.settings?.verifySsl }, signal);
  const sandboxBase = { out, vars, send: sendForScript, jar, vault: ctx.vault };

  await preloadModules(nodes.flatMap((n) => [n.preRequest, n.test]));

  const pre = makeSandbox({ ...sandboxBase, info: { ...info, eventName: 'prerequest', location, locationCurrent: item.name }, request: draft, response: null, where: 'pre-request' });
  for (const n of nodes) {
    if (!(await runScript(n.preRequest, `${labelOf(n)} pre-request script`, pre, out))) {
      record.error = 'Pre-request script failed; request was not sent';
      break;
    }
  }
  if (!record.error && out.skipped) record.skipped = true;

  if (!record.error && !record.skipped) {
    let final;
    try {
      const oauth2Token = await oauth2TokenFor(draft.auth, vars, ctx, signal);
      final = await buildRequest(draft, vars, { settings: ctx.settings, cookies: jar.cookies, oauth2Token });
    } catch (e) {
      record.error = errMsg(e);
    }
    if (final) {
      const { spec } = final;
      record.method = spec.method;
      record.request = { method: spec.method, url: spec.url, headers: spec.headers, body: final.bodyText, bodyMode: spec.body.type };
      if (final.unresolved.length) out.warnings.push(`Unresolved variables: ${final.unresolved.map((n) => `{{${n}}}`).join(', ')}`);
      try {
        let res = await send(spec, signal);
        // Digest auth: answer the server's challenge and send again, as Postman does.
        if (final.digest && res.status === 401) {
          const challenge = res.headers.filter((x) => eqi(x.key, 'www-authenticate')).map((x) => x.value).find((v) => parseChallenge(v));
          if (challenge) {
            const R = (s) => vars.replaceIn(s ?? '');
            const value = digestAuthorization({ username: R(final.digest.username), password: R(final.digest.password) }, challenge, spec.method, spec.url, final.bodyText);
            spec.headers = [...spec.headers.filter((x) => !eqi(x.key, 'authorization')), { key: 'Authorization', value }];
            record.request.headers = spec.headers;
            res = await send(spec, signal);
          }
        }
        record.response = res;
        const settings = { ...(ctx.settings || {}), ...(draft.settings || {}) };
        const setCookies = res.headers.filter((x) => eqi(x.key, 'set-cookie')).map((x) => x.value);
        if (settings.cookieJar !== false && setCookies.length) jar.cookies = storeSetCookies(jar.cookies, setCookies, res.url || spec.url);
      } catch (e) {
        record.error = errMsg(e);
      }

      if (record.response) {
        const sentDraft = { ...draft, method: spec.method, url: spec.url, headers: spec.headers.map((x) => ({ ...x, enabled: true })) };
        const post = makeSandbox({ ...sandboxBase, info: { ...info, eventName: 'test', location, locationCurrent: item.name }, request: sentDraft, response: record.response, where: 'test' });
        for (const n of nodes) {
          out.legacyTests = {};
          post.tests = out.legacyTests;
          await runScript(n.test, `${labelOf(n)} test script`, post, out);
          for (const [name, v] of Object.entries(out.legacyTests)) out.tests.push({ name, passed: !!v, error: v ? null : 'tests[] value was falsy', skipped: false });
        }
      }
    }
  }

  record.visualizer = out.visualizer;
  record.nextRequest = out.nextRequest;
  record.durationMs = Date.now() - started;
  record.failed = isFailed(record);
  return record;
}

// ---------- Collection run ----------

const scopeMaps = (s) => ({
  environment: s.environment instanceof Map ? s.environment : new Map(Object.entries(s.environment || {})),
  collection: s.collection instanceof Map ? s.collection : new Map(Object.entries(s.collection || {})),
  globals: s.globals instanceof Map ? s.globals : new Map(Object.entries(s.globals || {})),
});

// entries: [{ item, chain }] in run order. scopes: Maps that the run mutates.
export async function runCollection(cfg, hooks = {}) {
  const { entries, scopes, iterations, delayMs, data = [], stopOnFailure, signal, environmentName, ctx = {} } = cfg;
  const local = new Map();
  let stopReason = null;
  let first = true;
  outer: for (let i = 0; i < iterations; i++) {
    const row = data.length ? data[Math.min(i, data.length - 1)] : {};
    const vars = createVars({ ...scopes, local, vault: ctx.vault, data: new Map(Object.entries(row)) });
    hooks.onIteration?.(i);
    let idx = 0;
    while (idx < entries.length) {
      if (signal.aborted) {
        stopReason = 'stopped';
        break outer;
      }
      if (!first && delayMs > 0) {
        await sleep(delayMs, signal);
        if (signal.aborted) {
          stopReason = 'stopped';
          break outer;
        }
      }
      first = false;
      const e = entries[idx];
      const rec = await executeRequest({
        item: e.item,
        chain: e.chain,
        vars,
        signal,
        ctx,
        info: { iteration: i, iterationCount: iterations, requestName: e.item.name, requestId: e.item.id, environmentName },
      });
      if (signal.aborted && rec.error === 'Aborted') {
        stopReason = 'stopped';
        break outer;
      }
      hooks.onResult?.(rec);
      if (rec.failed && stopOnFailure) {
        stopReason = 'failure';
        break outer;
      }
      if (rec.nextRequest === null) break;
      if (typeof rec.nextRequest === 'string') {
        const j = entries.findIndex((x) => x.item.name === rec.nextRequest || x.item.id === rec.nextRequest);
        if (j < 0) {
          hooks.onWarn?.(`setNextRequest("${rec.nextRequest}"): no such request in this run, iteration ${i + 1} ended`);
          break;
        }
        idx = j;
      } else idx++;
    }
  }
  return { stopReason };
}

// ---------- Performance (load) test ----------

// Each virtual user loops over the entries with its own copy of the variables until the
// duration ends. VUs start evenly across rampUpMs. Samples are lightweight on purpose.
export async function runPerformance(cfg, hooks = {}) {
  const { entries, scopes, vus, durationMs, rampUpMs = 0, data = [], signal, environmentName, ctx = {} } = cfg;
  const startedAt = Date.now();
  const endsAt = startedAt + durationMs;
  const vu = async (n) => {
    const startDelay = vus > 1 ? Math.round((rampUpMs * n) / vus) : 0;
    if (startDelay) await sleep(startDelay, signal);
    const own = scopeMaps({ environment: new Map(scopes.environment), collection: new Map(scopes.collection), globals: new Map(scopes.globals) });
    const vuCtx = { ...ctx, jar: { cookies: [...(ctx.jar?.cookies || [])] }, oauthCache: ctx.oauthCache };
    let loop = 0;
    while (!signal.aborted && Date.now() < endsAt) {
      const row = data.length ? data[(n + loop * vus) % data.length] : {};
      const vars = createVars({ ...own, local: new Map(), vault: ctx.vault, data: new Map(Object.entries(row)) });
      for (const e of entries) {
        if (signal.aborted || Date.now() >= endsAt) break;
        const t = Date.now();
        const rec = await executeRequest({
          item: e.item,
          chain: e.chain,
          vars,
          signal,
          ctx: vuCtx,
          info: { iteration: loop, iterationCount: 0, requestName: e.item.name, requestId: e.item.id, environmentName },
        });
        if (signal.aborted && rec.error === 'Aborted') break;
        hooks.onSample?.({
          at: t - startedAt,
          vu: n,
          itemId: e.item.id,
          name: e.item.name,
          status: rec.response?.status ?? 0,
          timeMs: rec.response?.timeMs ?? rec.durationMs,
          error: rec.error || rec.scriptErrors[0] || null,
          failed: rec.failed,
        });
      }
      loop++;
    }
  };
  await Promise.all(Array.from({ length: vus }, (_, n) => vu(n)));
  return { stopReason: signal.aborted ? 'stopped' : null, durationMs: Date.now() - startedAt };
}
