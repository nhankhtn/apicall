// Collection runs and load tests. Run state is kept outside React state (results can be large);
// components re-render by watching `runsRev` in the UI store.
import { useUi, setUi, getWs } from './store.js';
import { findNode, flattenRequests, isHttp } from './lib/model.js';
import { isFailed } from './lib/engine.js';
import { scopesFor, applyJobState, toast, jobContext } from './actions.js';
import { runInWorker } from './engineClient.js';
import { download, errMsg, uid } from './lib/util.js';
import * as db from './db.js';

const MAX_KEPT_BODY = 256 * 1024;
const MAX_SAVED_RESULTS = 2000;
const runs = new Map();

let bumpQueued = false;
export function bump() {
  if (bumpQueued) return;
  bumpQueued = true;
  requestAnimationFrame(() => {
    bumpQueued = false;
    setUi((s) => ({ runsRev: s.runsRev + 1 }));
  });
}

export function getRun(targetId) {
  if (!runs.has(targetId)) {
    runs.set(targetId, {
      targetId,
      config: {
        envId: useUi.getState().envId,
        iterations: 1,
        delayMs: 0,
        data: null,
        dataName: '',
        stopOnFailure: false,
        persist: true,
        keepBodies: true,
        excluded: [],
        order: [],
        vus: 10,
        durationSec: 30,
        rampUpSec: 5,
      },
      results: [],
      samples: [],
      warnings: [],
      running: false,
      kind: null,
      stop: null,
      startedAt: null,
      finishedAt: null,
      stopReason: null,
      iteration: 0,
      plannedIterations: 0,
      plannedRequests: 0,
      history: null, // past runs from the server, loaded on demand
      viewing: null, // a past run being looked at
    });
  }
  return runs.get(targetId);
}

export function updateRunConfig(targetId, patch) {
  const run = getRun(targetId);
  run.config = { ...run.config, ...patch };
  // Re-render right away: these are form edits, and controlled inputs must not lag a frame.
  setUi((s) => ({ runsRev: s.runsRev + 1 }));
}

// Requests of the target in run order: the custom order first, then anything new in tree order.
export function orderedEntries(target, chain, order) {
  // Only HTTP requests take part in runs, as in Postman's collection runner.
  const entries = flattenRequests(target, chain).filter((e) => isHttp(e.item));
  if (!order?.length) return entries;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...entries].sort((a, b) => (pos.get(a.item.id) ?? 1e9) - (pos.get(b.item.id) ?? 1e9));
}

export function summarize(results) {
  const s = { requests: 0, passed: 0, failed: 0, testsPassed: 0, testsFailed: 0, errors: 0, totalTime: 0, timed: 0 };
  for (const r of results) {
    s.requests++;
    if (r.failed) s.failed++;
    else s.passed++;
    for (const t of r.tests) {
      if (t.skipped) continue;
      if (t.passed) s.testsPassed++;
      else s.testsFailed++;
    }
    if (r.error || r.scriptErrors.length) s.errors++;
    if (r.response) {
      s.totalTime += r.response.timeMs;
      s.timed++;
    }
  }
  s.avgTime = s.timed ? Math.round(s.totalTime / s.timed) : 0;
  return s;
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export function perfStats(samples, durationMs) {
  const times = samples.map((s) => s.timeMs).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.failed).length;
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));
  const buckets = Array.from({ length: seconds }, (_, t) => ({ t, count: 0, errors: 0, total: 0 }));
  const perRequest = new Map();
  for (const s of samples) {
    const b = buckets[Math.min(seconds - 1, Math.floor(s.at / 1000))];
    b.count++;
    b.total += s.timeMs;
    if (s.failed) b.errors++;
    if (!perRequest.has(s.itemId)) perRequest.set(s.itemId, { name: s.name, times: [], errors: 0, statuses: {} });
    const pr = perRequest.get(s.itemId);
    pr.times.push(s.timeMs);
    if (s.failed) pr.errors++;
    pr.statuses[s.status || 'ERR'] = (pr.statuses[s.status || 'ERR'] || 0) + 1;
  }
  return {
    total: samples.length,
    errors,
    errorRate: samples.length ? errors / samples.length : 0,
    rps: samples.length / (durationMs / 1000 || 1),
    avg: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    min: times[0] || 0,
    max: times[times.length - 1] || 0,
    p50: percentile(times, 50),
    p90: percentile(times, 90),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    timeline: buckets.map((b) => ({ t: b.t, rps: b.count, errors: b.errors, avg: b.count ? Math.round(b.total / b.count) : null })),
    perRequest: [...perRequest.values()].map((r) => {
      const sorted = r.times.sort((a, b) => a - b);
      return {
        name: r.name,
        count: sorted.length,
        errors: r.errors,
        avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        statuses: r.statuses,
      };
    }),
  };
}

function trimRecord(rec, keepBodies) {
  const res = rec.response;
  if (!res) return rec;
  if (!keepBodies) return { ...rec, response: { ...res, body: '', bodyDropped: true } };
  if (res.body && res.body.length > MAX_KEPT_BODY) return { ...rec, response: { ...res, body: res.body.slice(0, MAX_KEPT_BODY), bodyTruncated: true } };
  return rec;
}

function prepare(targetId) {
  const run = getRun(targetId);
  if (run.running) return null;
  const ws = getWs();
  const f = findNode(ws, targetId);
  if (!f) return null;
  const excluded = new Set(run.config.excluded);
  const entries = orderedEntries(f.node, f.chain, run.config.order).filter((e) => !excluded.has(e.item.id));
  if (!entries.length) {
    toast('No requests selected to run', 'error');
    return null;
  }
  const env = ws.environments.find((e) => e.id === run.config.envId) || null;
  return { run, f, entries, env, scopes: scopesFor(f.collection, env) };
}

function saveRunHistory(entry) {
  db.runsPut(entry)
    .then(() => {
      const run = getRun(entry.targetId);
      if (run.history) {
        run.history = [summaryOf(entry), ...run.history.filter((h) => h.id !== entry.id)];
        bump();
      }
    })
    .catch(() => {});
}

const summaryOf = ({ results, samples, ...rest }) => rest;

export async function startRun(targetId) {
  const p = prepare(targetId);
  if (!p) return;
  const { run, f, entries, env, scopes } = p;
  const iterations = Math.max(1, Number(run.config.iterations) || 1);
  Object.assign(run, {
    id: uid(),
    kind: 'functional',
    results: [],
    samples: [],
    warnings: [],
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    stopReason: null,
    iteration: 0,
    plannedIterations: iterations,
    plannedRequests: entries.length * iterations,
    envName: env?.name || null,
    viewing: null,
  });
  const job = runInWorker(
    'run',
    {
      entries,
      scopes,
      iterations,
      delayMs: Math.max(0, Number(run.config.delayMs) || 0),
      data: run.config.data || [],
      stopOnFailure: run.config.stopOnFailure,
      environmentName: env?.name,
      ctx: jobContext(),
    },
    (event, value) => {
      if (event === 'iteration') run.iteration = value;
      if (event === 'result') run.results.push(trimRecord(value, run.config.keepBodies));
      if (event === 'warn') run.warnings.push(value);
      bump();
    },
  );
  run.stop = job.stop;
  bump();

  try {
    const result = await job.promise;
    run.stopReason = result.stopReason;
    if (result.killed) run.warnings.push('A script did not stop; the run was terminated and its variable changes were discarded.');
    else if (run.config.persist) applyJobState(env?.id, f.collection.id, result);
  } catch (e) {
    run.stopReason = 'error';
    run.warnings.push(`Run aborted: ${errMsg(e)}`);
  }
  run.running = false;
  run.finishedAt = Date.now();
  bump();

  const s = summarize(run.results);
  saveRunHistory({
    id: run.id,
    kind: 'functional',
    targetId,
    targetName: f.node.name,
    envName: run.envName,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stopReason: run.stopReason,
    iterations,
    summary: s,
    warnings: run.warnings,
    results: run.results.slice(0, MAX_SAVED_RESULTS).map((r) => ({ ...r, response: r.response ? { ...r.response, body: '', bodyDropped: true } : null })),
  });
  const how = run.stopReason === 'stopped' ? 'stopped' : run.stopReason === 'failure' ? 'stopped on failure' : 'finished';
  toast(`Run ${how}: ${s.passed} passed, ${s.failed} failed`, s.failed ? 'error' : 'success', 5000);
}

export async function startPerformance(targetId) {
  const p = prepare(targetId);
  if (!p) return;
  const { run, f, entries, env, scopes } = p;
  const vus = Math.max(1, Math.min(500, Number(run.config.vus) || 1));
  const durationMs = Math.max(1, Number(run.config.durationSec) || 1) * 1000;
  const rampUpMs = Math.max(0, Number(run.config.rampUpSec) || 0) * 1000;
  Object.assign(run, {
    id: uid(),
    kind: 'performance',
    results: [],
    samples: [],
    warnings: [],
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    stopReason: null,
    plannedDurationMs: durationMs,
    vus,
    envName: env?.name || null,
    viewing: null,
  });
  const job = runInWorker('perf', { entries, scopes, vus, durationMs, rampUpMs, data: run.config.data || [], environmentName: env?.name, ctx: jobContext() }, (event, value) => {
    if (event === 'samples') run.samples.push(...value);
    bump();
  });
  run.stop = job.stop;
  bump();
  try {
    const result = await job.promise;
    run.stopReason = result.stopReason;
  } catch (e) {
    run.stopReason = 'error';
    run.warnings.push(`Load test aborted: ${errMsg(e)}`);
  }
  run.running = false;
  run.finishedAt = Date.now();
  bump();
  const stats = perfStats(run.samples, run.finishedAt - run.startedAt);
  saveRunHistory({
    id: run.id,
    kind: 'performance',
    targetId,
    targetName: f.node.name,
    envName: run.envName,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stopReason: run.stopReason,
    vus,
    summary: { requests: stats.total, failed: stats.errors, avgTime: stats.avg, p95: stats.p95, rps: Math.round(stats.rps * 10) / 10 },
    stats,
  });
  toast(`Load test ${run.stopReason === 'stopped' ? 'stopped' : 'finished'}: ${stats.total} requests, ${(stats.errorRate * 100).toFixed(1)}% errors`, stats.errors ? 'error' : 'success', 5000);
}

export const stopRun = (targetId) => getRun(targetId).stop?.();

export async function loadRunHistory(targetId) {
  const run = getRun(targetId);
  try {
    run.history = (await db.runsList(targetId)).map(summaryOf);
  } catch (e) {
    run.history = [];
    toast(`Cannot load run history: ${errMsg(e)}`, 'error');
  }
  bump();
}

export async function viewPastRun(targetId, runId) {
  const run = getRun(targetId);
  if (!runId) {
    run.viewing = null;
    return bump();
  }
  try {
    run.viewing = await db.runsGet(runId);
    if (!run.viewing) throw new Error('it was deleted');
  } catch (e) {
    toast(`Cannot open run: ${errMsg(e)}`, 'error');
  }
  bump();
}

export async function deletePastRun(targetId, runId) {
  const run = getRun(targetId);
  await db.runsDelete(runId).catch(() => {});
  run.history = (run.history || []).filter((h) => h.id !== runId);
  if (run.viewing?.id === runId) run.viewing = null;
  bump();
}

export function exportRunReport(targetId) {
  const run = getRun(targetId);
  const shown = run.viewing || run;
  const f = findNode(getWs(), targetId);
  const target = f ? [...f.chain.map((n) => n.name), f.node.name].join(' / ') : targetId;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (shown.kind === 'performance') {
    const stats = shown.stats || perfStats(shown.samples, (shown.finishedAt || Date.now()) - shown.startedAt);
    download(`load-test-${stamp}.json`, JSON.stringify({ target, environment: shown.envName, startedAt: new Date(shown.startedAt).toISOString(), vus: shown.vus, stats }, null, 2));
    return;
  }
  const report = {
    target,
    environment: shown.envName,
    startedAt: shown.startedAt && new Date(shown.startedAt).toISOString(),
    finishedAt: shown.finishedAt && new Date(shown.finishedAt).toISOString(),
    stopReason: shown.stopReason,
    summary: summarize(shown.results),
    warnings: shown.warnings,
    results: shown.results.map((r) => ({
      iteration: r.iteration + 1,
      name: r.name,
      method: r.request?.method || r.method,
      url: r.request?.url,
      status: r.response?.status,
      timeMs: r.response?.timeMs,
      failed: isFailed(r),
      error: r.error,
      skipped: r.skipped,
      tests: r.tests,
      scriptErrors: r.scriptErrors,
      warnings: r.warnings,
    })),
  };
  download(`run-report-${stamp}.json`, JSON.stringify(report, null, 2));
}
