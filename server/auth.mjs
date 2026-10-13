// Optional HTTP Basic auth for deployments reachable by others. Off unless both
// APICALL_USER and APICALL_PASSWORD are set. Without it the proxy is an open relay.
import { timingSafeEqual } from 'node:crypto';

const USER = process.env.APICALL_USER || '';
const PASSWORD = process.env.APICALL_PASSWORD || '';

export const authEnabled = () => !!(USER && PASSWORD);

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// True when the request may proceed.
export function checkBasicAuth(authorization) {
  if (!authEnabled()) return true;
  const m = /^Basic\s+(.+)$/i.exec(authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i >= 0 && same(decoded.slice(0, i), USER) && same(decoded.slice(i + 1), PASSWORD);
}

export const CHALLENGE = { 'www-authenticate': 'Basic realm="ApiCall Runner", charset="UTF-8"' };

// ---------- Who may use the server ----------
// Without login only loopback Host names are served (plus APICALL_ALLOWED_HOSTS): this stops
// DNS-rebinding pages from reaching the proxy through the user's browser. With login any host
// works, since a rebinding page cannot present the credentials.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const EXTRA_HOSTS = (process.env.APICALL_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const hostnameOf = (host) => {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function hostAllowed(host) {
  if (authEnabled()) return true;
  const h = hostnameOf(host || '');
  return LOOPBACK.has(h) || EXTRA_HOSTS.includes(h) || EXTRA_HOSTS.includes(String(host || '').toLowerCase());
}

// Browsers send Origin on cross-site requests; only the app's own pages may drive the API.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

// null when allowed, else { status, message, headers }.
export function checkAccess(req, { requireSameOrigin = true } = {}) {
  if (!hostAllowed(req.headers.host)) {
    return { status: 403, message: 'This host name is not allowed. Set APICALL_ALLOWED_HOSTS, or enable login with APICALL_USER and APICALL_PASSWORD.' };
  }
  if (!checkBasicAuth(req.headers.authorization)) return { status: 401, message: 'Authentication required', headers: CHALLENGE };
  if (requireSameOrigin && !originAllowed(req)) return { status: 403, message: 'Cross-origin request refused' };
  return null;
}
