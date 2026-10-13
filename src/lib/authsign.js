// Request signing helpers: AWS Signature V4, HTTP Digest (RFC 2617 / 7616), JWT (JWS compact) and Hawk.
// Runs in the browser, Web Workers and Node: uses only crypto-js and WebCrypto (globalThis.crypto).
import CryptoJS from 'crypto-js';

const hex = (wa) => wa.toString(CryptoJS.enc.Hex);
const sha256Hex = (s) => hex(CryptoJS.SHA256(s));

// RFC 3986 unreserved characters stay as-is, everything else is percent-encoded (UTF-8).
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- AWS Signature V4 ----------

const AWS_OWN = new Set(['authorization', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token']);

function awsPayloadHash(body) {
  const type = body?.type || 'none';
  if (type === 'none') return sha256Hex('');
  if (type === 'text') return sha256Hex(body.text ?? '');
  if (type === 'urlencoded') return sha256Hex(new URLSearchParams((body.fields || []).map((f) => [f.key, f.value])).toString());
  return 'UNSIGNED-PAYLOAD';
}

// S3 encodes each path segment once; every other service encodes the already-encoded segment again.
function awsCanonicalUri(pathname, service) {
  if (!pathname) return '/';
  return pathname
    .split('/')
    .map((seg) => {
      const once = rfc3986(safeDecode(seg));
      return service === 's3' ? once : rfc3986(once);
    })
    .join('/');
}

function awsCanonicalQuery(search) {
  const q = search.replace(/^\?/, '');
  if (!q) return '';
  return q
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = i < 0 ? pair : pair.slice(0, i);
      const v = i < 0 ? '' : pair.slice(i + 1);
      return [rfc3986(safeDecode(k)), rfc3986(safeDecode(v))];
    })
    .sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const amzDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const hmac = (key, msg) => CryptoJS.HmacSHA256(msg, key);

// Returns the headers to add: Authorization, X-Amz-Date, X-Amz-Content-Sha256 and X-Amz-Security-Token.
// cfg.contentSha256 === false leaves out (and does not sign) X-Amz-Content-Sha256.
export function awsSigV4(spec, cfg, now = new Date()) {
  const { accessKey, secretKey, sessionToken, region, service } = cfg;
  const url = new URL(spec.url);
  const datetime = amzDate(now);
  const date = datetime.slice(0, 8);
  const payloadHash = awsPayloadHash(spec.body);

  const added = [{ key: 'X-Amz-Date', value: datetime }];
  if (cfg.contentSha256 !== false) added.push({ key: 'X-Amz-Content-Sha256', value: payloadHash });
  if (sessionToken) added.push({ key: 'X-Amz-Security-Token', value: sessionToken });

  const headers = new Map([['host', [url.host]]]);
  const own = (spec.headers || []).filter((h) => h.key && h.enabled !== false && !AWS_OWN.has(h.key.trim().toLowerCase()));
  for (const h of [...own, ...added]) {
    const name = h.key.trim().toLowerCase();
    if (name === 'host') headers.delete('host');
    const value = String(h.value ?? '').trim().replace(/\s+/g, ' ');
    headers.set(name, [...(headers.get(name) || []), value]);
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((n) => `${n}:${headers.get(n).join(',')}\n`).join('');

  const canonicalRequest = [
    (spec.method || 'GET').toUpperCase(),
    awsCanonicalUri(url.pathname, service),
    awsCanonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request');
  const signature = hex(hmac(kSigning, stringToSign));

  return [
    {
      key: 'Authorization',
      value: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...added,
  ];
}

// ---------- HTTP Digest ----------

const PARAM_RE = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;

// Parses the Digest challenge of a WWW-Authenticate header into { realm, nonce, qop, ... } (lowercase keys).
export function parseChallenge(header) {
  const m = /(?:^|,)\s*Digest\s+/i.exec(String(header || ''));
  if (!m) return null;
  const rest = header.slice(m.index + m[0].length);
  const params = {};
  for (const p of rest.matchAll(PARAM_RE)) {
    const key = p[1].toLowerCase();
    if (key in params) break; // start of a following challenge
    params[key] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  }
  return params;
}

const DIGEST_HASH = { MD5: CryptoJS.MD5, 'SHA-256': CryptoJS.SHA256 };

const quote = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;

// opts: { cnonce, nc } for deterministic output in tests.
export function digestAuthorization({ username, password }, wwwAuthenticate, method, url, bodyText = '', opts = {}) {
  const ch = parseChallenge(wwwAuthenticate);
  if (!ch) throw new Error('Not a Digest challenge');
  if (!ch.nonce) throw new Error('Digest challenge has no nonce');
  const algorithm = (ch.algorithm || 'MD5').toUpperCase();
  const sess = algorithm.endsWith('-SESS');
  const hashFn = DIGEST_HASH[sess ? algorithm.slice(0, -5) : algorithm];
  if (!hashFn) throw new Error(`Unsupported Digest algorithm: ${ch.algorithm}`);
  const H = (s) => hex(hashFn(s));

  const u = new URL(url);
  const uri = u.pathname + u.search;
  const realm = ch.realm ?? '';
  const qops = (ch.qop || '').split(',').map((q) => q.trim().toLowerCase()).filter(Boolean);
  const qop = qops.includes('auth') ? 'auth' : qops.includes('auth-int') ? 'auth-int' : null;
  if (qops.length && !qop) throw new Error(`Unsupported Digest qop: ${ch.qop}`);
  const cnonce = opts.cnonce || randomHex(16);
  const nc = opts.nc || '00000001';

  let ha1 = H(`${username}:${realm}:${password}`);
  if (sess) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = H(qop === 'auth-int' ? `${method.toUpperCase()}:${uri}:${H(bodyText)}` : `${method.toUpperCase()}:${uri}`);
  const response = qop ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);

  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(ch.nonce)}`,
    `uri=${quote(uri)}`,
  ];
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  parts.push(`response=${quote(response)}`);
  if (ch.opaque !== undefined) parts.push(`opaque=${quote(ch.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

// ---------- JWT ----------

const utf8 = (s) => new TextEncoder().encode(s);

function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const b64urlWords = (wa) => wa.toString(CryptoJS.enc.Base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const HMACS = { HS256: CryptoJS.HmacSHA256, HS384: CryptoJS.HmacSHA384, HS512: CryptoJS.HmacSHA512 };

function pemToDer(pem) {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(String(pem || ''));
  if (!m) throw new Error('Invalid PEM private key');
  const bin = atob(m[2].replace(/\s+/g, ''));
  return { label: m[1], der: Uint8Array.from(bin, (c) => c.charCodeAt(0)) };
}

function derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (; n > 0; n >>= 8) out.unshift(n & 0xff);
  return [0x80 | out.length, ...out];
}

const derTlv = (tag, body) => [tag, ...derLen(body.length), ...body];

// Wraps a PKCS#1 RSAPrivateKey into PKCS#8 PrivateKeyInfo so WebCrypto can import it.
function rsaPkcs1ToPkcs8(der) {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return Uint8Array.from(derTlv(0x30, [0x02, 0x01, 0x00, ...algId, ...derTlv(0x04, [...der])]));
}

function pkcs8Der(pem, kty) {
  const { label, der } = pemToDer(pem);
  if (label === 'PRIVATE KEY') return der;
  if (label === 'RSA PRIVATE KEY' && kty === 'RSA') return rsaPkcs1ToPkcs8(der);
  throw new Error(`Unsupported key format "${label}": use a PKCS#8 "BEGIN PRIVATE KEY" PEM`);
}

const CURVES = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' };

function webCryptoAlg(algorithm) {
  const bits = algorithm.slice(2);
  const hash = `SHA-${bits}`;
  if (algorithm.startsWith('RS')) return { kty: 'RSA', imp: { name: 'RSASSA-PKCS1-v1_5', hash }, sig: { name: 'RSASSA-PKCS1-v1_5' } };
  if (algorithm.startsWith('PS')) return { kty: 'RSA', imp: { name: 'RSA-PSS', hash }, sig: { name: 'RSA-PSS', saltLength: bits / 8 } };
  return { kty: 'EC', imp: { name: 'ECDSA', namedCurve: CURVES[algorithm] }, sig: { name: 'ECDSA', hash } };
}

const JWT_ALGS = /^(HS|RS|PS|ES)(256|384|512)$/;

export async function signJwt({ algorithm, secret, privateKey, payload, header = {}, secretBase64 = false }) {
  if (!JWT_ALGS.test(algorithm || '')) throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
  const h = { alg: algorithm, typ: 'JWT', ...header };
  h.alg = algorithm;
  let body = payload ?? {};
  if (typeof body === 'string') {
    body = body.trim();
    JSON.parse(body); // validate only; keep the caller's exact JSON
  } else body = JSON.stringify(body);
  const input = `${b64urlBytes(utf8(JSON.stringify(h)))}.${b64urlBytes(utf8(body))}`;

  if (HMACS[algorithm]) {
    const key = secretBase64
      ? CryptoJS.enc.Base64.parse(String(secret ?? '').trim().replace(/-/g, '+').replace(/_/g, '/'))
      : CryptoJS.enc.Utf8.parse(String(secret ?? ''));
    return `${input}.${b64urlWords(HMACS[algorithm](input, key))}`;
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available (secure context required)');
  const { kty, imp, sig } = webCryptoAlg(algorithm);
  const key = await subtle.importKey('pkcs8', pkcs8Der(privateKey, kty), imp, false, ['sign']);
  // WebCrypto ECDSA signatures are already IEEE P1363 (r || s), which is the JWS format.
  const signature = new Uint8Array(await subtle.sign(sig, key, utf8(input)));
  return `${input}.${b64urlBytes(signature)}`;
}

// ---------- Hawk ----------

const HAWK_ALGS = { sha256: [CryptoJS.SHA256, CryptoJS.HmacSHA256], sha1: [CryptoJS.SHA1, CryptoJS.HmacSHA1] };
const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const base64 = (wa) => wa.toString(CryptoJS.enc.Base64);

function randomString(len) {
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => NONCE_CHARS[b % NONCE_CHARS.length]).join('');
}

// The bytes the proxy will send, when known before sending (multipart and files are not).
function hawkPayload(spec) {
  const type = spec.body?.type || 'none';
  const header = (spec.headers || []).find((h) => h.key && h.key.trim().toLowerCase() === 'content-type');
  const contentType = (header?.value || (type === 'urlencoded' ? 'application/x-www-form-urlencoded' : '')).split(';')[0].trim().toLowerCase();
  if (type === 'none') return { contentType, payload: '' };
  if (type === 'text') return { contentType, payload: spec.body.text ?? '' };
  if (type === 'urlencoded') return { contentType, payload: new URLSearchParams((spec.body.fields || []).map((f) => [f.key, f.value ?? ''])).toString() };
  return null;
}

const hawkEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// cfg: { authId, authKey, algorithm, nonce, ext, app, delegation, timestamp, includePayloadHash }.
// opts: { now } (ms) for deterministic output in tests.
export function hawkAuthorization(spec, cfg, opts = {}) {
  const alg = HAWK_ALGS[(cfg.algorithm || 'sha256').toLowerCase()];
  if (!alg) throw new Error(`Unsupported Hawk algorithm: ${cfg.algorithm}`);
  const [hashFn, hmacFn] = alg;
  const url = new URL(spec.url);
  const ts = String(cfg.timestamp || Math.floor((opts.now ?? Date.now()) / 1000));
  const nonce = cfg.nonce || randomString(6);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const ext = cfg.ext || '';
  const app = cfg.app || '';
  const dlg = app ? cfg.delegation || '' : '';

  let hash = '';
  const p = cfg.includePayloadHash ? hawkPayload(spec) : null;
  if (p) hash = base64(hashFn(`hawk.1.payload\n${p.contentType}\n${p.payload}\n`));

  let normalized = [
    'hawk.1.header',
    ts,
    nonce,
    (spec.method || 'GET').toUpperCase(),
    url.pathname + url.search,
    url.hostname.toLowerCase(),
    port,
    hash,
    ext.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'),
  ].join('\n');
  normalized += '\n';
  if (app) normalized += `${app}\n${dlg}\n`;
  const mac = base64(hmacFn(normalized, cfg.authKey ?? ''));

  const parts = [`id="${hawkEscape(cfg.authId ?? '')}"`, `ts="${ts}"`, `nonce="${hawkEscape(nonce)}"`];
  if (hash) parts.push(`hash="${hash}"`);
  if (ext) parts.push(`ext="${hawkEscape(ext)}"`);
  parts.push(`mac="${mac}"`);
  if (app) parts.push(`app="${hawkEscape(app)}"`);
  if (app && dlg) parts.push(`dlg="${hawkEscape(dlg)}"`);
  return `Hawk ${parts.join(', ')}`;
}
