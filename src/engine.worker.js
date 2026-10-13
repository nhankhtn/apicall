// Runs the engine off the main thread. Scripts from imported collections therefore cannot
// touch the page (DOM, localStorage, cookies of the app), and a stuck script can be killed.
import { executeRequest, runCollection, runPerformance, createVars, fetchOAuth2Token } from './lib/engine.js';
import { errMsg } from './lib/util.js';

const controllers = new Map();
// Auto-fetched OAuth 2.0 tokens, reused until they expire.
const oauthCache = new Map();
const post = (msg) => self.postMessage(msg);

const scopesOut = (s) => ({ environment: s.environment, collection: s.collection, globals: s.globals });

async function handle(id, type, p, signal) {
  if (p.ctx) p.ctx.oauthCache = oauthCache;
  if (type === 'execute') {
    const vars = createVars({ ...p.scopes, local: new Map(), data: new Map(), vault: p.ctx.vault });
    const record = await executeRequest({ item: p.item, chain: p.chain, vars, info: p.info, signal, ctx: p.ctx });
    return { record, scopes: scopesOut(p.scopes), cookies: p.ctx.jar.cookies, vault: p.ctx.vault };
  }
  if (type === 'run') {
    const { stopReason } = await runCollection(
      { ...p, signal },
      {
        onIteration: (i) => post({ id, type: 'event', event: 'iteration', value: i }),
        onResult: (record) => post({ id, type: 'event', event: 'result', value: record }),
        onWarn: (w) => post({ id, type: 'event', event: 'warn', value: w }),
      },
    );
    return { stopReason, scopes: scopesOut(p.scopes), cookies: p.ctx.jar.cookies, vault: p.ctx.vault };
  }
  if (type === 'perf') {
    let batch = [];
    const flush = () => {
      if (batch.length) post({ id, type: 'event', event: 'samples', value: batch });
      batch = [];
    };
    const timer = setInterval(flush, 250);
    try {
      const res = await runPerformance({ ...p, signal }, { onSample: (s) => batch.push(s) });
      flush();
      return res;
    } finally {
      clearInterval(timer);
    }
  }
  if (type === 'oauth2') {
    const vars = createVars({ ...p.scopes, local: new Map(), data: new Map(), vault: p.vault });
    return fetchOAuth2Token(p.oauth2, vars, { signal, settings: p.settings });
  }
  throw new Error(`Unknown engine job "${type}"`);
}

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  if (type === 'abort') {
    controllers.get(id)?.abort();
    return;
  }
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  try {
    post({ id, type: 'done', result: await handle(id, type, payload, ctrl.signal) });
  } catch (e) {
    post({ id, type: 'error', error: errMsg(e) });
  } finally {
    controllers.delete(id);
  }
};
