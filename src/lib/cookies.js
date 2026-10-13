// A small RFC 6265 cookie jar: stores Set-Cookie results per domain/path and builds the
// Cookie header for outgoing requests. Cookies are plain objects so they persist as JSON:
// { name, value, domain, path, expires (ms|null), secure, httpOnly, hostOnly, sameSite }
const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

export function parseSetCookie(header, requestUrl, now = Date.now()) {
  const url = new URL(requestUrl);
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const c = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname.toLowerCase(),
    path: defaultPath(url.pathname),
    expires: null,
    secure: false,
    httpOnly: false,
    hostOnly: true,
    sameSite: '',
  };
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      const host = url.hostname.toLowerCase();
      // Reject cookies for unrelated domains, as browsers do.
      if (host !== d && !host.endsWith(`.${d}`)) return null;
      if (!isIp(host)) {
        c.domain = d;
        c.hostOnly = false;
      }
    } else if (k === 'path' && v.startsWith('/')) c.path = v;
    else if (k === 'max-age' && /^-?\d+$/.test(v)) c.expires = now + Number(v) * 1000;
    else if (k === 'expires' && c.expires === null) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) c.expires = t;
    } else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite') c.sameSite = v;
  }
  return c;
}

const domainMatches = (c, host) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`));
const pathMatches = (cookiePath, reqPath) =>
  reqPath === cookiePath || (reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));

export const isExpired = (c, now = Date.now()) => c.expires !== null && c.expires !== undefined && c.expires <= now;

export function cookiesFor(jar, requestUrl, now = Date.now()) {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  return jar
    .filter((c) => !isExpired(c, now) && domainMatches(c, host) && pathMatches(c.path, url.pathname || '/') && (!c.secure || url.protocol === 'https:'))
    .sort((a, b) => b.path.length - a.path.length);
}

const sameCookie = (a, b) => a.name === b.name && a.domain === b.domain && a.path === b.path;

// Returns a new jar with the cookie stored (or removed when it is already expired).
export function storeCookie(jar, cookie, now = Date.now()) {
  const rest = jar.filter((c) => !sameCookie(c, cookie));
  return isExpired(cookie, now) ? rest : [...rest, cookie];
}

export function storeSetCookies(jar, setCookieHeaders, requestUrl, now = Date.now()) {
  let next = jar;
  for (const h of setCookieHeaders) {
    const c = parseSetCookie(h, requestUrl, now);
    if (c) next = storeCookie(next, c, now);
  }
  return next;
}

export const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

export function formatCookie(c) {
  const parts = [`${c.name}=${c.value}`];
  if (!c.hostOnly) parts.push(`Domain=${c.domain}`);
  parts.push(`Path=${c.path}`);
  if (c.expires) parts.push(`Expires=${new Date(c.expires).toUTCString()}`);
  if (c.secure) parts.push('Secure');
  if (c.httpOnly) parts.push('HttpOnly');
  if (c.sameSite) parts.push(`SameSite=${c.sameSite}`);
  return parts.join('; ');
}
