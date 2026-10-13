// Vercel serverless entry for /api/*. Vercel functions cannot hold WebSocket connections, so
// the realtime relay (WebSocket, Socket.IO, MQTT, gRPC calls) is only in the Node/Docker server.
// Basic auth for the whole deployment is enforced by middleware.js.
import { performRequest } from '../server/proxy.mjs';
import { describe as describeGrpc } from '../server/grpc.mjs';
import { originAllowed } from '../server/auth.mjs';

const MAX_BODY = 4 * 1024 * 1024; // Vercel's request body limit is 4.5 MB.

export const config = { api: { bodyParser: false } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large for a Vercel function (4 MB)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
};

export default async function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/health') return send(res, 200, { ok: true });
    if (pathname === '/api/capabilities') return send(res, 200, { realtime: false, platform: 'vercel' });
    // Only the app's own pages may drive the proxy, and only with JSON (which needs a CORS preflight).
    if (!originAllowed(req)) return send(res, 403, { error: 'Cross-origin request refused' });
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' });
    if (pathname === '/api/proxy' && req.method === 'POST') {
      // Attachments arrive inline from the browser; there is no server-side file store here.
      return send(res, 200, await performRequest(JSON.parse(await readBody(req)), { dataDir: '/tmp/apicall' }));
    }
    if (pathname === '/api/grpc/describe' && req.method === 'POST') return send(res, 200, await describeGrpc(JSON.parse(await readBody(req))));
    if (pathname === '/api/realtime') {
      return send(res, 501, { error: 'WebSocket, Socket.IO, MQTT and gRPC calls need the Node/Docker server; Vercel functions cannot keep connections open.' });
    }
    return send(res, 404, { error: `No route ${req.method} ${pathname}` });
  } catch (err) {
    console.error(`handler.route: path=${pathname}: ${err.message}`);
    return send(res, err.status || 500, { error: err.message });
  }
}
