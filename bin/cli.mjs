#!/usr/bin/env node
// Command-line collection runner (Newman-style) for CI. Uses the same engine as the app
// and calls the proxy implementation directly, so no server needs to be running.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { performRequest } = await import(path.join(ROOT, 'server/proxy.mjs'));
const E = await import(path.join(ROOT, 'src/lib/engine.js'));
const M = await import(path.join(ROOT, 'src/lib/model.js'));
const { parseDataFile, formatBytes, formatMs } = await import(path.join(ROOT, 'src/lib/util.js'));

const HELP = `Usage:
  apicall run <collection> [options]   Run a collection (name or id in the workspace, or a Postman collection file)
  apicall list [--data-dir <dir>]      List collections and environments in the workspace

Options for run:
  -f, --folder <name>              Run only this folder (repeatable)
  -e, --environment <name|file>    Environment name in the workspace, or a Postman environment file
  -g, --globals <file>             Postman globals file
  -d, --iteration-data <file>      CSV or JSON data file (one iteration per row)
  -n, --iteration-count <n>        Number of iterations (default: data rows, or 1)
      --env-var <key=value>        Override an environment variable (repeatable)
      --global-var <key=value>     Override a global variable (repeatable)
      --delay-request <ms>         Delay between requests
      --timeout-request <ms>       Request timeout
      --bail                       Stop on the first failure
  -k, --insecure                   Do not verify TLS certificates
      --reporters <list>           cli,json,junit (default: cli)
      --reporter-json-export <file>
      --reporter-junit-export <file>
      --export-environment <file>  Write the environment (with values set by scripts) after the run
      --data-dir <dir>             Workspace data directory (default: ./data next to the app)
      --no-color
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folder: { type: 'string', short: 'f', multiple: true },
    environment: { type: 'string', short: 'e' },
    globals: { type: 'string', short: 'g' },
    'iteration-data': { type: 'string', short: 'd' },
    'iteration-count': { type: 'string', short: 'n' },
    'env-var': { type: 'string', multiple: true },
    'global-var': { type: 'string', multiple: true },
    'delay-request': { type: 'string' },
    'timeout-request': { type: 'string' },
    bail: { type: 'boolean' },
    insecure: { type: 'boolean', short: 'k' },
    reporters: { type: 'string' },
    'reporter-json-export': { type: 'string' },
    'reporter-junit-export': { type: 'string' },
    'export-environment': { type: 'string' },
    'data-dir': { type: 'string' },
    'no-color': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const color = !opt['no-color'] && process.stdout.isTTY;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { green: paint(32), red: paint(31), yellow: paint(33), gray: paint(90), bold: paint(1), cyan: paint(36) };

function fail(msg) {
  console.error(C.red(`error: ${msg}`));
  process.exit(2);
}

const [command, target] = positionals;
if (opt.help || !command) {
  console.log(HELP);
  process.exit(opt.help ? 0 : 2);
}

const dataDir = path.resolve(opt['data-dir'] || process.env.DATA_DIR || path.join(ROOT, 'data'));
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const loadWorkspace = () => {
  const file = path.join(dataDir, 'workspace.json');
  return M.normalizeWorkspace(fs.existsSync(file) ? readJSON(file) : {});
};

if (command === 'list') {
  const ws = loadWorkspace();
  console.log(C.bold('Collections'));
  for (const c of ws.collections) console.log(`  ${c.name} ${C.gray(`(${M.countRequests(c)} requests, id ${c.id})`)}`);
  console.log(C.bold('Environments'));
  for (const e of ws.environments) console.log(`  ${e.name} ${C.gray(`(id ${e.id})`)}`);
  process.exit(0);
}
if (command !== 'run') fail(`unknown command "${command}"`);
if (!target) fail('missing <collection>');

const ws = loadWorkspace();
E.setTransport((spec) => performRequest(spec, { dataDir }));

// Collection: workspace name/id, or a Postman collection file.
let collection = ws.collections.find((c) => c.id === target || c.name === target);
if (!collection && fs.existsSync(target)) collection = M.importPostmanCollection(readJSON(target));
if (!collection) fail(`collection "${target}" not found in ${dataDir} and is not a file`);
collection.items.forEach(function norm(n) {
  if (n.type === 'request') M.normalizeRequest(n);
  else n.items.forEach(norm);
});

let environment = null;
if (opt.environment) {
  environment = ws.environments.find((e) => e.id === opt.environment || e.name === opt.environment);
  if (!environment && fs.existsSync(opt.environment)) environment = M.importPostmanEnvironment(readJSON(opt.environment));
  if (!environment) fail(`environment "${opt.environment}" not found`);
}
const globals = opt.globals ? M.importPostmanEnvironment(readJSON(opt.globals)).values : ws.globals;

const kvArgs = (list) => (list || []).map((s) => {
  const i = s.indexOf('=');
  if (i < 1) fail(`expected key=value, got "${s}"`);
  return [s.slice(0, i), s.slice(i + 1)];
});

const scopes = {
  environment: E.toMap(environment?.values),
  collection: E.toMap(collection.variables),
  globals: E.toMap(globals),
};
for (const [k, v] of kvArgs(opt['env-var'])) scopes.environment.set(k, v);
for (const [k, v] of kvArgs(opt['global-var'])) scopes.globals.set(k, v);

// Entries: whole collection, or the named folders in collection order.
let entries = M.flattenRequests(collection, []).filter((e) => M.isHttp(e.item));
if (opt.folder?.length) {
  const wanted = new Set(opt.folder);
  entries = entries.filter((e) => e.chain.some((n) => n.type === 'folder' && wanted.has(n.name)));
  if (!entries.length) fail(`no requests found in folder(s): ${opt.folder.join(', ')}`);
}

let data = [];
if (opt['iteration-data']) {
  const file = opt['iteration-data'];
  data = parseDataFile(file, fs.readFileSync(file, 'utf8'));
}
const iterations = Number(opt['iteration-count']) || data.length || 1;

const settings = {
  ...ws.settings,
  ...(opt['timeout-request'] ? { timeoutMs: Number(opt['timeout-request']) } : {}),
  ...(opt.insecure ? { verifySsl: false } : {}),
};
const ctx = { settings, jar: { cookies: [...ws.cookies] }, vault: new Map(), oauthCache: new Map() };

const reporters = new Set((opt.reporters || 'cli').split(',').map((s) => s.trim()));
const results = [];
const warnings = [];
const started = Date.now();

console.log(`\n${C.bold(collection.name)}${environment ? C.gray(`  env: ${environment.name}`) : ''}\n`);
let lastIteration = -1;
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());

const { stopReason } = await E.runCollection(
  {
    entries,
    scopes,
    iterations,
    delayMs: Number(opt['delay-request']) || 0,
    data,
    stopOnFailure: !!opt.bail,
    signal: ac.signal,
    environmentName: environment?.name,
    ctx,
  },
  {
    onResult: (r) => {
      results.push(r);
      if (!reporters.has('cli')) return;
      if (iterations > 1 && r.iteration !== lastIteration) {
        lastIteration = r.iteration;
        console.log(C.gray(`Iteration ${r.iteration + 1}/${iterations}`));
      }
      const res = r.response;
      const meta = res ? `[${res.status} ${res.statusText}, ${formatBytes(res.size)}, ${formatMs(res.timeMs)}]` : '';
      console.log(`→ ${r.name}`);
      if (r.request) console.log(`  ${r.request.method} ${r.request.url} ${res ? (res.status < 400 ? C.gray(meta) : C.yellow(meta)) : ''}`);
      if (r.skipped) console.log(C.gray('  (skipped)'));
      if (r.error) console.log(C.red(`  ✗ ${r.error}`));
      for (const e of r.scriptErrors) console.log(C.red(`  ✗ ${e}`));
      for (const t of r.tests) {
        if (t.skipped) console.log(C.gray(`  - ${t.name} (skipped)`));
        else if (t.passed) console.log(C.green(`  ✓ ${t.name}`));
        else console.log(C.red(`  ✗ ${t.name}${t.error ? `: ${t.error}` : ''}`));
      }
      for (const w of r.warnings) console.log(C.yellow(`  ! ${w}`));
      for (const l of r.logs) console.log(C.gray(`  │ ${l.text.replace(/\n/g, '\n  │ ')}`));
    },
    onWarn: (w) => {
      warnings.push(w);
      if (reporters.has('cli')) console.log(C.yellow(`! ${w}`));
    },
  },
);

const duration = Date.now() - started;
const summary = { requests: results.length, failedRequests: 0, tests: 0, failedTests: 0, scriptErrors: 0, requestErrors: 0, avgMs: 0 };
let timed = 0;
for (const r of results) {
  if (r.failed) summary.failedRequests++;
  if (r.error) summary.requestErrors++;
  summary.scriptErrors += r.scriptErrors.length;
  for (const t of r.tests) {
    if (t.skipped) continue;
    summary.tests++;
    if (!t.passed) summary.failedTests++;
  }
  if (r.response) {
    summary.avgMs += r.response.timeMs;
    timed++;
  }
}
summary.avgMs = timed ? Math.round(summary.avgMs / timed) : 0;

if (reporters.has('cli')) {
  const row = (label, total, failed) => `  ${label.padEnd(16)}${String(total).padStart(8)}${(failed ? C.red : C.gray)(String(failed).padStart(10))}`;
  console.log(`\n  ${''.padEnd(16)}${'executed'.padStart(8)}${'failed'.padStart(10)}`);
  console.log(row('iterations', iterations, 0));
  console.log(row('requests', summary.requests, summary.requestErrors));
  console.log(row('test-scripts', summary.requests, summary.scriptErrors));
  console.log(row('assertions', summary.tests, summary.failedTests));
  console.log(C.gray(`\n  total run duration: ${formatMs(duration)}, average response time: ${summary.avgMs} ms`));
  if (stopReason) console.log(C.yellow(`  run stopped: ${stopReason}`));
}

const report = {
  collection: collection.name,
  environment: environment?.name || null,
  startedAt: new Date(started).toISOString(),
  durationMs: duration,
  stopReason,
  summary,
  warnings,
  results: results.map((r) => ({
    iteration: r.iteration + 1,
    name: r.name,
    method: r.request?.method || r.method,
    url: r.request?.url,
    status: r.response?.status,
    timeMs: r.response?.timeMs,
    failed: r.failed,
    error: r.error,
    tests: r.tests,
    scriptErrors: r.scriptErrors,
  })),
};

const writeOut = (file, text) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
};
if (reporters.has('json')) writeOut(opt['reporter-json-export'] || 'apicall-report.json', JSON.stringify(report, null, 2));
if (reporters.has('junit')) {
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
  const suites = results.map((r) => {
    const cases = r.tests.filter((t) => !t.skipped);
    const errors = [r.error, ...r.scriptErrors].filter(Boolean);
    const body = [
      ...cases.map((t) => `      <testcase name="${esc(t.name)}" classname="${esc(r.name)}">${t.passed ? '' : `<failure type="AssertionFailure" message="${esc(t.error)}"/>`}</testcase>`),
      ...errors.map((e) => `      <testcase name="${esc(r.name)} (error)" classname="${esc(r.name)}"><error message="${esc(e)}"/></testcase>`),
    ];
    const failures = cases.filter((t) => !t.passed).length;
    return `    <testsuite name="${esc(`${r.name}${iterations > 1 ? ` [${r.iteration + 1}]` : ''}`)}" tests="${body.length}" failures="${failures}" errors="${errors.length}" time="${((r.response?.timeMs || 0) / 1000).toFixed(3)}">\n${body.join('\n')}\n    </testsuite>`;
  });
  writeOut(
    opt['reporter-junit-export'] || 'apicall-report.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(collection.name)}" tests="${summary.tests}" failures="${summary.failedTests}" time="${(duration / 1000).toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`,
  );
}
if (opt['export-environment']) {
  const env = environment ? structuredClone(environment) : M.newEnvironment('exported');
  E.writeBack(env.values, scopes.environment);
  // Exported files carry the values the run ended with, as Newman does.
  env.values = env.values.map(({ current, ...v }) => ({ ...v, value: current ?? v.value }));
  writeOut(opt['export-environment'], JSON.stringify(M.exportPostmanEnvironment(env), null, 2));
}

process.exit(summary.failedRequests || stopReason === 'failure' ? 1 : 0);
