import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useUi, useWs, setSubTab } from '../store.js';
import { findNode } from '../lib/model.js';
import { parseDataFile, readFileText, formatMs, errMsg } from '../lib/util.js';
import * as R from '../runner.js';
import { toast, openTab } from '../actions.js';
import ResponseView, { ResultIcon, statusClass } from './ResponseView.jsx';
import { LatencyChart, ThroughputChart } from './PerfCharts.jsx';
import { IconCollection, IconExport, IconFolder, IconPlay, IconStop } from './icons.jsx';
import { Select } from './Menu.jsx';

function RequestPicker({ entries, cfg, targetId, disabled }) {
  const ex = new Set(cfg.excluded);
  const picked = entries.filter((e) => !ex.has(e.item.id)).length;
  const rootDepth = entries.length ? Math.min(...entries.map((e) => e.chain.length)) : 0;
  const dragId = useRef(null);
  const [over, setOver] = useState(null);
  const set = (patch) => R.updateRunConfig(targetId, patch);
  const move = (from, to) => {
    const ids = entries.map((e) => e.item.id);
    const [moved] = ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to), 0, moved);
    set({ order: ids });
  };
  return (
    <div className="picker">
      <div className="picker-head">
        <span>
          Run order <b>{picked}</b>/{entries.length}
        </span>
        <span className="spacer" />
        <button className="link-btn" disabled={disabled} onClick={() => set({ excluded: [] })}>
          All
        </button>
        <button className="link-btn" disabled={disabled} onClick={() => set({ excluded: entries.map((e) => e.item.id) })}>
          None
        </button>
        <button className="link-btn" disabled={disabled || !cfg.order.length} onClick={() => set({ order: [] })} title="Use the sidebar order again">
          Reset order
        </button>
      </div>
      <div className="picker-list">
        {entries.map(({ item, chain }, i) => {
          const folder = chain.slice(rootDepth).map((c) => c.name).join(' / ');
          return (
            <label
              key={item.id}
              className={`pick ${ex.has(item.id) ? 'off' : ''} ${over === item.id ? 'drop-over' : ''}`}
              draggable={!disabled}
              onDragStart={(e) => {
                dragId.current = item.id;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!dragId.current) return;
                e.preventDefault();
                setOver(item.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId.current && dragId.current !== item.id) move(dragId.current, item.id);
                dragId.current = null;
                setOver(null);
              }}
            >
              <span className="grip" aria-hidden>
                ⋮⋮
              </span>
              <input
                type="checkbox"
                disabled={disabled}
                checked={!ex.has(item.id)}
                onChange={(e) => set({ excluded: e.target.checked ? cfg.excluded.filter((id) => id !== item.id) : [...cfg.excluded, item.id] })}
              />
              <span className="pick-idx">{i + 1}</span>
              <span className={`method-tag m-${item.method}`}>{item.method}</span>
              <span className="pick-name" title={item.url}>
                {folder && <span className="pick-folder">{folder} / </span>}
                {item.name}
              </span>
            </label>
          );
        })}
      </div>
      <p className="hint small">Drag to change the run order for this runner only. Scripts can jump with pm.execution.setNextRequest().</p>
    </div>
  );
}

function DataFile({ cfg, targetId, disabled }) {
  const input = useRef(null);
  const [preview, setPreview] = useState(false);
  const load = async (file) => {
    try {
      const rows = parseDataFile(file.name, await readFileText(file));
      if (!rows.length) throw new Error('the file has no data rows');
      R.updateRunConfig(targetId, { data: rows, dataName: file.name, iterations: rows.length });
      toast(`Loaded ${rows.length} row(s) from ${file.name}`, 'success');
    } catch (e) {
      toast(`Cannot read ${file.name}: ${errMsg(e)}`, 'error', 6000);
    }
  };
  const cols = cfg.data ? Object.keys(cfg.data[0] || {}) : [];
  return (
    <div className="field">
      <span className="field-label">Data file (CSV / JSON)</span>
      <input
        ref={input}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        hidden
        onChange={(e) => {
          if (e.target.files[0]) load(e.target.files[0]);
          e.target.value = '';
        }}
      />
      {cfg.data ? (
        <div className="datafile">
          <span className="mono">{cfg.dataName}</span>
          <span className="hint small">
            {cfg.data.length} rows · {cols.length} columns
          </span>
          <span className="spacer" />
          <button className="link-btn" onClick={() => setPreview(!preview)}>
            {preview ? 'Hide' : 'Preview'}
          </button>
          <button className="link-btn" disabled={disabled} onClick={() => R.updateRunConfig(targetId, { data: null, dataName: '', iterations: 1 })}>
            Remove
          </button>
        </div>
      ) : (
        <button className="btn small" disabled={disabled} onClick={() => input.current.click()}>
          Select file
        </button>
      )}
      {cfg.data && preview && (
        <div className="data-preview">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cfg.data.slice(0, 20).map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  {cols.map((c) => (
                    <td key={c}>{typeof row[c] === 'string' ? row[c] : JSON.stringify(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {cfg.data.length > 20 && <p className="hint small">…and {cfg.data.length - 20} more rows</p>}
        </div>
      )}
      <p className="hint small">Each row is one iteration. Use columns as {'{{column}}'} or pm.iterationData.get("column").</p>
    </div>
  );
}

const ResultRow = memo(function ResultRow({ rec, open, onToggle }) {
  const res = rec.response;
  const tests = rec.tests.filter((t) => !t.skipped);
  const passed = tests.filter((t) => t.passed).length;
  return (
    <div className={`result ${open ? 'open' : ''} ${rec.failed ? 'failed' : ''}`}>
      <div className="result-row" onClick={() => onToggle(rec.id)}>
        <ResultIcon record={rec} />
        <span className={`method-tag m-${rec.method}`}>{rec.method}</span>
        <span className="result-name">{rec.name}</span>
        <span className="result-url mono" title={rec.request?.url}>
          {rec.request?.url}
        </span>
        {res ? <span className={`status ${statusClass(res.status)}`}>{res.status}</span> : <span className="status s5">{rec.skipped ? 'skip' : 'ERR'}</span>}
        <span className="result-time">{res ? formatMs(res.timeMs) : ''}</span>
        <span className={`result-tests ${tests.length && passed < tests.length ? 'bad' : ''}`}>{tests.length ? `${passed}/${tests.length}` : '–'}</span>
      </div>
      {!open && (rec.error || rec.scriptErrors.length > 0 || tests.some((t) => !t.passed)) && (
        <div className="result-errors">
          {rec.error && <div>{rec.error}</div>}
          {rec.scriptErrors.map((e, i) => (
            <div key={`s${i}`}>{e}</div>
          ))}
          {tests
            .filter((t) => !t.passed)
            .map((t, i) => (
              <div key={`t${i}`}>
                ✗ {t.name}
                {t.error ? `: ${t.error}` : ''}
              </div>
            ))}
        </div>
      )}
      {open && (
        <div className="result-detail">
          <ResponseView record={rec} compact />
        </div>
      )}
    </div>
  );
});

function useTicker(active) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setN((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [active]);
}

function FunctionalResults({ shown, live, data }) {
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);
  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));
  const s = R.summarize(shown.results);
  const list = shown.results.filter((r) => filter === 'all' || (filter === 'failed' ? r.failed : !r.failed));
  const groups = [];
  for (const r of list) {
    if (!groups.length || groups[groups.length - 1].iteration !== r.iteration) groups.push({ iteration: r.iteration, items: [] });
    groups[groups.length - 1].items.push(r);
  }
  const multi = (shown.plannedIterations || shown.iterations || 1) > 1;
  return (
    <>
      <div className="cards">
        <div className="card">
          <b>{s.requests}</b>
          <span>Requests</span>
        </div>
        <div className="card good">
          <b>{s.testsPassed}</b>
          <span>Tests passed</span>
        </div>
        <div className={`card ${s.testsFailed ? 'bad' : ''}`}>
          <b>{s.testsFailed}</b>
          <span>Tests failed</span>
        </div>
        <div className={`card ${s.errors ? 'bad' : ''}`}>
          <b>{s.errors}</b>
          <span>Errors</span>
        </div>
        <div className="card">
          <b>{formatMs(s.avgTime) || '0 ms'}</b>
          <span>Avg response</span>
        </div>
      </div>
      {shown.warnings?.length > 0 && (
        <div className="warnings">
          {shown.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
      <div className="tabs result-filter">
        {[
          ['all', `All (${shown.results.length})`],
          ['passed', `Passed (${s.passed})`],
          ['failed', `Failed (${s.failed})`],
        ].map(([k, label]) => (
          <button key={k} className={`tab ${filter === k ? 'on' : ''} ${k === 'failed' && s.failed ? 'bad' : ''}`} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="results">
        {!shown.results.length && !live && (
          <div className="results-empty">
            <p>Pick the requests and options on the left, then press Run.</p>
            <p className="hint">Each request runs its pre-request scripts, is sent, then runs its tests. Variables set by one request are available to the next.</p>
          </div>
        )}
        {groups.map((g) => (
          <div key={`${g.iteration}-${g.items[0].id}`} className="iter-group">
            {multi && (
              <div className="iter-head">
                Iteration {g.iteration + 1}
                {data?.[g.iteration] ? <span className="hint small mono"> {JSON.stringify(data[g.iteration]).slice(0, 120)}</span> : null}
              </div>
            )}
            {g.items.map((rec) => (
              <ResultRow key={rec.id} rec={rec} open={openId === rec.id} onToggle={toggle} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function PerfResults({ shown, live }) {
  const stats = useMemo(
    () => shown.stats || R.perfStats(shown.samples || [], ((shown.finishedAt || Date.now()) - (shown.startedAt || Date.now())) || 1),
    // Recompute as samples arrive during a live run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, shown.samples?.length, live],
  );
  if (!stats.total && !live) {
    return (
      <div className="results-empty">
        <p>Simulate many users calling the selected requests at once.</p>
        <p className="hint">Each virtual user runs the requests in order, in a loop, until the duration ends. Scripts and tests run for every request.</p>
      </div>
    );
  }
  return (
    <div className="results perf">
      <div className="cards">
        <div className="card">
          <b>{stats.total}</b>
          <span>Requests</span>
        </div>
        <div className="card">
          <b>{stats.rps.toFixed(1)}</b>
          <span>Requests / s</span>
        </div>
        <div className="card">
          <b>{stats.avg} ms</b>
          <span>Avg response</span>
        </div>
        <div className="card">
          <b>{stats.p95} ms</b>
          <span>P95 response</span>
        </div>
        <div className={`card ${stats.errors ? 'bad' : 'good'}`}>
          <b>{(stats.errorRate * 100).toFixed(2)}%</b>
          <span>Error rate</span>
        </div>
      </div>
      <div className="charts">
        <LatencyChart timeline={stats.timeline} />
        <ThroughputChart timeline={stats.timeline} />
      </div>
      <table className="htable perf-table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Count</th>
            <th>Avg</th>
            <th>P90</th>
            <th>P95</th>
            <th>Errors</th>
            <th>Status codes</th>
          </tr>
        </thead>
        <tbody>
          {stats.perRequest.map((r) => (
            <tr key={r.name}>
              <td className="hk">{r.name}</td>
              <td>{r.count}</td>
              <td>{r.avg} ms</td>
              <td>{r.p90} ms</td>
              <td>{r.p95} ms</td>
              <td className={r.errors ? 'bad-text' : ''}>{r.errors}</td>
              <td className="mono small">
                {Object.entries(r.statuses)
                  .map(([k, v]) => `${k}×${v}`)
                  .join('  ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint small">
        min {stats.min} ms · p50 {stats.p50} ms · p90 {stats.p90} ms · p99 {stats.p99} ms · max {stats.max} ms. Requests go through the local proxy, so its overhead is included.
      </p>
    </div>
  );
}

function HistoryPanel({ targetId, run }) {
  useEffect(() => {
    if (!run.history) R.loadRunHistory(targetId);
  }, [targetId, run.history]);
  if (!run.history) return <p className="hint pad">Loading…</p>;
  if (!run.history.length) return <div className="results-empty">No past runs yet. Each finished run is saved here.</div>;
  return (
    <div className="results">
      {run.history.map((h) => (
        <div key={h.id} className={`result past-run ${run.viewing?.id === h.id ? 'open' : ''}`}>
          <div className="result-row" onClick={() => R.viewPastRun(targetId, h.id)}>
            <span className={`kind-tag ${h.kind}`}>{h.kind === 'performance' ? 'Load' : 'Run'}</span>
            <span className="result-name">{new Date(h.startedAt).toLocaleString()}</span>
            <span className="result-url">
              {h.envName ? `env: ${h.envName} · ` : ''}
              {h.kind === 'performance' ? `${h.vus} VUs, ${h.summary.rps} req/s, p95 ${h.summary.p95} ms` : `${h.iterations} iteration(s), ${formatMs(h.finishedAt - h.startedAt)}`}
            </span>
            <span className={`status ${h.summary.failed ? 's5' : 's2'}`}>{h.summary.failed ? `${h.summary.failed} failed` : 'passed'}</span>
            <button
              className="icon-btn"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                R.deletePastRun(targetId, h.id);
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RunnerView({ id }) {
  useUi((s) => s.runsRev);
  const ws = useWs((s) => s.ws);
  const mode = useUi((s) => s.subTabs.runner);
  const found = useMemo(() => findNode(ws, id), [ws, id]);
  const run = R.getRun(id);
  const [panel, setPanel] = useState('results');
  useTicker(run.running);
  if (!found || found.node.type === 'request') return <div className="empty-view">This collection or folder no longer exists.</div>;
  const target = found.node;
  const cfg = run.config;
  const entries = R.orderedEntries(target, found.chain, cfg.order);
  const set = (patch) => R.updateRunConfig(id, patch);
  const perf = mode === 'performance';
  const shown = run.viewing || run;
  const shownKind = shown.kind || (perf ? 'performance' : 'functional');
  const elapsed = shown.startedAt ? (shown.finishedAt || Date.now()) - shown.startedAt : 0;
  const progress = run.running
    ? run.kind === 'performance'
      ? Math.min(100, (elapsed / (run.plannedDurationMs || 1)) * 100)
      : run.plannedRequests
        ? Math.min(100, (run.results.length / run.plannedRequests) * 100)
        : 0
    : 100;
  const statusText = run.viewing
    ? `Past run · ${new Date(run.viewing.startedAt).toLocaleString()}`
    : run.running
      ? run.kind === 'performance'
        ? `Load test running · ${run.vus} virtual users`
        : `Running · iteration ${run.iteration + 1}/${run.plannedIterations}`
      : run.stopReason === 'stopped'
        ? 'Stopped'
        : run.stopReason === 'failure'
          ? 'Stopped on first failure'
          : run.finishedAt
            ? 'Finished'
            : 'Not run yet';

  return (
    <div className="runner">
      <section className="runner-config">
        <div className="runner-title">
          {target.type === 'collection' ? <IconCollection className="head-ico" /> : <IconFolder className="head-ico" />}
          <div>
            <div className="crumbs">
              {found.chain.map((c) => (
                <span key={c.id}>{c.name} /</span>
              ))}
            </div>
            <h2>
              Run{' '}
              <button className="link-btn big" onClick={() => openTab('node', target.id, { preview: false })}>
                {target.name}
              </button>
            </h2>
          </div>
        </div>

        <div className="seg mode-seg">
          <button className={!perf ? 'on' : ''} disabled={run.running} onClick={() => setSubTab('runner', 'functional')}>
            Functional
          </button>
          <button className={perf ? 'on' : ''} disabled={run.running} onClick={() => setSubTab('runner', 'performance')}>
            Performance
          </button>
        </div>

        <RequestPicker entries={entries} cfg={cfg} targetId={id} disabled={run.running} />

        <div className="runner-form">
          <div className="field">
            <span className="field-label">Environment</span>
            <Select
              value={ws.environments.some((e) => e.id === cfg.envId) ? cfg.envId : ''}
              disabled={run.running}
              onChange={(v) => set({ envId: v || null })}
              options={[{ value: '', label: 'No environment' }, ...ws.environments.map((e) => ({ value: e.id, label: e.name }))]}
            />
          </div>
          {perf ? (
            <>
              <div className="field-row three">
                <label className="field">
                  <span className="field-label">Virtual users</span>
                  <input type="number" min="1" max="500" value={cfg.vus} disabled={run.running} onChange={(e) => set({ vus: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Duration (s)</span>
                  <input type="number" min="1" value={cfg.durationSec} disabled={run.running} onChange={(e) => set({ durationSec: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Ramp-up (s)</span>
                  <input type="number" min="0" value={cfg.rampUpSec} disabled={run.running} onChange={(e) => set({ rampUpSec: e.target.value })} />
                </label>
              </div>
              <DataFile cfg={cfg} targetId={id} disabled={run.running} />
              <p className="hint small">Load tests generate real traffic. Point them at test environments, not production.</p>
            </>
          ) : (
            <>
              <div className="field-row">
                <label className="field">
                  <span className="field-label">Iterations</span>
                  <input type="number" min="1" value={cfg.iterations} disabled={run.running} onChange={(e) => set({ iterations: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">Delay (ms)</span>
                  <input type="number" min="0" step="100" value={cfg.delayMs} disabled={run.running} onChange={(e) => set({ delayMs: e.target.value })} />
                </label>
              </div>
              <DataFile cfg={cfg} targetId={id} disabled={run.running} />
              <label className="check">
                <input type="checkbox" checked={cfg.persist} disabled={run.running} onChange={(e) => set({ persist: e.target.checked })} />
                Keep variable values (save changes back to the environment / collection)
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.stopOnFailure} disabled={run.running} onChange={(e) => set({ stopOnFailure: e.target.checked })} />
                Stop run on first failure (failed test, script error or network error)
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.keepBodies} disabled={run.running} onChange={(e) => set({ keepBodies: e.target.checked })} />
                Save response bodies (needed to inspect them below)
              </label>
            </>
          )}
        </div>

        <div className="runner-actions">
          {run.running ? (
            <button className="btn danger wide" onClick={() => R.stopRun(id)}>
              <IconStop /> Stop
            </button>
          ) : (
            <button
              className="btn primary wide"
              onClick={() => {
                setPanel('results');
                (perf ? R.startPerformance : R.startRun)(id);
              }}
            >
              <IconPlay /> {perf ? 'Run load test' : `Run ${target.name}`}
            </button>
          )}
        </div>
      </section>

      <section className="runner-results">
        <div className="results-head">
          <div>
            <div className={`run-status ${run.running ? 'running' : ''}`}>{statusText}</div>
            {shown.startedAt && (
              <div className="hint small">
                {new Date(shown.startedAt).toLocaleString()} · {formatMs(elapsed)}
                {shown.envName ? ` · env: ${shown.envName}` : ''}
              </div>
            )}
          </div>
          <span className="spacer" />
          {run.viewing && (
            <button className="btn small" onClick={() => R.viewPastRun(id, null)}>
              Back to current run
            </button>
          )}
          <div className="seg">
            <button className={panel === 'results' ? 'on' : ''} onClick={() => setPanel('results')}>
              Results
            </button>
            <button className={panel === 'history' ? 'on' : ''} onClick={() => setPanel('history')}>
              History
            </button>
          </div>
          <button className="btn small ghost" disabled={!shown.startedAt} onClick={() => R.exportRunReport(id)}>
            <IconExport /> Export
          </button>
        </div>
        {shown.startedAt && panel === 'results' && (
          <div className="progress">
            <div className="bar" style={{ width: `${progress}%` }} />
          </div>
        )}
        {panel === 'history' ? (
          <HistoryPanel targetId={id} run={run} />
        ) : shownKind === 'performance' ? (
          <PerfResults shown={shown} live={run.running && !run.viewing} />
        ) : (
          <FunctionalResults shown={shown} live={run.running && !run.viewing} data={run.viewing ? null : cfg.data} />
        )}
      </section>
    </div>
  );
}
