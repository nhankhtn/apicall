import { useRef } from 'react';
import CodeEditor from './CodeEditor.jsx';

const PRE_SNIPPETS = [
  ['Get an environment variable', 'pm.environment.get("variable_key");'],
  ['Set an environment variable', 'pm.environment.set("variable_key", "variable_value");'],
  ['Set a collection variable', 'pm.collectionVariables.set("variable_key", "variable_value");'],
  ['Set a local variable', 'pm.variables.set("variable_key", "variable_value");'],
  ['Read iteration data', 'const value = pm.iterationData.get("column_name");'],
  ['Timestamp variable', 'pm.variables.set("timestamp", Date.now());'],
  [
    'HMAC-SHA256 signature',
    `const body = pm.request.body.raw || "";
const ts = Date.now().toString();
const sign = CryptoJS.HmacSHA256(ts + body, pm.environment.get("secret")).toString();
pm.request.headers.upsert({ key: "X-Timestamp", value: ts });
pm.request.headers.upsert({ key: "X-Signature", value: sign });`,
  ],
  [
    'Fetch a token with pm.sendRequest',
    `const res = await pm.sendRequest({
  url: pm.environment.get("baseUrl") + "/auth/login",
  method: "POST",
  header: { "Content-Type": "application/json" },
  body: { mode: "raw", raw: JSON.stringify({ username: "user", password: "pass" }) },
});
pm.environment.set("token", res.json().data.token);`,
  ],
  ['Skip this request', 'pm.execution.skipRequest();'],
];

const TEST_SNIPPETS = [
  ['Status code is 200', 'pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});'],
  ['Response time < 500ms', 'pm.test("Response time is below 500ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});'],
  [
    'Check a JSON value',
    'pm.test("Response has expected value", () => {\n  const json = pm.response.json();\n  pm.expect(json.code).to.eql(0);\n});',
  ],
  ['Body contains string', 'pm.test("Body contains string", () => {\n  pm.expect(pm.response.text()).to.include("string_you_want");\n});'],
  ['Content-Type header present', 'pm.test("Content-Type is present", () => {\n  pm.response.to.have.header("Content-Type");\n});'],
  [
    'Save a JSON field to environment',
    'const json = pm.response.json();\npm.environment.set("token", json.data.token);',
  ],
  ['Set next request', 'pm.execution.setNextRequest("Request name");'],
  ['Stop the iteration', 'pm.execution.setNextRequest(null);'],
  [
    'Retry until a condition (polling)',
    `const json = pm.response.json();
const tries = (pm.variables.get("tries") || 0) + 1;
if (json.data.status !== "DONE" && tries < 10) {
  pm.variables.set("tries", tries);
  await new Promise((r) => setTimeout(r, 1000));
  pm.execution.setNextRequest(pm.info.requestName);
} else {
  pm.variables.set("tries", 0);
}`,
  ],
];

export default function ScriptEditor({ value, onChange, kind }) {
  const viewRef = useRef(null);
  const snippets = kind === 'test' ? TEST_SNIPPETS : PRE_SNIPPETS;

  const insert = (code) => {
    const view = viewRef.current;
    if (!view) {
      onChange(`${value ? `${value}\n` : ''}${code}\n`);
      return;
    }
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const prefix = line.text.trim() ? '\n' : '';
    view.dispatch(view.state.replaceSelection(`${prefix}${code}\n`));
    view.focus();
  };

  return (
    <div className="script-editor">
      <div className="script-code">
        <CodeEditor
          value={value}
          onChange={onChange}
          language="javascript"
          placeholder={kind === 'test' ? '// Runs after the response arrives' : '// Runs before the request is sent'}
          onCreateEditor={(view) => (viewRef.current = view)}
        />
      </div>
      <aside className="snippets">
        <div className="snippets-title">Snippets</div>
        {snippets.map(([label, code]) => (
          <button key={label} className="snippet" onClick={() => insert(code)} title={code}>
            {label}
          </button>
        ))}
        <p className="hint small">
          Available: <code>pm</code>, <code>CryptoJS</code>, <code>_</code> (lodash), <code>moment</code>, <code>require()</code>. Top-level{' '}
          <code>await</code> works.
        </p>
      </aside>
    </div>
  );
}
