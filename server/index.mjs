// ApiCall Runner server.
// - Serves the built React UI (dist/). In dev, Vite serves the UI and proxies /api here.
// - /api/proxy      sends a request to the target API, so the browser never hits CORS.
// - /api/workspace  collections, environments, globals, cookies and settings (data/workspace.json).
// - /api/history    requests sent from the UI (data/history.json).
// - /api/runs       collection run summaries (data/runs.json).
// - /api/files      files attached to form-data / binary bodies (data/files/).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performRequest } from './proxy.mjs';
import { storeFile, readStoredFile } from './files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(ROOT, 'dist');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const MAX_BODY = 100 * 1024 * 1024;
const HISTORY_LIMIT = 1000;
const RUNS_LIMIT = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// A JSON file with serialized, atomic writes.
function jsonFile(name, empty) {
  const file = path.join(DATA_DIR, name);
  let queue = Promise.resolve();
  const read = async () => {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(empty);
      throw err;
    }
  };
  const write = (value) =>
    (queue = queue.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
      await fsp.rename(tmp, file);
    }));
  // Read-modify-write inside the queue so concurrent appends don't lose entries.
  const update = (fn) =>
    (queue = queue.then(async () => {
      const next = fn(await read());
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
      await fsp.rename(tmp, file);
      return next;
    }));
  return { file, read, write, update };
}

const workspace = jsonFile('workspace.json', { version: 1, collections: [], environments: [], globals: [] });
const history = jsonFile('history.json', []);
const runs = jsonFile('runs.json', []);

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJSON = async (req) => JSON.parse((await readRaw(req)).toString('utf8'));

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // Vite fingerprints everything under assets/, so those can be cached for good.
      'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(pathname, res) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(DIST_DIR, rel);
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!path.extname(file)) file = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('UI is not built yet. Run `npm run build`, or use `npm run dev` for development.');
  }
  serveFile(res, file);
}

async function route(req, res, url) {
  const { pathname } = url;
  const m = req.method;

  if (pathname === '/api/proxy' && m === 'POST') return sendJSON(res, 200, await performRequest(await readJSON(req), { dataDir: DATA_DIR }));

  if (pathname === '/api/workspace') {
    if (m === 'GET') return sendJSON(res, 200, await workspace.read());
    // POST is accepted too so the page can flush pending edits with navigator.sendBeacon on unload.
    if (m === 'PUT' || m === 'POST') {
      const ws = await readJSON(req);
      if (!ws || !Array.isArray(ws.collections) || !Array.isArray(ws.environments)) return sendJSON(res, 400, { error: 'Invalid workspace' });
      await workspace.write(ws);
      return sendJSON(res, 200, { ok: true, savedAt: Date.now() });
    }
  }

  if (pathname === '/api/history') {
    if (m === 'GET') return sendJSON(res, 200, await history.read());
    if (m === 'POST') {
      const entry = await readJSON(req);
      await history.update((list) => [entry, ...list].slice(0, HISTORY_LIMIT));
      return sendJSON(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      await history.write([]);
      return sendJSON(res, 200, { ok: true });
    }
  }
  const histItem = pathname.match(/^\/api\/history\/([\w-]+)$/);
  if (histItem && m === 'DELETE') {
    await history.update((list) => list.filter((e) => e.id !== histItem[1]));
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/runs') {
    if (m === 'GET') {
      const target = url.searchParams.get('target');
      const list = await runs.read();
      return sendJSON(res, 200, target ? list.filter((r) => r.targetId === target) : list);
    }
    if (m === 'POST') {
      const run = await readJSON(req);
      await runs.update((list) => [run, ...list.filter((r) => r.id !== run.id)].slice(0, RUNS_LIMIT));
      return sendJSON(res, 200, { ok: true });
    }
  }
  const runItem = pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (runItem) {
    if (m === 'GET') {
      const run = (await runs.read()).find((r) => r.id === runItem[1]);
      return run ? sendJSON(res, 200, run) : sendJSON(res, 404, { error: 'Run not found' });
    }
    if (m === 'DELETE') {
      await runs.update((list) => list.filter((r) => r.id !== runItem[1]));
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/files' && m === 'POST') {
    const data = await readRaw(req);
    const meta = await storeFile(DATA_DIR, {
      name: url.searchParams.get('name'),
      type: req.headers['content-type'],
      data,
    });
    return sendJSON(res, 200, meta);
  }
  const fileItem = pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (fileItem && m === 'GET') {
    const file = await readStoredFile(DATA_DIR, fileItem[1]);
    res.writeHead(200, { 'content-type': file.meta.type, 'content-disposition': `attachment; filename="${encodeURIComponent(file.meta.name)}"` });
    return res.end(file.data);
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: `No route ${m} ${pathname}` });
  if (m === 'GET') return serveStatic(pathname, res);
  res.writeHead(405);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`server.route: path=${url.pathname}: ${err.message}`);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ApiCall Runner: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
