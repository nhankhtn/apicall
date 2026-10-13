import { useMemo, useRef, useState } from 'react';
import Handlebars from 'handlebars/dist/cjs/handlebars.js';
import CodeEditor from './CodeEditor.jsx';
import { useUi, setSubTab } from '../store.js';
import { formatBytes, formatMs, prettyBody, eqi } from '../lib/util.js';
import { parseSetCookie, formatCookie } from '../lib/cookies.js';
import { toast, saveExample } from '../actions.js';
import { IconAlert, IconCheck, IconCopy, IconX, IconSearch, IconExport } from './icons.jsx';

const PRETTY_LIMIT = 3 * 1024 * 1024;

export const statusClass = (code) => (code >= 500 ? 's5' : code >= 400 ? 's4' : code >= 300 ? 's3' : code >= 200 ? 's2' : 's1');

const STATUS_HINT = {
  200: 'OK: the request succeeded.',
  201: 'Created: a new resource was created.',
  204: 'No Content: success, no body.',
  301: 'Moved Permanently.',
  302: 'Found: temporary redirect.',
  304: 'Not Modified.',
  400: 'Bad Request: the server could not understand the request.',
  401: 'Unauthorized: authentication is missing or invalid.',
  403: 'Forbidden: authenticated but not allowed.',
  404: 'Not Found.',
  405: 'Method Not Allowed.',
  409: 'Conflict.',
  415: 'Unsupported Media Type: check Content-Type.',
  422: 'Unprocessable Entity: validation failed.',
  429: 'Too Many Requests: rate limited.',
  500: 'Internal Server Error.',
  502: 'Bad Gateway.',
  503: 'Service Unavailable.',
  504: 'Gateway Timeout.',
};

function HeaderTable({ headers }) {
  if (!headers?.length) return <p className="hint pad">No headers.</p>;
  return (
    <table className="htable">
      <tbody>
        {headers.map((x, i) => (
          <tr key={i}>
            <td className="hk">{x.key}</td>
            <td className="hv">{x.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CookieTable({ response }) {
  const cookies = response.headers
    .filter((x) => eqi(x.key, 'set-cookie'))
    .map((x) => {
      try {
        return parseSetCookie(x.value, response.url || 'http://localhost/');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!cookies.length) return <p className="hint pad">This response set no cookies.</p>;
  return (
    <table className="htable cookies">
      <thead>
        <tr>
          <th>Name</th>
          <th>Value</th>
          <th>Domain</th>
          <th>Path</th>
          <th>Expires</th>
          <th>HttpOnly</th>
          <th>Secure</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => (
          <tr key={i} title={formatCookie(c)}>
            <td className="hk">{c.name}</td>
            <td className="hv">{c.value}</td>
            <td>{c.domain}</td>
            <td>{c.path}</td>
            <td>{c.expires ? new Date(c.expires).toLocaleString() : 'Session'}</td>
            <td>{c.httpOnly ? 'true' : 'false'}</td>
            <td>{c.secure ? 'true' : 'false'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TestList({ tests }) {
  const [filter, setFilter] = useState('all');
  if (!tests.length) return <p className="hint pad">No tests ran. Add some in the Tests tab, e.g. pm.test("Status 200", () =&gt; pm.response.to.have.status(200)).</p>;
  const shown = tests.filter((t) => filter === 'all' || (filter === 'passed' ? t.passed && !t.skipped : filter === 'failed' ? !t.passed : t.skipped));
  return (
    <>
      <div className="seg test-filter">
        {['all', 'passed', 'skipped', 'failed'].map((k) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <ul className="tests">
        {shown.map((t, i) => (
          <li key={i} className={t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}>
            <span className="tbadge">{t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'}</span>
            <span className="tname">{t.name}</span>
            {t.error && <div className="terr">{t.error}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

export function ConsoleList({ record }) {
  const items = [
    ...record.warnings.map((text) => ({ level: 'warn', where: 'runner', text })),
    ...record.scriptErrors.map((text) => ({ level: 'error', where: 'script', text })),
    ...record.logs,
  ];
  if (!items.length) return <p className="hint pad">Nothing logged. console.log() output from scripts shows up here.</p>;
  return (
    <div className="console">
      {items.map((l, i) => (
        <div key={i} className={`log ${l.level}`}>
          <span className="log-where">{l.where}</span>
          <pre>{l.text}</pre>
        </div>
      ))}
    </div>
  );
}

const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function saveToFile(response, ct) {
  const data = response.encoding === 'base64' ? toBytes(response.body) : response.body;
  const ext = /json/.test(ct) ? 'json' : /html/.test(ct) ? 'html' : /xml/.test(ct) ? 'xml' : /pdf/.test(ct) ? 'pdf' : /png/.test(ct) ? 'png' : /jpe?g/.test(ct) ? 'jpg' : 'txt';
  const url = URL.createObjectURL(new Blob([data], { type: ct || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `response.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Preview({ response, ct }) {
  const blobUrl = useMemo(() => {
    if (response.encoding !== 'base64' || !/^(image\/|application\/pdf)/.test(ct)) return null;
    return URL.createObjectURL(new Blob([toBytes(response.body)], { type: ct }));
  }, [response, ct]);
  if (blobUrl && ct.startsWith('image/')) return <div className="preview-img"><img src={blobUrl} alt="Response" /></div>;
  if (blobUrl) return <iframe className="preview-frame" title="Response preview" src={blobUrl} />;
  if (response.encoding === 'base64') return <p className="hint pad">No preview for {ct || 'this content type'}.</p>;
  // Sandboxed without same-origin: the page cannot reach the app or its storage.
  return <iframe className="preview-frame" title="Response preview" sandbox="allow-scripts" srcDoc={response.body} />;
}

function Visualize({ visualizer }) {
  const html = useMemo(() => {
    try {
      const body = Handlebars.compile(visualizer.template)(visualizer.data);
      const data = JSON.stringify(visualizer.data).replace(/</g, '\\u003c');
      // pm.getData() mirrors Postman's visualizer API for templates with their own scripts.
      return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px system-ui,sans-serif;margin:12px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style><script>var pm={getData:function(cb){cb(null,${data})}};</script></head><body>${body}</body></html>`;
    } catch (e) {
      return `<pre style="color:#c33">Template error: ${String(e.message).replace(/</g, '&lt;')}</pre>`;
    }
  }, [visualizer]);
  return <iframe className="preview-frame" title="Visualization" sandbox="allow-scripts" srcDoc={html} />;
}

function BodyView({ response, visualizer }) {
  const [mode, setMode] = useState(visualizer ? 'visualize' : 'pretty');
  const search = useRef(null);
  const ct = response.headers.find((x) => eqi(x.key, 'content-type'))?.value || '';
  const pretty = useMemo(() => (response.encoding === 'base64' || response.body.length > PRETTY_LIMIT ? null : prettyBody(response.body, ct)), [response, ct]);
  const canPreview = response.encoding !== 'base64' ? /html|svg|xml/.test(ct) || /^\s*</.test(response.body.slice(0, 50)) : /^(image\/|application\/pdf)/.test(ct);

  if (response.bodyDropped) return <p className="hint pad">Response body was not kept (turn on "Save response bodies" in the runner).</p>;

  const modes = [
    ['pretty', 'Pretty', response.encoding !== 'base64'],
    ['raw', 'Raw', response.encoding !== 'base64'],
    ['preview', 'Preview', canPreview],
    ['visualize', 'Visualize', !!visualizer],
  ].filter(([, , ok]) => ok);
  const current = modes.some(([k]) => k === mode) ? mode : modes[0]?.[0];
  const text = current === 'pretty' && pretty ? pretty.text : response.body;

  return (
    <div className="body-view">
      <div className="body-tools">
        {modes.length > 0 && (
          <div className="seg">
            {modes.map(([k, label]) => (
              <button key={k} className={current === k ? 'on' : ''} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {response.bodyTruncated && <span className="hint small">Truncated to 256 KB in run results</span>}
        <span className="spacer" />
        {(current === 'pretty' || current === 'raw') && response.body.length <= PRETTY_LIMIT && (
          <button className="icon-btn" title="Search (Ctrl+F)" onClick={() => search.current?.()}>
            <IconSearch />
          </button>
        )}
        {response.encoding !== 'base64' && (
          <button className="icon-btn" title="Copy body" onClick={() => navigator.clipboard.writeText(response.body).then(() => toast('Body copied', 'success'))}>
            <IconCopy />
          </button>
        )}
        <button className="icon-btn" title="Save response to file" onClick={() => saveToFile(response, ct)}>
          <IconExport />
        </button>
      </div>
      <div className="body-code">
        {!response.body && current !== 'visualize' ? (
          <p className="hint pad">Empty body.</p>
        ) : current === 'preview' ? (
          <Preview response={response} ct={ct} />
        ) : current === 'visualize' ? (
          <Visualize visualizer={visualizer} />
        ) : !current ? (
          <p className="hint pad">Binary response ({ct || 'unknown type'}, {formatBytes(response.size)}). Use the save button to download it.</p>
        ) : response.body.length > PRETTY_LIMIT ? (
          <pre className="raw-pre">{response.body}</pre>
        ) : (
          <CodeEditor value={text} readOnly language={current === 'pretty' && pretty?.json ? 'json' : 'text'} wrap={current === 'raw'} onSearchRef={search} />
        )}
      </div>
    </div>
  );
}

function RequestSent({ request }) {
  if (!request) return <p className="hint pad">The request was not sent.</p>;
  return (
    <div className="sent pad">
      <div className="sent-line mono">
        <b>{request.method}</b> {request.url}
      </div>
      <h4>Headers</h4>
      <HeaderTable headers={request.headers} />
      {request.body ? (
        <>
          <h4>Body ({request.bodyMode})</h4>
          <pre className="raw-pre boxed">{request.body}</pre>
        </>
      ) : null}
    </div>
  );
}

function TimeBadge({ res }) {
  const t = res.timings;
  return (
    <span className="meta-pop">
      <span>{formatMs(res.timeMs)}</span>
      {t && (
        <span className="pop glass">
          <span className="pop-title">Response time</span>
          <span className="pop-row">
            <span>Waiting (TTFB)</span>
            <b>{formatMs(t.ttfb)}</b>
          </span>
          <span className="pop-row">
            <span>Download</span>
            <b>{formatMs(t.download)}</b>
          </span>
          <span className="pop-row total">
            <span>Total</span>
            <b>{formatMs(res.timeMs)}</b>
          </span>
          <span className="pop-note">Measured at the proxy: time to response headers, then body transfer.</span>
        </span>
      )}
    </span>
  );
}

function SizeBadge({ res }) {
  const headerBytes = res.headers.reduce((n, x) => n + x.key.length + String(x.value).length + 4, 0);
  return (
    <span className="meta-pop">
      <span>{formatBytes(res.size + headerBytes)}</span>
      <span className="pop glass">
        <span className="pop-title">Response size</span>
        <span className="pop-row">
          <span>Headers</span>
          <b>{formatBytes(headerBytes)}</b>
        </span>
        <span className="pop-row">
          <span>Body</span>
          <b>{formatBytes(res.size)}</b>
        </span>
      </span>
    </span>
  );
}

export default function ResponseView({ record, sending, onCancel, compact = false, refId }) {
  const globalTab = useUi((s) => s.subTabs.resp);
  const [localTab, setLocalTab] = useState(compact ? 'body' : null);
  const tab = compact ? localTab : globalTab;
  const pick = (t) => (compact ? setLocalTab(t) : setSubTab('resp', t));

  if (sending) {
    return (
      <div className="resp-empty">
        <div className="spinner" />
        <p>Sending request…</p>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    );
  }
  if (!record) {
    return (
      <div className="resp-empty">
        <p>
          Click <b>Send</b> or press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to get a response.
        </p>
      </div>
    );
  }

  const res = record.response;
  const tests = record.tests || [];
  const passed = tests.filter((t) => t.passed && !t.skipped).length;
  const counted = tests.filter((t) => !t.skipped).length;
  const consoleCount = record.logs.length + record.scriptErrors.length + record.warnings.length;
  const cookieCount = res ? res.headers.filter((x) => eqi(x.key, 'set-cookie')).length : 0;
  const tabs = [
    ['body', 'Body'],
    ['cookies', `Cookies${cookieCount ? ` (${cookieCount})` : ''}`],
    ['headers', `Headers${res ? ` (${res.headers.length})` : ''}`],
    ['tests', `Test Results${counted ? ` (${passed}/${counted})` : ''}`],
    ['console', `Console${consoleCount ? ` (${consoleCount})` : ''}`],
    ['request', 'Request'],
  ];

  const example = () => {
    const name = window.prompt('Example name', `${res.status} ${res.statusText || ''}`.trim());
    if (name !== null) saveExample(refId, record, name);
  };

  return (
    <div className={`resp ${compact ? 'compact' : ''}`}>
      <div className="resp-bar">
        <div className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? 'on' : ''} ${k === 'tests' && counted && passed < counted ? 'bad' : ''}`} onClick={() => pick(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="resp-meta">
          {res ? (
            <>
              <span className={`status ${statusClass(res.status)}`} title={STATUS_HINT[res.status] || ''}>
                {res.status} {res.statusText}
              </span>
              <TimeBadge res={res} />
              <SizeBadge res={res} />
              {refId && !compact && (
                <button className="btn small ghost" onClick={example} title="Save this response as an example of the request">
                  Save as example
                </button>
              )}
            </>
          ) : record.skipped ? (
            <span className="status s1">Skipped</span>
          ) : (
            <span className="status s5">Error</span>
          )}
        </div>
      </div>
      {record.error && (
        <div className="resp-error">
          <IconAlert /> <span>{record.error}</span>
        </div>
      )}
      <div className="resp-content">
        {tab === 'body' &&
          (res ? (
            <BodyView response={res} visualizer={record.visualizer} />
          ) : (
            <p className="hint pad">{record.skipped ? 'pm.execution.skipRequest() was called, so the request was not sent.' : 'No response received.'}</p>
          ))}
        {tab === 'cookies' && (res ? <CookieTable response={res} /> : <p className="hint pad">No response.</p>)}
        {tab === 'headers' && (res ? <HeaderTable headers={res.headers} /> : <p className="hint pad">No response.</p>)}
        {tab === 'tests' && <TestList tests={tests} />}
        {tab === 'console' && <ConsoleList record={record} />}
        {tab === 'request' && <RequestSent request={record.request} />}
      </div>
    </div>
  );
}

export function ResultIcon({ record }) {
  if (record.failed) {
    return (
      <span className="ricon fail">
        <IconX />
      </span>
    );
  }
  if (record.skipped) return <span className="ricon skip">–</span>;
  return (
    <span className="ricon pass">
      <IconCheck />
    </span>
  );
}
