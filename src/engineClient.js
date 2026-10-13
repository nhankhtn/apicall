// Main-thread side of engine.worker.js. Single sends share one worker; every collection run
// or load test gets its own, so stopping it can terminate scripts that never yield.
import { uid } from './lib/util.js';

const KILL_AFTER_MS = 1500;

function spawn() {
  return new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
}

function attach(worker, jobs) {
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.id);
    if (!job) return;
    if (data.type === 'event') return job.onEvent?.(data.event, data.value);
    jobs.delete(data.id);
    if (data.type === 'done') job.resolve(data.result);
    else job.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    e.preventDefault();
    for (const job of jobs.values()) job.reject(new Error(`Engine worker crashed: ${e.message}`));
    jobs.clear();
  };
}

// ---------- Shared worker for single requests ----------

let shared = null;
const sharedJobs = new Map();

function sharedWorker() {
  if (!shared) {
    shared = spawn();
    attach(shared, sharedJobs);
  }
  return shared;
}

function restartShared(reason) {
  shared?.terminate();
  shared = null;
  for (const job of sharedJobs.values()) job.reject(new Error(reason));
  sharedJobs.clear();
}

// Returns { promise, cancel }. cancel() aborts the HTTP call; if a script is stuck the worker
// is replaced after a grace period.
function sharedJob(type, payload) {
  const id = uid();
  const promise = new Promise((resolve, reject) => sharedJobs.set(id, { resolve, reject }));
  sharedWorker().postMessage({ id, type, payload });
  const cancel = () => {
    shared?.postMessage({ id, type: 'abort' });
    setTimeout(() => sharedJobs.has(id) && restartShared('Aborted'), KILL_AFTER_MS);
  };
  return { promise, cancel };
}

export const executeInWorker = (payload) => sharedJob('execute', payload);
export const fetchTokenInWorker = (payload) => sharedJob('oauth2', payload).promise;

// ---------- Dedicated worker for runs ----------

// Returns { promise, stop }. Events: iteration | result | warn | samples.
export function runInWorker(type, payload, onEvent) {
  const worker = spawn();
  const jobs = new Map();
  attach(worker, jobs);
  const id = uid();
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    jobs.set(id, {
      onEvent,
      resolve: (v) => {
        settled = true;
        worker.terminate();
        resolve(v);
      },
      reject: (e) => {
        settled = true;
        worker.terminate();
        reject(e);
      },
    });
  });
  worker.postMessage({ id, type, payload });
  const stop = () => {
    worker.postMessage({ id, type: 'abort' });
    setTimeout(() => {
      if (settled) return;
      const job = jobs.get(id);
      jobs.delete(id);
      worker.terminate();
      // Killed mid-script: variable changes made in the worker are lost.
      job?.resolve({ stopReason: 'stopped', killed: true });
    }, KILL_AFTER_MS);
  };
  return { promise, stop };
}
