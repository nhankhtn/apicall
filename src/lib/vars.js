// Variable scopes and {{variable}} resolution.
// A variable row is { key, value, current?, type?: 'default'|'secret', enabled }:
// `value` is Postman's "initial value" (exported, shared); `current` is the local value
// that requests use and scripts change. Without a current value the initial one applies.
import { uid, stringifyValue } from './util.js';

export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const effectiveValue = (v) => (v.current !== undefined && v.current !== null ? v.current : v.value);

export const toMap = (list) =>
  new Map((list || []).filter((v) => v.enabled !== false && v.key).map((v) => [v.key, effectiveValue(v)]));

// Writes a scope map back into its variable list as current values: updates enabled keys
// in place, drops keys that were unset, appends new ones, leaves disabled rows untouched.
export function writeBack(list, map) {
  const seen = new Set();
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    if (v.enabled === false || !v.key) continue;
    if (map.has(v.key) && !seen.has(v.key)) {
      const next = stringifyValue(map.get(v.key));
      if (next !== effectiveValue(v)) v.current = next;
      seen.add(v.key);
    } else list.splice(i, 1);
  }
  for (const [key, value] of map) {
    if (!seen.has(key)) list.push({ key, value: '', current: stringifyValue(value), enabled: true });
  }
}

export const sameScope = (list, map) =>
  JSON.stringify([...toMap(list)]) === JSON.stringify([...map].map(([k, v]) => [k, stringifyValue(v)]));

// ---------- Dynamic variables ({{$guid}} …), a subset of Postman's faker library ----------

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const chars = (set, len) => Array.from({ length: len }, () => set[rand(set.length)]).join('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const FIRST = ['An', 'Binh', 'Chi', 'Dung', 'Giang', 'Hoa', 'Khoa', 'Linh', 'Minh', 'Nam', 'Phuong', 'Quan', 'Trang', 'Vy', 'Alex', 'Sam', 'Taylor'];
const LAST = ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vo', 'Dang', 'Bui', 'Do', 'Ngo', 'Smith', 'Brown'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'orbit', 'pixel', 'river', 'stone', 'cloud', 'ember', 'lotus', 'maple', 'quartz', 'nova'];
const CITIES = ['Ho Chi Minh', 'Ha Noi', 'Da Nang', 'Can Tho', 'Hai Phong', 'Hue', 'Nha Trang', 'Singapore', 'Tokyo', 'Paris'];
const COUNTRIES = ['Viet Nam', 'Singapore', 'Japan', 'France', 'Germany', 'Canada', 'Australia', 'Thailand'];
const COLORS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'black', 'white', 'orange', 'purple'];
const DOMAINS = ['example.com', 'example.net', 'example.org', 'test.dev'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const randomDate = (from, to) => new Date(from + Math.random() * (to - from));
const DAY = 86400000;

const DYNAMIC = {
  $guid: () => uid(),
  $randomUUID: () => uid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(rand(1001)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => chars(ALNUM, 1),
  $randomHexadecimalColor: () => `#${chars(HEX, 6)}`,
  $randomColor: () => pick(COLORS),
  $randomAbbreviation: () => pick(['API', 'SQL', 'HTTP', 'JSON', 'XML', 'TCP', 'SSL', 'RAM']),
  $randomIP: () => `${rand(256)}.${rand(256)}.${rand(256)}.${rand(256)}`,
  $randomIPV6: () => Array.from({ length: 8 }, () => chars(HEX, 4)).join(':'),
  $randomMACAddress: () => Array.from({ length: 6 }, () => chars(HEX, 2)).join(':'),
  $randomPassword: () => chars(ALNUM + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 15),
  $randomLocale: () => pick(['vi', 'en', 'fr', 'ja', 'de']),
  $randomUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  $randomProtocol: () => pick(['http', 'https']),
  $randomSemver: () => `${rand(10)}.${rand(10)}.${rand(10)}`,
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(LAST)} ${pick(FIRST)}`,
  $randomNamePrefix: () => pick(['Mr.', 'Ms.', 'Mrs.', 'Dr.']),
  $randomJobTitle: () => pick(['Engineer', 'Designer', 'Manager', 'Analyst', 'Developer']),
  $randomUserName: () => `${pick(FIRST).toLowerCase()}${rand(1000)}`,
  $randomEmail: () => `${chars(ALNUM, 8)}@${pick(DOMAINS)}`,
  $randomExampleEmail: () => `${chars(ALNUM, 8)}@example.com`,
  $randomDomainName: () => `${pick(WORDS)}.${pick(['com', 'net', 'org', 'io'])}`,
  $randomUrl: () => `https://${pick(WORDS)}.${pick(['com', 'net', 'org'])}`,
  $randomPhoneNumber: () => `09${pad(rand(1e8), 8)}`,
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES),
  $randomCountryCode: () => pick(['VN', 'SG', 'JP', 'FR', 'DE', 'CA', 'AU', 'TH']),
  $randomStreetAddress: () => `${rand(999) + 1} ${pick(WORDS)} Street`,
  $randomLatitude: () => (Math.random() * 180 - 90).toFixed(4),
  $randomLongitude: () => (Math.random() * 360 - 180).toFixed(4),
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
  $randomCurrencyCode: () => pick(['VND', 'USD', 'EUR', 'JPY', 'SGD']),
  $randomBankAccount: () => pad(rand(1e8), 8),
  $randomCompanyName: () => `${pick(WORDS)[0].toUpperCase()}${pick(WORDS).slice(1)} ${pick(['Ltd', 'Inc', 'Group', 'JSC'])}`,
  $randomProductName: () => `${pick(['Smart', 'Ultra', 'Mini', 'Pro'])} ${pick(WORDS)}`,
  $randomProduct: () => pick(['Shirt', 'Shoes', 'Lotion', 'Serum', 'Cream', 'Mask']),
  $randomDepartment: () => pick(['Beauty', 'Health', 'Books', 'Toys', 'Garden']),
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: 3 }, () => pick(WORDS)).join(' '),
  $randomLoremWord: () => pick(WORDS),
  $randomLoremSentence: () => `${Array.from({ length: 6 }, () => pick(WORDS)).join(' ')}.`,
  $randomLoremParagraph: () => Array.from({ length: 3 }, () => `${Array.from({ length: 8 }, () => pick(WORDS)).join(' ')}.`).join(' '),
  $randomDateFuture: () => randomDate(Date.now(), Date.now() + 365 * DAY).toISOString(),
  $randomDatePast: () => randomDate(Date.now() - 365 * DAY, Date.now()).toISOString(),
  $randomDateRecent: () => randomDate(Date.now() - 2 * DAY, Date.now()).toISOString(),
  $randomWeekday: () => pick(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
  $randomMonth: () => pick(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']),
  $randomFileName: () => `${pick(WORDS)}.${pick(['txt', 'pdf', 'png', 'json'])}`,
  $randomFileExt: () => pick(['txt', 'pdf', 'png', 'json', 'csv']),
  $randomMimeType: () => pick(['application/json', 'text/plain', 'image/png', 'text/csv']),
  $randomImageUrl: () => `https://picsum.photos/seed/${chars(ALNUM, 6)}/640/480`,
  $randomAvatarImage: () => `https://i.pravatar.cc/150?u=${chars(ALNUM, 6)}`,
};
export const DYNAMIC_NAMES = Object.keys(DYNAMIC);

const VAULT_PREFIX = 'vault:';

function replaceWith(str, lookup) {
  let s = String(str ?? '');
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    s = s.replace(VAR_RE, (m, name) => {
      const v = lookup(name);
      if (v === undefined) return m;
      changed = true;
      return stringifyValue(v);
    });
    if (!changed) break;
  }
  return s;
}

export const unresolvedIn = (s) => [...String(s ?? '').matchAll(VAR_RE)].map((m) => m[1]);

// scopes: { local, data, environment, collection, globals, vault } (Maps). Same precedence as Postman.
export function createVars(scopes, { dynamic = true } = {}) {
  const order = [scopes.local, scopes.data, scopes.environment, scopes.collection, scopes.globals];
  const get = (name) => {
    for (const m of order) if (m && m.has(name)) return m.get(name);
    return undefined;
  };
  const lookup = (name) => {
    if (name.startsWith(VAULT_PREFIX)) return scopes.vault?.get(name.slice(VAULT_PREFIX.length));
    if (name.startsWith('$') && DYNAMIC[name]) return dynamic ? DYNAMIC[name]() : undefined;
    return get(name);
  };
  return { ...scopes, get, replaceIn: (s) => replaceWith(s, lookup) };
}

// Where a name resolves, for the editor's highlighting and hover cards.
// Returns { scope, value, secret } or null.
export function describeVar(name, sources) {
  if (name.startsWith('$')) return DYNAMIC[name] ? { scope: 'dynamic', value: 'Generated when the request is sent' } : null;
  if (name.startsWith(VAULT_PREFIX)) {
    const key = name.slice(VAULT_PREFIX.length);
    return sources.vault?.has(key) ? { scope: 'vault', value: sources.vault.get(key), secret: true } : null;
  }
  for (const scope of ['local', 'data', 'environment', 'collection', 'globals']) {
    const list = sources[scope];
    if (!list) continue;
    const row = list.find((v) => v.key === name && v.enabled !== false);
    if (row) return { scope, value: effectiveValue(row), secret: row.type === 'secret' };
  }
  return null;
}
