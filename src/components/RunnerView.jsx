import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useUi, useWs } from '../store.js';
import { flattenRequests } from '../lib/model.js';
import { parseDataFile, readFileText, formatMs, errMsg } from '../lib/util.js';
import { getRun, updateRunConfig, startRun, stopRun, summarize, exportRunReport } from '../runner.js';
import { toast, openView } from '../actions.js';
import ResponseView, { ResultIcon, statusClass } from './ResponseView.jsx';
import { IconCollection, IconExport, IconFolder, IconPlay, IconStop } from './icons.jsx';

function RequestPicker({ entries, excluded, onChange, disabled }) {
  const ex = new Set(excluded);
  const all = entries.length;
  const picked = entries.filter((e) => !ex.has(e.item.id)).length;
  const rootDepth = entries[0]?.chain.length ?? 0;
  return (
    <div className="picker">
      <div className="picker-head">
        <span>
          Requests <b>{picked}</b>/{all}
        </span>
        <span className="spacer" />
        <button className="link-btn" disabled={disabled} onClick={() => onChange([])}>
          All
        </button>
        <button className="link-btn" disabled={disabled} onClick={() => onChange(entries.map((e) => e.item.id))}>
          None
        </button>
      </div>
      <div className="picker-list">
        {entries.map(({ item, chain }, i) => {
          const folder = chain
            .slice(rootDepth)
            .map((c) => c.name)
            .join(' / ');
          return (
            <label key={item.id} className={`pick ${ex.has(item.id) ? 'off' : ''}`}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={!ex.has(item.id)}
                onChange={(e) => onChange(e.target.checked ? excluded.filter((id) => id !== item.id) : [...excluded, item.id])}
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
      <p className="hint small">Order follows the sidebar; drag requests there to reorder. Scripts can jump with pm.execution.setNextRequest().</p>
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
      updateRunConfig(targetId, { data: rows, dataName: file.name, iterations: rows.length });
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
          <button className="link-btn" disabled={disabled} onClick={() => updateRunConfig(targetId, { data: null, dataName: '', iterations: 1 })}>
            Remove
          </button>
        </div>
      ) : (
        <button className="btn" disabled={disabled} onClick={() => input.current.click()}>
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

export default function RunnerView({ found }) {
  useUi((s) => s.runsRev);
  const envs = useWs((s) => s.ws.environments);
  const target = found.node;
  const run = getRun(target.id);
  const cfg = run.config;
  const entries = useMemo(() => flattenRequests(target, found.chain), [target, found.chain]);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);
  useTicker(run.running);

  const set = (patch) => updateRunConfig(target.id, patch);
  const s = summarize(run);
  const elapsed = run.startedAt ? (run.finishedAt || Date.now()) - run.startedAt : 0;
  const progress = run.plannedRequests ? Math.min(100, (run.results.length / run.plannedRequests) * 100) : 0;
  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));

  const shown = run.results.filter((r) => filter === 'all' || (filter === 'failed' ? r.failed : !r.failed));
  const groups = [];
  for (const r of shown) {
    if (!groups.length || groups[groups.length - 1].iteration !== r.iteration) groups.push({ iteration: r.iteration, items: [] });
    groups[groups.length - 1].items.push(r);
  }

  const statusText = run.running
    ? `Running · iteration ${run.iteration + 1}/${run.plannedIterations}`
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
              <button className="link-btn big" onClick={() => openView({ kind: 'node', id: target.id })}>
                {target.name}
              </button>
            </h2>
          </div>
        </div>

        <RequestPicker entries={entries} excluded={cfg.excluded} disabled={run.running} onChange={(excluded) => set({ excluded })} />

        <div className="runner-form">
          <label className="field">
            <span className="field-label">Environment</span>
            <select value={envs.some((e) => e.id === cfg.envId) ? cfg.envId : ''} disabled={run.running} onChange={(e) => set({ envId: e.target.value || null })}>
              <option value="">No environment</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
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
          <DataFile cfg={cfg} targetId={target.id} disabled={run.running} />
          <label className="check">
            <input type="checkbox" checked={cfg.persist} disabled={run.running} onChange={(e) => set({ persist: e.target.checked })} />
            Save variable changes back to the environment / collection
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.stopOnFailure} disabled={run.running} onChange={(e) => set({ stopOnFailure: e.target.checked })} />
            Stop on first failure (failed test, script error or network error)
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.keepBodies} disabled={run.running} onChange={(e) => set({ keepBodies: e.target.checked })} />
            Save response bodies (needed to inspect them below)
          </label>
        </div>

        <div className="runner-actions">
          {run.running ? (
            <button className="btn danger wide" onClick={() => stopRun(target.id)}>
              <IconStop /> Stop
            </button>
          ) : (
            <button className="btn primary wide" onClick={() => startRun(target.id)}>
              <IconPlay /> Run {target.name}
            </button>
          )}
        </div>
      </section>

      <section className="runner-results">
        <div className="results-head">
          <div>
            <div className={`run-status ${run.running ? 'running' : ''}`}>{statusText}</div>
            {run.startedAt && (
              <div className="hint small">
                {new Date(run.startedAt).toLocaleString()} · {formatMs(elapsed)}
                {run.envName ? ` · env: ${run.envName}` : ''}
              </div>
            )}
          </div>
          <span className="spacer" />
          <button className="btn ghost" disabled={!run.results.length} onClick={() => exportRunReport(target.id)}>
            <IconExport /> Export report
          </button>
        </div>
        {run.startedAt && (
          <div className="progress">
            <div className={`bar ${s.failed ? 'has-fail' : ''}`} style={{ width: `${run.running ? progress : 100}%` }} />
          </div>
        )}

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

        {run.warnings.length > 0 && (
          <div className="warnings">
            {run.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        <div className="tabs result-filter">
          {[
            ['all', `All (${run.results.length})`],
            ['passed', `Passed (${s.passed})`],
            ['failed', `Failed (${s.failed})`],
          ].map(([k, label]) => (
            <button key={k} className={`tab ${filter === k ? 'on' : ''} ${k === 'failed' && s.failed ? 'bad' : ''}`} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>

        <div className="results">
          {!run.results.length && !run.running && (
            <div className="results-empty">
              <p>Pick the requests and options on the left, then press Run.</p>
              <p className="hint">
                Each request runs its pre-request scripts, is sent, then runs its tests. Variables set by one request are available to the next.
              </p>
            </div>
          )}
          {groups.map((g) => (
            <div key={`${g.iteration}-${g.items[0].id}`} className="iter-group">
              {run.plannedIterations > 1 && (
                <div className="iter-head">
                  Iteration {g.iteration + 1}
                  {cfg.data?.[g.iteration] ? <span className="hint small mono"> {JSON.stringify(cfg.data[g.iteration]).slice(0, 120)}</span> : null}
                </div>
              )}
              {g.items.map((rec) => (
                <ResultRow key={rec.id} rec={rec} open={openId === rec.id} onToggle={toggle} />
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
