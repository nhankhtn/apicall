import { useState } from 'react';
import { VarInput } from './vars.jsx';
import { Select } from './Menu.jsx';
import { getOAuth2Token, oauthRedirectUri, toast } from '../actions.js';
import { errMsg } from '../lib/util.js';

const TYPES = [
  ['inherit', 'Inherit auth from parent'],
  ['noauth', 'No Auth'],
  ['bearer', 'Bearer Token'],
  ['basic', 'Basic Auth'],
  ['apikey', 'API Key'],
  ['jwt', 'JWT Bearer'],
  ['digest', 'Digest Auth'],
  ['oauth2', 'OAuth 2.0'],
  ['awsv4', 'AWS Signature'],
  ['hawk', 'Hawk Authentication'],
  ['ntlm', 'NTLM Authentication'],
];

const DEFAULTS = {
  bearer: { token: '' },
  basic: { username: '', password: '' },
  apikey: { key: '', value: '', in: 'header' },
  digest: { username: '', password: '' },
  awsv4: { accessKey: '', secretKey: '', region: '', service: '', sessionToken: '' },
  hawk: { authId: '', authKey: '', algorithm: 'sha256', user: '', nonce: '', ext: '', app: '', delegation: '', timestamp: '', includePayloadHash: false },
  ntlm: { username: '', password: '', domain: '', workstation: '' },
  jwt: { algorithm: 'HS256', secret: '', privateKey: '', secretBase64: false, payload: '{\n  "sub": "1234567890"\n}', header: '', addTo: 'header', headerPrefix: 'Bearer', queryParamKey: 'token' },
  oauth2: {
    accessToken: '',
    headerPrefix: 'Bearer',
    addTo: 'header',
    grantType: 'client_credentials',
    authUrl: '',
    accessTokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    username: '',
    password: '',
    redirectUri: '',
    usePkce: true,
    clientAuth: 'header',
    autoFetch: false,
  },
};

const typeLabel = (t) => TYPES.find(([k]) => k === t)?.[1] || t;

// A div, not a <label>: a label would forward its click to a dropdown trigger and toggle it twice.
function Field({ label, children, hint }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint small">{hint}</span>}
    </div>
  );
}

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

function OAuth2({ o, set, refId }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const getToken = async () => {
    setBusy(true);
    try {
      const t = await getOAuth2Token(o, refId);
      set({ accessToken: t.accessToken, ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}) });
      setInfo(t);
      toast('New access token received', 'success');
    } catch (e) {
      toast(errMsg(e), 'error', 7000);
    } finally {
      setBusy(false);
    }
  };
  const code = o.grantType === 'authorization_code';
  return (
    <>
      <div className="auth-section">Current token</div>
      <Field label="Access token">
        <VarInput className="mono" value={o.accessToken} placeholder="Paste a token, or get a new one below" onChange={(v) => set({ accessToken: v })} />
      </Field>
      <div className="field-row">
        <Field label="Add token to">
          <Select value={o.addTo || 'header'} onChange={(addTo) => set({ addTo })} options={opts([['header', 'Request headers'], ['query', 'Request URL (access_token)']])} />
        </Field>
        <Field label="Header prefix">
          <input value={o.headerPrefix ?? 'Bearer'} onChange={(e) => set({ headerPrefix: e.target.value })} />
        </Field>
      </div>
      {info && (
        <p className="hint small">
          Token type {info.tokenType}
          {info.expiresIn ? `, expires in ${info.expiresIn}s` : ''}
          {info.raw?.scope ? `, scope "${info.raw.scope}"` : ''}.
        </p>
      )}

      <div className="auth-section">Configure new token</div>
      <Field label="Grant type">
        <Select
          value={o.grantType}
          onChange={(grantType) => set({ grantType })}
          options={opts([
            ['client_credentials', 'Client Credentials'],
            ['password', 'Password Credentials'],
            ['authorization_code', 'Authorization Code'],
            ['refresh_token', 'Refresh Token'],
          ])}
        />
      </Field>
      {code && (
        <>
          <Field label="Auth URL">
            <VarInput value={o.authUrl} placeholder="https://auth.example.com/authorize" onChange={(v) => set({ authUrl: v })} />
          </Field>
          <Field label="Callback URL" hint={`Register this redirect URI with the provider. Default: ${oauthRedirectUri()}`}>
            <VarInput value={o.redirectUri} placeholder={oauthRedirectUri()} onChange={(v) => set({ redirectUri: v })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={o.usePkce !== false} onChange={(e) => set({ usePkce: e.target.checked })} /> Use PKCE (S256)
          </label>
        </>
      )}
      <Field label="Access token URL">
        <VarInput value={o.accessTokenUrl} placeholder="https://auth.example.com/oauth/token" onChange={(v) => set({ accessTokenUrl: v })} />
      </Field>
      <div className="field-row">
        <Field label="Client ID">
          <VarInput value={o.clientId} onChange={(v) => set({ clientId: v })} />
        </Field>
        <Field label="Client secret">
          <VarInput value={o.clientSecret} onChange={(v) => set({ clientSecret: v })} />
        </Field>
      </div>
      {o.grantType === 'password' && (
        <div className="field-row">
          <Field label="Username">
            <VarInput value={o.username} onChange={(v) => set({ username: v })} />
          </Field>
          <Field label="Password">
            <VarInput value={o.password} onChange={(v) => set({ password: v })} />
          </Field>
        </div>
      )}
      {o.grantType === 'refresh_token' && (
        <Field label="Refresh token">
          <VarInput className="mono" value={o.refreshToken || ''} onChange={(v) => set({ refreshToken: v })} />
        </Field>
      )}
      <div className="field-row">
        <Field label="Scope">
          <VarInput value={o.scope} placeholder="read write" onChange={(v) => set({ scope: v })} />
        </Field>
        <Field label="Client authentication">
          <Select value={o.clientAuth || 'header'} onChange={(clientAuth) => set({ clientAuth })} options={opts([['header', 'Send as Basic Auth header'], ['body', 'Send client credentials in body']])} />
        </Field>
      </div>
      {!code && (
        <label className="check">
          <input type="checkbox" checked={!!o.autoFetch} onChange={(e) => set({ autoFetch: e.target.checked })} />
          Fetch a token automatically when the token field is empty (also during collection runs)
        </label>
      )}
      <button className="btn primary" disabled={busy || !o.accessTokenUrl || (code && !o.authUrl)} onClick={getToken}>
        {busy ? 'Requesting…' : 'Get New Access Token'}
      </button>
    </>
  );
}

function Jwt({ j, set }) {
  const hmac = /^HS/.test(j.algorithm);
  return (
    <>
      <div className="field-row">
        <Field label="Algorithm">
          <Select
            value={j.algorithm}
            onChange={(algorithm) => set({ algorithm })}
            options={['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'].map((a) => ({ value: a, label: a }))}
          />
        </Field>
        <Field label="Add JWT token to">
          <Select value={j.addTo || 'header'} onChange={(addTo) => set({ addTo })} options={opts([['header', 'Request header'], ['query', 'Query param']])} />
        </Field>
      </div>
      {hmac ? (
        <>
          <Field label="Secret">
            <VarInput value={j.secret} onChange={(v) => set({ secret: v })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={!!j.secretBase64} onChange={(e) => set({ secretBase64: e.target.checked })} /> Secret is Base64 encoded
          </label>
        </>
      ) : (
        <Field label="Private key (PKCS#8 PEM)">
          <textarea className="mono pem" value={j.privateKey} placeholder="-----BEGIN PRIVATE KEY-----" onChange={(e) => set({ privateKey: e.target.value })} />
        </Field>
      )}
      <Field label="Payload (JSON, supports {{variables}})">
        <textarea className="mono pem" value={j.payload} onChange={(e) => set({ payload: e.target.value })} />
      </Field>
      <Field label="Extra JWT headers (JSON, optional)">
        <textarea className="mono small-area" value={j.header} placeholder='{"kid": "key-1"}' onChange={(e) => set({ header: e.target.value })} />
      </Field>
      {j.addTo === 'query' ? (
        <Field label="Query param name">
          <input value={j.queryParamKey || 'token'} onChange={(e) => set({ queryParamKey: e.target.value })} />
        </Field>
      ) : (
        <Field label="Header prefix">
          <input value={j.headerPrefix ?? 'Bearer'} onChange={(e) => set({ headerPrefix: e.target.value })} />
        </Field>
      )}
    </>
  );
}

// `inherited` = { auth, from } resolved from the parents, shown when type is "inherit".
export default function AuthEditor({ auth, onChange, allowInherit = true, inherited, refId }) {
  const a = auth || { type: allowInherit ? 'inherit' : 'noauth' };
  const cfg = a[a.type] || {};
  const set = (patch) => onChange({ ...a, [a.type]: { ...cfg, ...patch } });
  const types = TYPES.filter(([k]) => allowInherit || k !== 'inherit');

  return (
    <div className="auth-editor">
      <Field label="Type">
        <Select
          value={a.type === 'unsupported' ? '' : a.type}
          minWidth={240}
          onChange={(type) => onChange({ type, ...(DEFAULTS[type] ? { [type]: { ...DEFAULTS[type], ...(a[type] || {}) } } : {}) })}
          options={[...(a.type === 'unsupported' ? [{ value: '', label: `${a.original?.type} (unsupported)`, disabled: true }] : []), ...opts(types)]}
        />
      </Field>

      {a.type === 'inherit' && (
        <p className="hint">
          {inherited?.from ? `Uses ${typeLabel(inherited.auth.type)} from ${inherited.from.type} "${inherited.from.name}".` : 'No parent defines auth, so no auth is sent.'}
        </p>
      )}
      {a.type === 'noauth' && <p className="hint">No Authorization header is added.</p>}
      {a.type === 'unsupported' && (
        <p className="hint warn">
          Auth type "{a.original?.type}" came from a Postman import. It is kept so it exports back unchanged, but it is not applied when sending.
        </p>
      )}
      {a.type === 'bearer' && (
        <Field label="Token">
          <VarInput className="mono" value={cfg.token} placeholder="{{token}}" onChange={(v) => set({ token: v })} />
        </Field>
      )}
      {(a.type === 'basic' || a.type === 'digest') && (
        <>
          <Field label="Username">
            <VarInput value={cfg.username} onChange={(v) => set({ username: v })} />
          </Field>
          <Field label="Password">
            <VarInput value={cfg.password} onChange={(v) => set({ password: v })} />
          </Field>
          {a.type === 'digest' && <p className="hint small">The request is sent once to get the server's challenge, then again with the Digest response (MD5, SHA-256, -sess, qop auth/auth-int).</p>}
        </>
      )}
      {a.type === 'apikey' && (
        <>
          <Field label="Key">
            <VarInput className="mono" value={cfg.key} placeholder="X-API-Key" onChange={(v) => set({ key: v })} />
          </Field>
          <Field label="Value">
            <VarInput className="mono" value={cfg.value} placeholder="{{apiKey}}" onChange={(v) => set({ value: v })} />
          </Field>
          <Field label="Add to">
            <Select value={cfg.in || 'header'} onChange={(v) => set({ in: v })} options={opts([['header', 'Header'], ['query', 'Query Params']])} />
          </Field>
        </>
      )}
      {a.type === 'awsv4' && (
        <>
          <div className="field-row">
            <Field label="Access key">
              <VarInput value={cfg.accessKey} onChange={(v) => set({ accessKey: v })} />
            </Field>
            <Field label="Secret key">
              <VarInput value={cfg.secretKey} onChange={(v) => set({ secretKey: v })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="AWS region">
              <VarInput value={cfg.region} placeholder="ap-southeast-1" onChange={(v) => set({ region: v })} />
            </Field>
            <Field label="Service name">
              <VarInput value={cfg.service} placeholder="execute-api" onChange={(v) => set({ service: v })} />
            </Field>
          </div>
          <Field label="Session token (optional)">
            <VarInput value={cfg.sessionToken} onChange={(v) => set({ sessionToken: v })} />
          </Field>
        </>
      )}
      {a.type === 'hawk' && (
        <>
          <div className="field-row">
            <Field label="Hawk Auth ID">
              <VarInput value={cfg.authId} onChange={(v) => set({ authId: v })} />
            </Field>
            <Field label="Hawk Auth Key">
              <VarInput value={cfg.authKey} onChange={(v) => set({ authKey: v })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Algorithm">
              <Select value={cfg.algorithm || 'sha256'} onChange={(algorithm) => set({ algorithm })} options={opts([['sha256', 'SHA256'], ['sha1', 'SHA1']])} />
            </Field>
            <Field label="User (optional)">
              <VarInput value={cfg.user} onChange={(v) => set({ user: v })} />
            </Field>
          </div>
          <div className="field-row three">
            <Field label="Nonce" hint="Empty = random">
              <VarInput value={cfg.nonce} onChange={(v) => set({ nonce: v })} />
            </Field>
            <Field label="ext">
              <VarInput value={cfg.ext} onChange={(v) => set({ ext: v })} />
            </Field>
            <Field label="Timestamp" hint="Empty = now">
              <VarInput value={cfg.timestamp} onChange={(v) => set({ timestamp: v })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="app">
              <VarInput value={cfg.app} onChange={(v) => set({ app: v })} />
            </Field>
            <Field label="dlg">
              <VarInput value={cfg.delegation} onChange={(v) => set({ delegation: v })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!cfg.includePayloadHash} onChange={(e) => set({ includePayloadHash: e.target.checked })} /> Include payload hash
          </label>
        </>
      )}
      {a.type === 'ntlm' && (
        <>
          <div className="field-row">
            <Field label="Username">
              <VarInput value={cfg.username} onChange={(v) => set({ username: v })} />
            </Field>
            <Field label="Password">
              <VarInput value={cfg.password} onChange={(v) => set({ password: v })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Domain (optional)">
              <VarInput value={cfg.domain} onChange={(v) => set({ domain: v })} />
            </Field>
            <Field label="Workstation (optional)">
              <VarInput value={cfg.workstation} onChange={(v) => set({ workstation: v })} />
            </Field>
          </div>
          <p className="hint small">NTLMv2. The server performs the three-step handshake on one connection, as Postman does.</p>
        </>
      )}
      {a.type === 'jwt' && <Jwt j={{ ...DEFAULTS.jwt, ...cfg }} set={set} />}
      {a.type === 'oauth2' && <OAuth2 o={{ ...DEFAULTS.oauth2, ...cfg }} set={set} refId={refId} />}
      {['bearer', 'basic', 'apikey', 'jwt', 'oauth2'].includes(a.type) && (
        <p className="hint small">An Authorization header set explicitly in Headers takes precedence.</p>
      )}
    </div>
  );
}
