// ApiCall Runner server.
// - Serves the built React UI (dist/). In dev, Vite serves the UI and proxies /api here.
// - /api/proxy          sends a request to the target API, so the browser never hits CORS.
// - /api/realtime       WebSocket relay for WebSocket, Socket.IO, MQTT and gRPC sessions (realtime.mjs).
// - /api/grpc/describe  lists gRPC services from .proto files or server reflection (grpc.mjs).
// - /api/health, /api/capabilities
// Collections and history live in each browser (IndexedDB). The read-only /api/workspace,
// /api/history, /api/runs and /api/files routes remain so older server-side data can be
// copied into the browser once.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performRequest } from './proxy.mjs';
import { readStoredFile } from './files.mjs';
import { authEnabled, checkAccess } from './auth.mjs';
import { attachRealtime } from './realtime.mjs';
import { describe as describeGrpc } from './grpc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(ROOT, 'dist');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const MAX_BODY = 100 * 1024 * 1024;

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
  '.webmanifest': 'application/manifest+json',
};

// Read-only access to the JSON files the server used to write.
function jsonFile(name, empty) {
  const file = path.join(DATA_DIR, name);
  return {
    async read() {
      try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return structuredClone(empty);
        throw err;
      }
    },
  };
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

  if (pathname === '/api/health') return sendJSON(res, 200, { ok: true });
  const denied = checkAccess(req, { requireSameOrigin: pathname.startsWith('/api/') });
  if (denied) {
    res.writeHead(denied.status, { 'content-type': 'text/plain; charset=utf-8', ...(denied.headers || {}) });
    return res.end(denied.message);
  }
  // JSON only: a cross-site form or text/plain POST cannot reach the proxy without a CORS preflight.
  if (m === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJSON(res, 415, { error: 'Expected application/json' });

  if (pathname === '/api/capabilities') return sendJSON(res, 200, { realtime: true, platform: 'node', auth: authEnabled() });
  if (pathname === '/api/proxy' && m === 'POST') return sendJSON(res, 200, await performRequest(await readJSON(req), { dataDir: DATA_DIR }));
  if (pathname === '/api/grpc/describe' && m === 'POST') return sendJSON(res, 200, await describeGrpc(await readJSON(req)));

  // Legacy server-side data, read once by the browser to migrate into IndexedDB.
  if (m === 'GET') {
    if (pathname === '/api/workspace') return sendJSON(res, 200, await workspace.read());
    if (pathname === '/api/history') return sendJSON(res, 200, await history.read());
    if (pathname === '/api/runs') return sendJSON(res, 200, await runs.read());
    const fileItem = pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/);
    if (fileItem) {
      const file = await readStoredFile(DATA_DIR, fileItem[1]);
      res.writeHead(200, { 'content-type': file.meta.type, 'content-disposition': `attachment; filename="${encodeURIComponent(file.meta.name)}"` });
      return res.end(file.data);
    }
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: `No route ${m} ${pathname}` });
  if (m === 'GET') return serveStatic(pathname, res);
  res.writeHead(405);
  return res.end();
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

attachRealtime(server, { path: '/api/realtime' });

server.listen(PORT, HOST, () => {
  console.log(`ApiCall Runner: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (!authEnabled()) {
    const extra = process.env.APICALL_ALLOWED_HOSTS ? `localhost and ${process.env.APICALL_ALLOWED_HOSTS}` : 'localhost only';
    console.log(`Login is off: serving ${extra}. Set APICALL_USER and APICALL_PASSWORD before exposing this server.`);
  }
});
