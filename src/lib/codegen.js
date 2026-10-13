// Postman-style "Code snippet" generator. Input is a fully resolved request spec:
// { method, url, headers: [{ key, value }], body: { type, ... } }.

const LANGS = [
  ['curl', 'cURL', 'text', curl],
  ['httpie', 'HTTPie', 'text', httpie],
  ['wget', 'Wget', 'text', wget],
  ['powershell', 'PowerShell - Invoke-RestMethod', 'text', powershell],
  ['js-fetch', 'JavaScript - Fetch', 'javascript', jsFetch],
  ['node-axios', 'Node.js - Axios', 'javascript', nodeAxios],
  ['node-native', 'Node.js - Native', 'javascript', nodeNative],
  ['python-requests', 'Python - Requests', 'text', pythonRequests],
  ['python-http.client', 'Python - http.client', 'text', pythonHttpClient],
  ['go', 'Go - Native', 'text', goNative],
  ['java-okhttp', 'Java - OkHttp', 'text', (s) => okhttp(s, false)],
  ['csharp-httpclient', 'C# - HttpClient', 'text', csharp],
  ['php-curl', 'PHP - cURL', 'text', phpCurl],
  ['ruby', 'Ruby - Net::HTTP', 'text', ruby],
  ['rust-reqwest', 'Rust - reqwest', 'text', rustReqwest],
  ['swift-urlsession', 'Swift - URLSession', 'text', swift],
  ['dart-http', 'Dart - http', 'text', dartHttp],
  ['kotlin-okhttp', 'Kotlin - OkHttp', 'text', (s) => okhttp(s, true)],
];

export const LANGUAGES = LANGS.map(([id, label, editorLang]) => ({ id, label, editorLang }));
const GENERATORS = Object.fromEntries(LANGS.map(([id, , , gen]) => [id, gen]));

export function generateCode(langId, spec) {
  const gen = GENERATORS[langId];
  if (!gen) throw new Error(`Unknown snippet language: ${langId}`);
  return gen(normalize(spec));
}

// ---------- Shared helpers ----------

const BOUNDARY = '----ApiCallFormBoundary7MA4YWxkTrZu0gW';
const MULTIPART_CT = `multipart/form-data; boundary=${BOUNDARY}`;
const NO_BODY = { type: 'none' };

function normalize(spec) {
  const body = spec.body || NO_BODY;
  let headers = (spec.headers || []).filter((h) => h && h.key);
  // Multipart libraries generate their own Content-Type with the boundary.
  if (body.type === 'formdata') headers = headers.filter((h) => !isCT(h.key));
  return { method: String(spec.method || 'GET').toUpperCase(), url: String(spec.url || ''), headers, body };
}

const isCT = (k) => k.toLowerCase() === 'content-type';
const contentType = (s) => s.headers.find((h) => isCT(h.key))?.value;
const filePath = (name) => `/path/to/${name || 'file'}`;
const formEncode = (fields) => new URLSearchParams(fields.map((f) => [f.key, f.value ?? ''])).toString();
const indent = (lines, pad) => lines.map((l) => (l ? pad + l : l));

// Headers plus the form Content-Type when a urlencoded body is sent without one.
function withFormCT(s) {
  if (s.body.type !== 'urlencoded' || contentType(s)) return s.headers;
  return [...s.headers, { key: 'Content-Type', value: 'application/x-www-form-urlencoded' }];
}

// Headers for languages that build the multipart body by hand.
function rawHeaders(s) {
  const hdrs = withFormCT(s);
  return s.body.type === 'formdata' ? [...hdrs, { key: 'Content-Type', value: MULTIPART_CT }] : hdrs;
}

// C-family double/single-quoted literal. `braces` selects \u{X} over \uXXXX.
function cStr(s, { quote = '"', dollar = false, braces = false } = {}) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === quote || (dollar && ch === '$')) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c >= 0xd800 && c <= 0xdfff) out += '�'; // lone surrogate
    else if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) {
      const hex = c.toString(16);
      out += braces ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
    } else out += ch;
  }
  return quote + out + quote;
}

const sh = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
const ANSI_C = { '\\': '\\\\', "'": "\\'", '\r': '\\r', '\n': '\\n', '\t': '\\t' };
// Bash $'...' quoting, for text that must carry CR/LF on one line.
const ansiC = (s) =>
  `$'${String(s ?? '').replace(/[\\'\x00-\x1f\x7f]/g, (c) => ANSI_C[c] || `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`;
const js = (s) => cStr(s, { quote: "'" });
const dq = (s) => cStr(s);
const kt = (s) => cStr(s, { dollar: true });
const dart = (s) => cStr(s, { quote: "'", dollar: true });
const rs = (s) => cStr(s, { braces: true });
// PHP / Ruby single quotes: only \\ and \' are escapes.
const phpq = (s) => `'${String(s ?? '').replace(/[\\']/g, '\\$&')}'`;
// PowerShell treats the typographic single quotes as quote characters too.
const psq = (s) => `'${String(s ?? '').replace(/['‘’‚‛]/g, '$&$&')}'`;

// Multipart body as text and file segments, for languages without a multipart API.
function multipartPlan(fields) {
  const esc = (v) => String(v ?? '').replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const segs = [];
  let text = '';
  for (const f of fields) {
    text += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${esc(f.key)}"`;
    if (f.type === 'file') {
      text += `; filename="${esc(f.fileName || 'file')}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      segs.push({ text }, { file: filePath(f.fileName) });
      text = '\r\n';
    } else text += `\r\n\r\n${f.value ?? ''}\r\n`;
  }
  segs.push({ text: `${text}--${BOUNDARY}--\r\n` });
  return segs;
}

const fieldsOf = (s) => s.body.fields || [];
const textOf = (s) => s.body.text ?? '';

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return new URL(`http://${raw}`);
  }
}

// ---------- Shell ----------

function curl(s) {
  // -X HEAD would wait for a body that never comes; `Name;` sends an empty header.
  const parts = [s.method === 'HEAD' ? `curl -I ${sh(s.url)}` : `curl -i -X ${s.method} ${sh(s.url)}`];
  for (const h of s.headers) parts.push(`-H ${sh(h.value === '' ? `${h.key};` : `${h.key}: ${h.value}`)}`);
  const b = s.body;
  if (b.type === 'text') parts.push(`--data-raw ${sh(textOf(s))}`);
  // curl encodes only the part after `=`, so the name is pre-encoded.
  if (b.type === 'urlencoded') for (const f of fieldsOf(s)) parts.push(`--data-urlencode ${sh(`${formEncode([{ key: f.key }]).slice(0, -1)}=${f.value ?? ''}`)}`);
  if (b.type === 'binary') parts.push(`--data-binary ${sh(`@${filePath(b.fileName)}`)}`);
  if (b.type === 'formdata') {
    for (const f of fieldsOf(s)) {
      // --form-string never interprets @ / < in values.
      if (f.type === 'file') parts.push(`-F ${sh(`${f.key}=@${filePath(f.fileName)}`)}`);
      else parts.push(`--form-string ${sh(`${f.key}=${f.value ?? ''}`)}`);
    }
  }
  return parts.join(' \\\n  ');
}

function httpie(s) {
  const key = (k) => String(k).replace(/[\\:=@]/g, '\\$&');
  const b = s.body;
  const opts = ['--print=hb'];
  const items = [];
  let stdin = '';
  if (b.type === 'text') opts.push(`--raw ${sh(textOf(s))}`);
  if (b.type === 'binary') stdin = ` < ${sh(filePath(b.fileName))}`;
  if (b.type === 'urlencoded') opts.push('--form');
  if (b.type === 'formdata') opts.push('--multipart');
  if (!stdin) opts.push('--ignore-stdin');
  if (b.type === 'urlencoded' || b.type === 'formdata') {
    for (const f of fieldsOf(s)) {
      items.push(f.type === 'file' ? sh(`${key(f.key)}@${filePath(f.fileName)}`) : sh(`${key(f.key)}=${f.value ?? ''}`));
    }
  }
  // `Name;` sends an empty header; `Name:` would remove it.
  const hdrs = s.headers.map((h) => sh(h.value === '' ? `${key(h.key)};` : `${key(h.key)}:${h.value}`));
  const parts = [`http ${opts.join(' ')} ${s.method} ${sh(s.url)}`, ...hdrs, ...items];
  return parts.join(' \\\n  ') + stdin;
}

function wget(s) {
  const b = s.body;
  const pre = [];
  const parts = [`wget --quiet --server-response --content-on-error --output-document - --method=${s.method}`];
  for (const h of withFormCT(s)) parts.push(`--header=${sh(`${h.key}: ${h.value}`)}`);
  if (b.type === 'text') parts.push(`--body-data=${sh(textOf(s))}`);
  if (b.type === 'urlencoded') parts.push(`--body-data=${sh(formEncode(fieldsOf(s)))}`);
  if (b.type === 'binary') parts.push(`--body-file=${sh(filePath(b.fileName))}`);
  if (b.type === 'formdata') {
    // wget has no multipart support: assemble the body in a temp file first.
    pre.push('body_file=$(mktemp)', '{');
    for (const seg of multipartPlan(fieldsOf(s))) {
      pre.push(seg.file ? `  cat ${sh(seg.file)}` : `  printf '%s' ${ansiC(seg.text)}`);
    }
    pre.push('} > "$body_file"', '');
    parts.push(`--header=${sh(`Content-Type: ${MULTIPART_CT}`)}`, '--body-file="$body_file"');
  }
  parts.push(sh(s.url));
  return pre.join('\n') + parts.join(' \\\n  ');
}

function powershell(s) {
  const b = s.body;
  const ct = contentType(s);
  const lines = [];
  const args = [`-Uri ${psq(s.url)}`, `-Method ${psq(s.method)}`];
  const hdrs = s.headers.filter((h) => !isCT(h.key));
  if (hdrs.length) {
    lines.push('$headers = @{');
    for (const h of hdrs) lines.push(`  ${psq(h.key)} = ${psq(h.value)}`);
    lines.push('}');
    args.push('-Headers $headers');
  }
  if (b.type === 'text') {
    lines.push(`$body = ${psq(textOf(s))}`);
    args.push('-Body ([System.Text.Encoding]::UTF8.GetBytes($body))');
  }
  if (b.type === 'urlencoded') {
    lines.push(`$body = ${psq(formEncode(fieldsOf(s)))}`);
    args.push('-Body $body');
  }
  if (b.type === 'binary') args.push(`-InFile ${psq(filePath(b.fileName))}`);
  if (b.type === 'formdata') {
    lines.push('$form = [ordered]@{');
    for (const f of fieldsOf(s)) {
      lines.push(`  ${psq(f.key)} = ${f.type === 'file' ? `Get-Item -LiteralPath ${psq(filePath(f.fileName))}` : psq(f.value)}`);
    }
    lines.push('}');
    args.push('-Form $form');
  } else if (ct || b.type === 'urlencoded') args.push(`-ContentType ${psq(ct || 'application/x-www-form-urlencoded')}`);
  args.push('-SkipHttpErrorCheck', '-StatusCodeVariable statusCode');
  return [
    '# Requires PowerShell 7+',
    ...lines,
    `$response = Invoke-RestMethod ${args.join(' `\n  ')}`,
    'Write-Output $statusCode',
    'if ($response -is [string]) { $response } else { $response | ConvertTo-Json -Depth 32 }',
  ].join('\n');
}

// ---------- JavaScript ----------

// Statements that build `body` for fetch/axios. `fileExpr` maps a path to a Blob/Buffer expression.
function jsBody(s, fileExpr, partExpr) {
  const b = s.body;
  if (b.type === 'text') return [`const body = ${js(textOf(s))};`];
  if (b.type === 'binary') return [`const body = ${fileExpr(b.fileName)};`];
  if (b.type === 'urlencoded') {
    return ['const body = new URLSearchParams();', ...fieldsOf(s).map((f) => `body.append(${js(f.key)}, ${js(f.value)});`)];
  }
  if (b.type === 'formdata') {
    return [
      'const body = new FormData();',
      ...fieldsOf(s).map((f) =>
        f.type === 'file'
          ? `body.append(${js(f.key)}, ${partExpr(f.fileName)}, ${js(f.fileName || 'file')});`
          : `body.append(${js(f.key)}, ${js(f.value)});`,
      ),
    ];
  }
  return [];
}

const jsHeaders = (hdrs) => ['{', ...hdrs.map((h) => `  ${js(h.key)}: ${js(h.value)},`), '}'];

function jsFetch(s) {
  const lines = [];
  if (['binary', 'formdata'].includes(s.body.type)) {
    const paths = s.body.type === 'binary' ? [s.body.fileName] : fieldsOf(s).filter((f) => f.type === 'file').map((f) => f.fileName);
    lines.push(`// Pick ${paths.map(filePath).join(', ')} with <input type="file" id="fileInput">.`);
    lines.push("const fileInput = document.getElementById('fileInput');");
  }
  lines.push(...jsBody(s, () => 'fileInput.files[0]', () => 'fileInput.files[0]'));
  const opts = [`method: ${js(s.method)}`];
  if (s.headers.length) opts.push(`headers: ${jsHeaders(s.headers).join('\n  ')}`);
  if (s.body.type !== 'none') opts.push('body');
  lines.push(
    `const response = await fetch(${js(s.url)}, {`,
    ...opts.map((o) => `  ${o},`),
    '});',
    'console.log(response.status);',
    'console.log(await response.text());',
  );
  return lines.join('\n');
}

function nodeAxios(s) {
  const fileish = ['binary', 'formdata'].includes(s.body.type);
  const body = jsBody(s, (n) => `fs.readFileSync(${js(filePath(n))})`, (n) => `await fs.openAsBlob(${js(filePath(n))})`);
  const cfg = [`method: ${js(s.method)}`, `url: ${js(s.url)}`];
  if (s.headers.length) cfg.push(`headers: ${jsHeaders(s.headers).join('\n    ')}`);
  if (s.body.type !== 'none') cfg.push('data: body');
  cfg.push('responseType: \'text\'', 'transformResponse: (data) => data', 'validateStatus: () => true');
  return [
    "const axios = require('axios');",
    ...(fileish ? ["const fs = require('fs');"] : []),
    '',
    'async function main() {',
    ...indent(body, '  '),
    '  const response = await axios({',
    ...cfg.map((c) => `    ${c},`),
    '  });',
    '  console.log(response.status);',
    '  console.log(response.data);',
    '}',
    '',
    'main().catch((err) => console.error(err));',
  ].join('\n');
}

function nodeNative(s) {
  const b = s.body;
  const mod = parseUrl(s.url).protocol === 'http:' ? 'http' : 'https';
  const hdrs = rawHeaders(s);
  const lines = [`const ${mod} = require('${mod}');`];
  if (b.type === 'binary' || b.type === 'formdata') lines.push("const fs = require('fs');");
  lines.push('');
  if (b.type === 'text') lines.push(`const body = ${js(textOf(s))};`);
  if (b.type === 'urlencoded') lines.push(`const body = ${js(formEncode(fieldsOf(s)))};`);
  if (b.type === 'binary') lines.push(`const body = fs.readFileSync(${js(filePath(b.fileName))});`);
  if (b.type === 'formdata') {
    lines.push('const body = Buffer.concat([');
    for (const seg of multipartPlan(fieldsOf(s))) {
      lines.push(seg.file ? `  fs.readFileSync(${js(seg.file)}),` : `  Buffer.from(${js(seg.text)}),`);
    }
    lines.push(']);');
  }
  const hasBody = b.type !== 'none';
  const hasLen = hdrs.some((h) => h.key.toLowerCase() === 'content-length');
  const opts = [`method: ${js(s.method)}`];
  const hl = hdrs.map((h) => `${js(h.key)}: ${js(h.value)}`);
  if (hasBody && !hasLen) hl.push("'Content-Length': Buffer.byteLength(body)");
  if (hl.length) opts.push(['headers: {', ...hl.map((h) => `  ${h},`), '}'].join('\n  '));
  lines.push(
    'const options = {',
    ...opts.map((o) => `  ${o},`),
    '};',
    '',
    `const req = ${mod}.request(${js(s.url)}, options, (res) => {`,
    '  const chunks = [];',
    "  res.on('data', (chunk) => chunks.push(chunk));",
    "  res.on('end', () => {",
    '    console.log(res.statusCode);',
    '    console.log(Buffer.concat(chunks).toString());',
    '  });',
    '});',
    "req.on('error', (err) => console.error(err));",
  );
  if (hasBody) lines.push('req.write(body);');
  lines.push('req.end();');
  return lines.join('\n');
}

// ---------- Python ----------

const pyDict = (hdrs) => (hdrs.length ? ['{', ...hdrs.map((h) => `    ${dq(h.key)}: ${dq(h.value)},`), '}'] : ['{}']);

function pythonRequests(s) {
  const b = s.body;
  const lines = ['import requests', '', `url = ${dq(s.url)}`, `headers = ${pyDict(s.headers).join('\n')}`];
  const args = [dq(s.method), 'url', 'headers=headers'];
  if (b.type !== 'none') args.push('data=payload');
  if (b.type === 'text') lines.push(`payload = ${dq(textOf(s))}.encode("utf-8")`);
  if (b.type === 'binary') lines.push(`payload = open(${dq(filePath(b.fileName))}, "rb")`);
  if (b.type === 'urlencoded' || b.type === 'formdata') {
    const text = fieldsOf(s).filter((f) => f.type !== 'file');
    lines.push('payload = [', ...text.map((f) => `    (${dq(f.key)}, ${dq(f.value)}),`), ']');
  }
  if (b.type === 'formdata') {
    const file = (f) => `(${dq(f.fileName || 'file')}, open(${dq(filePath(f.fileName))}, "rb"), "application/octet-stream")`;
    const files = fieldsOf(s).filter((f) => f.type === 'file');
    lines.push('files = [', ...files.map((f) => `    (${dq(f.key)}, ${file(f)}),`), ']');
    args.push('files=files');
  }
  lines.push('', `response = requests.request(${args.join(', ')})`, 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

function pythonHttpClient(s) {
  const b = s.body;
  const u = parseUrl(s.url);
  const cls = u.protocol === 'http:' ? 'HTTPConnection' : 'HTTPSConnection';
  const hdrs = rawHeaders(s);
  const port = u.port ? `, ${u.port}` : '';
  const lines = ['import http.client', '', `conn = http.client.${cls}(${dq(u.hostname.replace(/^\[|\]$/g, ''))}${port})`];
  if (b.type === 'none') lines.push('payload = None');
  if (b.type === 'text') lines.push(`payload = ${dq(textOf(s))}.encode("utf-8")`);
  if (b.type === 'urlencoded') lines.push(`payload = ${dq(formEncode(fieldsOf(s)))}`);
  if (b.type === 'binary') lines.push(`with open(${dq(filePath(b.fileName))}, "rb") as f:`, '    payload = f.read()');
  if (b.type === 'formdata') {
    lines.push('', 'def read_file(path):', '    with open(path, "rb") as f:', '        return f.read()', '', 'payload = b"".join([');
    for (const seg of multipartPlan(fieldsOf(s))) {
      lines.push(seg.file ? `    read_file(${dq(seg.file)}),` : `    ${dq(seg.text)}.encode("utf-8"),`);
    }
    lines.push('])');
  }
  lines.push(
    `headers = ${pyDict(hdrs).join('\n')}`,
    `conn.request(${dq(s.method)}, ${dq(u.pathname + u.search)}, payload, headers)`,
    'res = conn.getresponse()',
    'print(res.status)',
    'print(res.read().decode("utf-8"))',
  );
  return lines.join('\n');
}

// ---------- Go ----------

// `if err != nil` block at the given tab depth.
const goCheck = (cond, depth = 1) => {
  const t = '\t'.repeat(depth);
  return [`${t}if ${cond} {`, `${t}\tfmt.Println(err)`, `${t}\treturn`, `${t}}`];
};

function goNative(s) {
  const b = s.body;
  const imports = new Set(['fmt', 'io', 'net/http']);
  const fail = goCheck('err != nil');
  const lines = [`endpoint := ${dq(s.url)}`];
  let payload = 'nil';
  if (b.type === 'text') {
    imports.add('strings');
    lines.push(`payload := strings.NewReader(${dq(textOf(s))})`);
  }
  if (b.type === 'urlencoded') {
    imports.add('strings').add('net/url');
    lines.push('form := url.Values{}', ...fieldsOf(s).map((f) => `form.Add(${dq(f.key)}, ${dq(f.value)})`));
    lines.push('payload := strings.NewReader(form.Encode())');
  }
  if (b.type === 'binary') {
    imports.add('os');
    lines.push(`payload, err := os.Open(${dq(filePath(b.fileName))})`, ...goCheck('err != nil', 0), 'defer payload.Close()');
  }
  if (b.type === 'formdata') {
    imports.add('bytes').add('mime/multipart').add('os');
    lines.push('payload := &bytes.Buffer{}', 'writer := multipart.NewWriter(payload)');
    for (const f of fieldsOf(s)) {
      if (f.type !== 'file') {
        lines.push(`_ = writer.WriteField(${dq(f.key)}, ${dq(f.value)})`);
        continue;
      }
      lines.push(
        '{',
        `\tfile, err := os.Open(${dq(filePath(f.fileName))})`,
        ...fail,
        '\tdefer file.Close()',
        `\tpart, err := writer.CreateFormFile(${dq(f.key)}, ${dq(f.fileName || 'file')})`,
        ...fail,
        ...goCheck('_, err := io.Copy(part, file); err != nil'),
        '}',
      );
    }
    lines.push(...goCheck('err := writer.Close(); err != nil', 0));
  }
  if (b.type !== 'none') payload = 'payload';
  lines.push('', `req, err := http.NewRequest(${dq(s.method)}, endpoint, ${payload})`, ...goCheck('err != nil', 0));
  for (const h of withFormCT(s)) lines.push(`req.Header.Add(${dq(h.key)}, ${dq(h.value)})`);
  if (b.type === 'formdata') lines.push('req.Header.Set("Content-Type", writer.FormDataContentType())');
  lines.push('', 'res, err := http.DefaultClient.Do(req)', ...goCheck('err != nil', 0), 'defer res.Body.Close()', '');
  lines.push('body, err := io.ReadAll(res.Body)', ...goCheck('err != nil', 0), 'fmt.Println(res.StatusCode)', 'fmt.Println(string(body))');
  const imp = [...imports].sort().map((i) => `\t"${i}"`);
  return ['package main', '', 'import (', ...imp, ')', '', 'func main() {', ...indent(lines, '\t'), '}'].join('\n');
}

// ---------- JVM (OkHttp) ----------

const OKHTTP_BODY_METHODS = ['POST', 'PUT', 'PATCH', 'PROPPATCH', 'REPORT'];

// Java and Kotlin share the shape; `k` switches the syntax bits that differ.
function okhttp(s, k) {
  const b = s.body;
  const q = k ? kt : dq;
  const neu = k ? '' : 'new ';
  const end = k ? '' : ';';
  const mt = (v) => (v == null ? 'null' : k ? `${q(v)}.toMediaTypeOrNull()` : `MediaType.parse(${q(v)})`);
  const bytes = (expr, m) => (k ? `${expr}.toRequestBody(${m})` : `RequestBody.create(${m}, ${expr})`);
  const file = (name, m) => (k ? `File(${q(filePath(name))}).asRequestBody(${m})` : `RequestBody.create(${m}, new File(${q(filePath(name))}))`);
  const OCTET = mt('application/octet-stream');
  let body = [];
  if (b.type !== 'none' && !['GET', 'HEAD'].includes(s.method)) {
    if (b.type === 'text') body = [bytes(k ? `${q(textOf(s))}.toByteArray()` : `${q(textOf(s))}.getBytes(StandardCharsets.UTF_8)`, mt(contentType(s)))];
    if (b.type === 'binary') body = [file(b.fileName, contentType(s) ? mt(contentType(s)) : OCTET)];
    if (b.type === 'urlencoded') body = [`${neu}FormBody.Builder()`, ...fieldsOf(s).map((f) => `    .add(${q(f.key)}, ${q(f.value)})`), '    .build()'];
    if (b.type === 'formdata') {
      body = [`${neu}MultipartBody.Builder().setType(MultipartBody.FORM)`, '    .build()'];
      body.splice(1, 0, ...fieldsOf(s).map((f) =>
        f.type === 'file'
          ? `    .addFormDataPart(${q(f.key)}, ${q(f.fileName || 'file')}, ${file(f.fileName, OCTET)})`
          : `    .addFormDataPart(${q(f.key)}, ${q(f.value)})`,
      ));
    }
  } else if (OKHTTP_BODY_METHODS.includes(s.method)) body = [bytes(k ? 'ByteArray(0)' : 'new byte[0]', 'null')];
  const lines = [];
  if (body.length) lines.push(`${k ? 'val' : 'RequestBody'} body = ${body[0]}`, ...body.slice(1));
  if (body.length) lines[lines.length - 1] += end;
  lines.push(`${k ? 'val' : 'Request'} request = ${neu}Request.Builder()`, `    .url(${q(s.url)})`, `    .method(${q(s.method)}, ${body.length ? 'body' : 'null'})`);
  for (const h of s.headers) lines.push(`    .addHeader(${q(h.key)}, ${q(h.value)})`);
  lines.push(`    .build()${end}`);
  const usesFile = b.type === 'binary' || fieldsOf(s).some((f) => f.type === 'file');
  if (k) {
    const imports = ['FormBody', 'MediaType.Companion.toMediaTypeOrNull', 'MultipartBody', 'OkHttpClient', 'Request', 'RequestBody.Companion.asRequestBody', 'RequestBody.Companion.toRequestBody'];
    return [
      '// Dependency: com.squareup.okhttp3:okhttp:4.x',
      ...(usesFile ? ['import java.io.File'] : []),
      ...imports.map((i) => `import okhttp3.${i}`),
      '',
      'fun main() {',
      '    val client = OkHttpClient()',
      ...indent(lines, '    '),
      '    client.newCall(request).execute().use { response ->',
      '        println(response.code)',
      '        println(response.body?.string())',
      '    }',
      '}',
    ].join('\n');
  }
  return [
    '// Dependency: com.squareup.okhttp3:okhttp',
    ...(usesFile ? ['import java.io.File;'] : []),
    'import java.nio.charset.StandardCharsets;',
    'import okhttp3.*;',
    '',
    'public class Main {',
    '    public static void main(String[] args) throws Exception {',
    '        OkHttpClient client = new OkHttpClient();',
    ...indent(lines, '        '),
    '        try (Response response = client.newCall(request).execute()) {',
    '            System.out.println(response.code());',
    '            System.out.println(response.body().string());',
    '        }',
    '    }',
    '}',
  ].join('\n');
}

// ---------- C# ----------

const CONTENT_HEADERS = /^(content-|expires$|last-modified$|allow$)/i;

function csharp(s) {
  const b = s.body;
  const lines = [
    'using var client = new HttpClient();',
    `var request = new HttpRequestMessage(new HttpMethod(${dq(s.method)}), ${dq(s.url)});`,
  ];
  const content = s.headers.filter((h) => CONTENT_HEADERS.test(h.key));
  for (const h of s.headers) if (!CONTENT_HEADERS.test(h.key)) lines.push(`request.Headers.TryAddWithoutValidation(${dq(h.key)}, ${dq(h.value)});`);
  if (b.type === 'text') lines.push(`var content = new ByteArrayContent(Encoding.UTF8.GetBytes(${dq(textOf(s))}));`);
  if (b.type === 'binary') lines.push(`var content = new ByteArrayContent(File.ReadAllBytes(${dq(filePath(b.fileName))}));`);
  if (b.type === 'urlencoded') {
    lines.push('var content = new FormUrlEncodedContent(new[]', '{');
    for (const f of fieldsOf(s)) lines.push(`    new KeyValuePair<string, string>(${dq(f.key)}, ${dq(f.value)}),`);
    lines.push('});');
  }
  if (b.type === 'formdata') {
    lines.push('var content = new MultipartFormDataContent();');
    for (const f of fieldsOf(s)) {
      if (f.type === 'file') lines.push(`content.Add(new StreamContent(File.OpenRead(${dq(filePath(f.fileName))})), ${dq(f.key)}, ${dq(f.fileName || 'file')});`);
      else lines.push(`content.Add(new StringContent(${dq(f.value)}), ${dq(f.key)});`);
    }
  }
  if (b.type !== 'none') {
    // Replace the default content headers with the ones from the request.
    for (const h of content) lines.push(`content.Headers.Remove(${dq(h.key)});`, `content.Headers.TryAddWithoutValidation(${dq(h.key)}, ${dq(h.value)});`);
    lines.push('request.Content = content;');
  }
  lines.push(
    'var response = await client.SendAsync(request);',
    'Console.WriteLine((int)response.StatusCode);',
    'Console.WriteLine(await response.Content.ReadAsStringAsync());',
  );
  return [
    'using System;',
    'using System.Collections.Generic;',
    'using System.IO;',
    'using System.Net.Http;',
    'using System.Text;',
    'using System.Threading.Tasks;',
    '',
    'class Program',
    '{',
    '    static async Task Main()',
    '    {',
    ...indent(lines, '        '),
    '    }',
    '}',
  ].join('\n');
}

// ---------- PHP ----------

function phpCurl(s) {
  const b = s.body;
  const opts = [`CURLOPT_URL => ${phpq(s.url)}`, 'CURLOPT_RETURNTRANSFER => true', `CURLOPT_CUSTOMREQUEST => ${phpq(s.method)}`];
  if (s.method === 'HEAD') opts.push('CURLOPT_NOBODY => true');
  if (b.type === 'text') opts.push(`CURLOPT_POSTFIELDS => ${phpq(textOf(s))}`);
  if (b.type === 'urlencoded') opts.push(`CURLOPT_POSTFIELDS => ${phpq(formEncode(fieldsOf(s)))}`);
  if (b.type === 'binary') opts.push(`CURLOPT_POSTFIELDS => file_get_contents(${phpq(filePath(b.fileName))})`);
  if (b.type === 'formdata') {
    const items = fieldsOf(s).map((f) =>
      f.type === 'file'
        ? `${phpq(f.key)} => new CURLFile(${phpq(filePath(f.fileName))}, 'application/octet-stream', ${phpq(f.fileName || 'file')})`
        : `${phpq(f.key)} => ${phpq(f.value)}`,
    );
    opts.push(['CURLOPT_POSTFIELDS => [', ...items.map((i) => `  ${i},`), ']'].join('\n  '));
  }
  const hdrs = withFormCT(s);
  if (hdrs.length) opts.push(['CURLOPT_HTTPHEADER => [', ...hdrs.map((h) => `  ${phpq(`${h.key}: ${h.value}`)},`), ']'].join('\n  '));
  return [
    '<?php',
    '$curl = curl_init();',
    'curl_setopt_array($curl, [',
    ...opts.map((o) => `  ${o},`),
    ']);',
    '$response = curl_exec($curl);',
    'if ($response === false) {',
    "  echo 'Error: ' . curl_error($curl) . PHP_EOL;",
    '  exit(1);',
    '}',
    'echo curl_getinfo($curl, CURLINFO_RESPONSE_CODE) . PHP_EOL;',
    'echo $response . PHP_EOL;',
    'curl_close($curl);',
  ].join('\n');
}

// ---------- Ruby ----------

function ruby(s) {
  const b = s.body;
  const lines = [
    "require 'uri'",
    "require 'net/http'",
    '',
    `url = URI(${phpq(s.url)})`,
    'http = Net::HTTP.new(url.host, url.port)',
    "http.use_ssl = url.scheme == 'https'",
    `request = Net::HTTPGenericRequest.new(${phpq(s.method)}, ${b.type !== 'none'}, ${s.method !== 'HEAD'}, url.request_uri)`,
  ];
  for (const h of withFormCT(s)) lines.push(`request[${phpq(h.key)}] = ${phpq(h.value)}`);
  if (b.type === 'text') lines.push(`request.body = ${phpq(textOf(s))}`);
  if (b.type === 'binary') lines.push(`request.body = File.binread(${phpq(filePath(b.fileName))})`);
  if (b.type === 'urlencoded') {
    lines.push('request.body = URI.encode_www_form([', ...fieldsOf(s).map((f) => `  [${phpq(f.key)}, ${phpq(f.value)}],`), '])');
  }
  if (b.type === 'formdata') {
    const file = (f) => `File.open(${phpq(filePath(f.fileName))}, 'rb'), { filename: ${phpq(f.fileName || 'file')} }`;
    lines.push('form = [', ...fieldsOf(s).map((f) => `  [${phpq(f.key)}, ${f.type === 'file' ? file(f) : phpq(f.value)}],`), ']');
    lines.push("request.set_form(form, 'multipart/form-data')");
  }
  lines.push('', 'response = http.request(request)', 'puts response.code', 'puts response.body');
  return lines.join('\n');
}

// ---------- Rust ----------

function rustReqwest(s) {
  const b = s.body;
  const chain = [`.request(reqwest::Method::from_bytes(${rs(s.method)}.as_bytes())?, ${rs(s.url)})`];
  for (const h of s.headers) chain.push(`.header(${rs(h.key)}, ${rs(h.value)})`);
  const pre = [];
  if (b.type === 'text') chain.push(`.body(${rs(textOf(s))})`);
  if (b.type === 'binary') chain.push(`.body(std::fs::read(${rs(filePath(b.fileName))})?)`);
  if (b.type === 'urlencoded') {
    pre.push('let params = [', ...fieldsOf(s).map((f) => `    (${rs(f.key)}, ${rs(f.value)}),`), '];');
    chain.push('.form(&params)');
  }
  if (b.type === 'formdata') {
    pre.push('let form = reqwest::blocking::multipart::Form::new()');
    for (const f of fieldsOf(s)) {
      if (f.type === 'file') pre.push(`    .file(${rs(f.key)}, ${rs(filePath(f.fileName))})?`);
      else pre.push(`    .text(${rs(f.key)}, ${rs(f.value)})`);
    }
    pre[pre.length - 1] += ';';
    chain.push('.multipart(form)');
  }
  chain.push('.send()?;');
  return [
    '// Cargo.toml: reqwest = { version = "0.12", features = ["blocking", "multipart"] }',
    'fn main() -> Result<(), Box<dyn std::error::Error>> {',
    '    let client = reqwest::blocking::Client::new();',
    ...indent(pre, '    '),
    '    let response = client',
    ...chain.map((c) => `        ${c}`),
    '    println!("{}", response.status().as_u16());',
    '    println!("{}", response.text()?);',
    '    Ok(())',
    '}',
  ].join('\n');
}

// ---------- Swift ----------

function swift(s) {
  const b = s.body;
  const hdrs = rawHeaders(s);
  // URL(string:) rejects unencoded characters, so pass the normalized form.
  let url = s.url;
  try {
    url = new URL(s.url).href;
  } catch {
    /* keep as typed */
  }
  const fileData = (p) => `try! Data(contentsOf: URL(fileURLWithPath: ${rs(p)}))`;
  const lines = [
    'import Foundation',
    '#if canImport(FoundationNetworking)',
    'import FoundationNetworking',
    '#endif',
    '',
    `var request = URLRequest(url: URL(string: ${rs(url)})!, timeoutInterval: Double.infinity)`,
    `request.httpMethod = ${rs(s.method)}`,
    ...hdrs.map((h) => `request.addValue(${rs(h.value)}, forHTTPHeaderField: ${rs(h.key)})`),
  ];
  if (b.type === 'text') lines.push(`request.httpBody = Data(${rs(textOf(s))}.utf8)`);
  if (b.type === 'urlencoded') lines.push(`request.httpBody = Data(${rs(formEncode(fieldsOf(s)))}.utf8)`);
  if (b.type === 'binary') lines.push(`request.httpBody = ${fileData(filePath(b.fileName))}`);
  if (b.type === 'formdata') {
    lines.push('var body = Data()');
    for (const seg of multipartPlan(fieldsOf(s))) lines.push(seg.file ? `body.append(${fileData(seg.file)})` : `body.append(Data(${rs(seg.text)}.utf8))`);
    lines.push('request.httpBody = body');
  }
  lines.push(
    '',
    'let semaphore = DispatchSemaphore(value: 0)',
    'let task = URLSession.shared.dataTask(with: request) { data, response, error in',
    '  defer { semaphore.signal() }',
    '  if let error = error {',
    '    print(error)',
    '    return',
    '  }',
    '  if let http = response as? HTTPURLResponse { print(http.statusCode) }',
    '  if let data = data { print(String(decoding: data, as: UTF8.self)) }',
    '}',
    'task.resume()',
    'semaphore.wait()',
  );
  return lines.join('\n');
}

// ---------- Dart ----------

function dartHttp(s) {
  const b = s.body;
  const multi = b.type === 'formdata';
  const lines = [`final request = http.${multi ? 'MultipartRequest' : 'Request'}(${dart(s.method)}, Uri.parse(${dart(s.url)}));`];
  const hdrs = withFormCT(s);
  if (hdrs.length) {
    lines.push('request.headers.addAll({', ...hdrs.map((h) => `  ${dart(h.key)}: ${dart(h.value)},`), '});');
  }
  // bodyBytes (unlike body) leaves the Content-Type header untouched.
  if (b.type === 'text') lines.push(`request.bodyBytes = utf8.encode(${dart(textOf(s))});`);
  if (b.type === 'urlencoded') lines.push(`request.bodyBytes = utf8.encode(${dart(formEncode(fieldsOf(s)))});`);
  if (b.type === 'binary') lines.push(`request.bodyBytes = await File(${dart(filePath(b.fileName))}).readAsBytes();`);
  if (multi) {
    for (const f of fieldsOf(s)) {
      if (f.type === 'file') {
        lines.push(`request.files.add(await http.MultipartFile.fromPath(${dart(f.key)}, ${dart(filePath(f.fileName))}, filename: ${dart(f.fileName || 'file')}));`);
      } else lines.push(`request.fields[${dart(f.key)}] = ${dart(f.value)};`);
    }
  }
  lines.push('', 'final response = await request.send();', 'print(response.statusCode);', 'print(await response.stream.bytesToString());');
  const imports = [];
  if (b.type === 'text' || b.type === 'urlencoded') imports.push("import 'dart:convert';");
  if (b.type === 'binary') imports.push("import 'dart:io';");
  return [
    '// pubspec.yaml: dependencies: http: ^1.2.0',
    ...imports,
    "import 'package:http/http.dart' as http;",
    '',
    'Future<void> main() async {',
    ...indent(lines, '  '),
    '}',
  ].join('\n');
}
