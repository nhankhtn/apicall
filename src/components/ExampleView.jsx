import { useMemo } from 'react';
import { useWs } from '../store.js';
import { findNode } from '../lib/model.js';
import { prettyBody, eqi } from '../lib/util.js';
import * as A from '../actions.js';
import CodeEditor from './CodeEditor.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import { IconExample } from './icons.jsx';
import { MethodSelect } from './Menu.jsx';

// A saved example: the request that was sent and the response it produced. Editable, saved immediately.
export default function ExampleView({ refId }) {
  const [reqId, exId] = refId.split('/');
  const ws = useWs((s) => s.ws);
  const found = useMemo(() => findNode(ws, reqId), [ws, reqId]);
  const ex = found?.node.examples?.find((e) => e.id === exId);
  if (!ex) return <div className="empty-view">This example no longer exists.</div>;

  const upd = (fn) => A.updateNodeExamples(reqId, (list) => list.map((e) => (e.id === exId ? fn(structuredClone(e)) : e)));
  const ct = ex.response.headers.find((h) => eqi(h.key, 'content-type'))?.value || '';
  const pretty = prettyBody(ex.response.body, ct);

  return (
    <div className="example-view">
      <div className="view-head">
        <IconExample className="head-ico" />
        <div className="crumbs">
          <span>{found.node.name} /</span>
        </div>
        <input className="title-input" value={ex.name} onChange={(e) => upd((x) => ({ ...x, name: e.target.value }))} />
        <button className="btn small" onClick={() => A.openTab('request', reqId, { preview: false })}>
          Open request
        </button>
        <button className="btn small ghost" onClick={() => A.deleteExample(reqId, exId)}>
          Delete
        </button>
      </div>
      <div className="example-grid">
        <section>
          <div className="pane-label">Request</div>
          <div className="url-bar static">
            <MethodSelect value={ex.request?.method || 'GET'} onChange={(method) => upd((x) => ({ ...x, request: { ...x.request, method } }))} />
            <input className="url-input mono" value={ex.request?.url || ''} onChange={(e) => upd((x) => ({ ...x, request: { ...x.request, url: e.target.value } }))} />
          </div>
          <div className="pane-label">Headers</div>
          <KeyValueEditor rows={ex.request?.headers || []} vars={false} onChange={(headers) => upd((x) => ({ ...x, request: { ...x.request, headers } }))} />
          {ex.request?.body?.mode === 'raw' && (
            <>
              <div className="pane-label">Body</div>
              <div className="example-code">
                <CodeEditor value={ex.request.body.raw} language="json" onChange={(raw) => upd((x) => ({ ...x, request: { ...x.request, body: { ...x.request.body, raw } } }))} />
              </div>
            </>
          )}
        </section>
        <section>
          <div className="pane-label">Response</div>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Status code</span>
              <input type="number" value={ex.response.status} onChange={(e) => upd((x) => ({ ...x, response: { ...x.response, status: Number(e.target.value) } }))} />
            </label>
            <label className="field">
              <span className="field-label">Status text</span>
              <input value={ex.response.statusText || ''} onChange={(e) => upd((x) => ({ ...x, response: { ...x.response, statusText: e.target.value } }))} />
            </label>
          </div>
          <div className="pane-label">Body</div>
          <div className="example-code tall">
            <CodeEditor value={pretty.text} language={pretty.json ? 'json' : 'text'} onChange={(body) => upd((x) => ({ ...x, response: { ...x.response, body } }))} />
          </div>
          <div className="pane-label">Headers</div>
          <KeyValueEditor rows={ex.response.headers.map((h) => ({ ...h, enabled: true }))} toggle={false} vars={false} onChange={(rows) => upd((x) => ({ ...x, response: { ...x.response, headers: rows.map(({ key, value }) => ({ key, value })) } }))} />
        </section>
      </div>
    </div>
  );
}
