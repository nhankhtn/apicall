import { setUi } from '../store.js';
import { createCollection, createEnvironment } from '../actions.js';
import { IconCollection, IconEnv, IconImport, IconPlay } from './icons.jsx';

const STEPS = [
  [IconCollection, 'Create or import a collection', 'Group requests into folders. Import Postman v2.1 exports or paste cURL commands copied from DevTools.'],
  [IconEnv, 'Add an environment', 'Define baseUrl, token… and reference them as {{baseUrl}}. Switch environments from the top bar.'],
  [IconPlay, 'Run the collection', 'Iterations, delay, a CSV/JSON data file and pm.test() assertions, with a pass/fail report you can export.'],
];

export default function Welcome() {
  return (
    <div className="welcome">
      <h1>ApiCall Runner</h1>
      <p className="lead">Send API requests and run whole collections, with Postman-compatible scripts.</p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={() => createCollection()}>
          New collection
        </button>
        <button className="btn" onClick={() => setUi({ modal: { type: 'import' } })}>
          <IconImport /> Import
        </button>
        <button className="btn" onClick={() => createEnvironment()}>
          New environment
        </button>
      </div>
      <div className="steps">
        {STEPS.map(([Icon, title, text]) => (
          <div key={title} className="step">
            <Icon className="step-ico" />
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
      <div className="cheatsheet">
        <h3>Script cheat sheet</h3>
        <pre className="mono">{`// Tests
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.expect(pm.response.json().data).to.be.an("array").that.is.not.empty;

// Pass values to the next request
pm.environment.set("orderId", pm.response.json().data.id);   // then use {{orderId}}

// Control the run
pm.execution.setNextRequest("Get order");   // jump
pm.execution.setNextRequest(null);          // end this iteration
pm.execution.skipRequest();                 // (pre-request) don't send

// Data-driven runs: CSV column "sku"  ->  {{sku}} or pm.iterationData.get("sku")`}</pre>
        <p className="hint">
          Shortcuts: <kbd>Ctrl</kbd>+<kbd>Enter</kbd> send · <kbd>Ctrl</kbd>+<kbd>S</kbd> save now · double-click a sidebar item to rename ·
          drag items to reorder.
        </p>
      </div>
    </div>
  );
}
