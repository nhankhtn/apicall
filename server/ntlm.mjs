// NTLM over HTTP (MS-NLMP, NTLMv2 only): message encoding/decoding and the 3-leg handshake.
// The handshake authenticates one TCP connection, so every leg must go through the same
// single-connection dispatcher (see performRequest).
import { createHmac, randomBytes } from 'node:crypto';
import { fetch } from 'undici';

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

export const FLAGS = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSION_SECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  NEGOTIATE_128: 0x20000000,
  NEGOTIATE_56: 0x80000000,
};

const CLIENT_FLAGS =
  (FLAGS.UNICODE |
    FLAGS.OEM |
    FLAGS.REQUEST_TARGET |
    FLAGS.NTLM |
    FLAGS.ALWAYS_SIGN |
    FLAGS.EXTENDED_SESSION_SECURITY |
    FLAGS.TARGET_INFO |
    FLAGS.NEGOTIATE_128 |
    FLAGS.NEGOTIATE_56) >>> 0;

const AV_TIMESTAMP = 0x0007;
// Bodies up to this size are also sent on the Type 1 leg; larger ones only on the final leg.
const FIRST_LEG_BODY_LIMIT = 64 * 1024;

// ---------- Crypto ----------

const rotl = (v, s) => (v << s) | (v >>> (32 - s));

// MD4 (RFC 1320). node:crypto has no md4 under OpenSSL 3 without the legacy provider.
export function md4(input) {
  const msg = Buffer.from(input);
  const words = ((msg.length + 8) >>> 6) * 16 + 16;
  const x = new Uint32Array(words);
  for (let i = 0; i < msg.length; i++) x[i >> 2] |= msg[i] << ((i % 4) * 8);
  x[msg.length >> 2] |= 0x80 << ((msg.length % 4) * 8);
  x[words - 2] = (msg.length * 8) >>> 0;
  x[words - 1] = Math.floor(msg.length / 0x20000000);

  const F = (a, b, c) => (a & b) | (~a & c);
  const G = (a, b, c) => (a & b) | (a & c) | (b & c);
  const H = (a, b, c) => a ^ b ^ c;
  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let i = 0; i < words; i += 16) {
    const [aa, bb, cc, dd] = [a, b, c, d];
    const X = (k) => x[i + k];
    for (const k of [0, 4, 8, 12]) {
      a = rotl(a + F(b, c, d) + X(k), 3);
      d = rotl(d + F(a, b, c) + X(k + 1), 7);
      c = rotl(c + F(d, a, b) + X(k + 2), 11);
      b = rotl(b + F(c, d, a) + X(k + 3), 19);
    }
    for (const k of [0, 1, 2, 3]) {
      a = rotl(a + G(b, c, d) + X(k) + 0x5a827999, 3);
      d = rotl(d + G(a, b, c) + X(k + 4) + 0x5a827999, 5);
      c = rotl(c + G(d, a, b) + X(k + 8) + 0x5a827999, 9);
      b = rotl(b + G(c, d, a) + X(k + 12) + 0x5a827999, 13);
    }
    for (const k of [0, 2, 1, 3]) {
      a = rotl(a + H(b, c, d) + X(k) + 0x6ed9eba1, 3);
      d = rotl(d + H(a, b, c) + X(k + 8) + 0x6ed9eba1, 9);
      c = rotl(c + H(d, a, b) + X(k + 4) + 0x6ed9eba1, 11);
      b = rotl(b + H(c, d, a) + X(k + 12) + 0x6ed9eba1, 15);
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeUInt32LE(v >>> 0, i * 4));
  return out;
}

const hmacMd5 = (key, ...data) => {
  const h = createHmac('md5', key);
  for (const d of data) h.update(d);
  return h.digest();
};

const utf16 = (s) => Buffer.from(String(s ?? ''), 'utf16le');

export const ntowfV2 = (password, user, domain) => hmacMd5(md4(utf16(password)), utf16(String(user).toUpperCase() + String(domain ?? '')));

// FILETIME: 100 ns intervals since 1601-01-01, little-endian.
export function fileTime(ms = Date.now()) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE((BigInt(Math.floor(ms)) + 11644473600000n) * 10000n);
  return buf;
}

// Returns { ntResponse, lmResponse, ntProofStr } (MS-NLMP 3.3.2).
export function ntlmV2Response({ responseKey, serverChallenge, clientChallenge, timestamp, targetInfo }) {
  const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
  const ntProofStr = hmacMd5(responseKey, serverChallenge, temp);
  const lmResponse = Buffer.concat([hmacMd5(responseKey, serverChallenge, clientChallenge), clientChallenge]);
  return { ntResponse: Buffer.concat([ntProofStr, temp]), lmResponse, ntProofStr };
}

// ---------- Messages ----------

export function negotiateMessage() {
  const buf = Buffer.alloc(32);
  SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(CLIENT_FLAGS, 12);
  // Domain and workstation security buffers stay empty (offset 32, length 0).
  buf.writeUInt32LE(32, 20);
  buf.writeUInt32LE(32, 28);
  return buf;
}

function readSecBuf(buf, at) {
  const len = buf.readUInt16LE(at);
  const off = buf.readUInt32LE(at + 4);
  if (off + len > buf.length) throw new Error('Invalid NTLM message: field out of range');
  return buf.subarray(off, off + len);
}

export function parseChallengeMessage(buf) {
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.readUInt32LE(8) !== 2) {
    throw new Error('Invalid NTLM challenge (Type 2) message');
  }
  const flags = buf.readUInt32LE(20);
  const targetInfo = buf.length >= 48 && flags & FLAGS.TARGET_INFO ? Buffer.from(readSecBuf(buf, 40)) : Buffer.alloc(0);
  return { flags, serverChallenge: Buffer.from(buf.subarray(24, 32)), targetName: Buffer.from(readSecBuf(buf, 12)), targetInfo };
}

function avPair(targetInfo, id) {
  for (let at = 0; at + 4 <= targetInfo.length; ) {
    const avId = targetInfo.readUInt16LE(at);
    const len = targetInfo.readUInt16LE(at + 2);
    if (avId === 0) return null;
    if (avId === id) return targetInfo.subarray(at + 4, at + 4 + len);
    at += 4 + len;
  }
  return null;
}

// "DOMAIN\user" in the username wins over an empty domain field.
function splitUser(username, domain) {
  const i = String(username).indexOf('\\');
  if (i < 0 || domain) return { user: String(username), domain: String(domain || '') };
  return { user: username.slice(i + 1), domain: username.slice(0, i) };
}

// opts: { clientChallenge, timestamp } for deterministic output in tests.
export function authenticateMessage(challenge, { username, password, domain, workstation }, opts = {}) {
  const { user, domain: dom } = splitUser(username ?? '', domain);
  const unicode = !!(challenge.flags & FLAGS.UNICODE);
  const enc = (s) => (unicode ? utf16(s) : Buffer.from(String(s ?? ''), 'latin1'));
  const serverTime = avPair(challenge.targetInfo, AV_TIMESTAMP);
  const { ntResponse, lmResponse } = ntlmV2Response({
    responseKey: ntowfV2(password ?? '', user, dom),
    serverChallenge: challenge.serverChallenge,
    clientChallenge: opts.clientChallenge || randomBytes(8),
    timestamp: opts.timestamp || (serverTime ? Buffer.from(serverTime) : fileTime()),
    targetInfo: challenge.targetInfo,
  });
  // MS-NLMP 3.1.5.1.2: with a server timestamp the client sends Z(24) instead of LMv2.
  const lm = serverTime ? Buffer.alloc(24) : lmResponse;
  const fields = [lm, ntResponse, enc(dom), enc(user), enc(workstation || ''), Buffer.alloc(0)];
  const flags = ((challenge.flags & CLIENT_FLAGS) | (unicode ? FLAGS.UNICODE : FLAGS.OEM)) >>> 0;

  const head = Buffer.alloc(64);
  SIGNATURE.copy(head, 0);
  head.writeUInt32LE(3, 8);
  let off = head.length;
  fields.forEach((f, i) => {
    head.writeUInt16LE(f.length, 12 + i * 8);
    head.writeUInt16LE(f.length, 14 + i * 8);
    head.writeUInt32LE(off, 16 + i * 8);
    off += f.length;
  });
  head.writeUInt32LE(flags, 60);
  return Buffer.concat([head, ...fields]);
}

// ---------- HTTP handshake ----------

const NTLM_TOKEN_RE = /(?:^|,)\s*(NTLM|Negotiate)\s+(TlRMTVNT[A-Za-z0-9+/=]*)/i;

export function findChallenge(wwwAuthenticate) {
  const m = NTLM_TOKEN_RE.exec(String(wwwAuthenticate || ''));
  return m ? { scheme: /^ntlm$/i.test(m[1]) ? 'NTLM' : 'Negotiate', token: Buffer.from(m[2], 'base64') } : null;
}

const offers = (www, scheme) => new RegExp(`(?:^|,)\\s*${scheme}(?:\\s|,|$)`, 'i').test(String(www || ''));

const firstLegBody = (body) => {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.byteLength(body) <= FIRST_LEG_BODY_LIMIT ? body : undefined;
  if (body instanceof Uint8Array) return body.length <= FIRST_LEG_BODY_LIMIT ? body : undefined;
  return undefined;
};

function send(url, init, auth, body) {
  const headers = new Headers(init.headers);
  headers.set('authorization', auth);
  if (body === undefined) headers.delete('content-type');
  return fetch(url, { ...init, headers, body });
}

// init: fetch init (method, headers, body, redirect, signal, dispatcher: a single-connection
// dispatcher). Returns the final fetch Response, or the first one if the server does not offer NTLM.
export async function ntlmFetch(url, init, creds) {
  const type1 = negotiateMessage().toString('base64');
  let r = await send(url, init, `NTLM ${type1}`, firstLegBody(init.body));
  let www = r.headers.get('www-authenticate');
  if (r.status === 401 && !findChallenge(www) && !offers(www, 'NTLM') && offers(www, 'Negotiate')) {
    await r.arrayBuffer();
    r = await send(url, init, `Negotiate ${type1}`, firstLegBody(init.body));
    www = r.headers.get('www-authenticate');
  }
  const challenge = r.status === 401 ? findChallenge(www) : null;
  if (!challenge) return r;
  await r.arrayBuffer(); // drain so the connection is free for the final leg
  const type3 = authenticateMessage(parseChallengeMessage(challenge.token), creds).toString('base64');
  return send(r.url || url, init, `${challenge.scheme} ${type3}`, init.body);
}
