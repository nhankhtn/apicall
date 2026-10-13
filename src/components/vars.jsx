// {{variable}} awareness for inputs and code editors: highlighting, autocomplete, hover cards.
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUi, useWs } from '../store.js';
import { describeVar, effectiveValue, DYNAMIC_NAMES } from '../lib/vars.js';
import { findNode } from '../lib/model.js';

const VarsContext = createContext(null);

const SCOPE_LABEL = { local: 'Local', data: 'Data', environment: 'Environment', collection: 'Collection', globals: 'Global', vault: 'Vault', dynamic: 'Dynamic' };
export const scopeLabel = (s) => SCOPE_LABEL[s] || s;

// Provides the variables visible to a request (its collection, the active environment, globals, vault).
export function VarsProvider({ refId, children }) {
  const ws = useWs((s) => s.ws);
  const envId = useUi((s) => s.envId);
  const vault = useUi((s) => s.vault);
  const value = useMemo(() => {
    const env = ws.environments.find((e) => e.id === envId);
    const f = refId ? findNode(ws, refId) : null;
    const sources = {
      environment: env?.values || [],
      collection: f?.collection?.variables || [],
      globals: ws.globals,
      vault: new Map(vault.filter((v) => v.key).map((v) => [v.key, v.value])),
    };
    const seen = new Set();
    const list = [];
    for (const scope of ['environment', 'collection', 'globals']) {
      for (const v of sources[scope]) {
        if (!v.key || v.enabled === false || seen.has(v.key)) continue;
        seen.add(v.key);
        list.push({ name: v.key, scope, value: effectiveValue(v), secret: v.type === 'secret' });
      }
    }
    for (const [k, v] of sources.vault) list.push({ name: `vault:${k}`, scope: 'vault', value: v, secret: true });
    for (const n of DYNAMIC_NAMES) list.push({ name: n, scope: 'dynamic', value: '' });
    return { list, describe: (name) => describeVar(name.trim(), sources), envName: env?.name || null };
  }, [ws, envId, vault, refId]);
  return <VarsContext.Provider value={value}>{children}</VarsContext.Provider>;
}

export const useVars = () => useContext(VarsContext);

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function tokenize(text) {
  const parts = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], name: m[1], start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) parts.push({ text: text.slice(last) });
  return parts;
}

const mask = (v) => (v ? '•'.repeat(Math.min(12, String(v).length)) : '');

export function VarCard({ name, vars, style }) {
  const d = vars?.describe(name);
  return (
    <div className="var-card" style={style}>
      <div className="var-card-name mono">{name}</div>
      {d ? (
        <>
          <div className="var-card-value mono">{d.secret ? mask(d.value) : d.value === '' ? <i>(empty)</i> : String(d.value)}</div>
          <div className="var-card-scope">{scopeLabel(d.scope)}</div>
        </>
      ) : (
        <div className="var-card-missing">Unresolved variable. Define it in the environment, collection or globals.</div>
      )}
    </div>
  );
}

let measureCanvas;
function textWidth(text, font) {
  measureCanvas ||= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Character index under an x offset (relative to the input's content box, scroll included).
function indexAt(text, x, font, letterSpacing) {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const w = textWidth(text.slice(0, mid), font) + mid * letterSpacing;
    if (w <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// A text input that highlights {{vars}}, suggests names after "{{" and explains them on hover.
export function VarInput({ value, onChange, className = '', inputRef, onKeyDown, ...rest }) {
  const vars = useVars();
  const ownRef = useRef(null);
  const ref = inputRef || ownRef;
  const hlRef = useRef(null);
  const [suggest, setSuggest] = useState(null); // { items, index, from, left }
  const [hover, setHover] = useState(null); // { name, left }

  // Mirror the input's text metrics onto the highlight layer.
  useLayoutEffect(() => {
    const input = ref.current;
    const hl = hlRef.current;
    if (!input || !hl) return;
    const cs = getComputedStyle(input);
    for (const p of ['font', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'lineHeight', 'textIndent']) hl.style[p] = cs[p];
    hl.scrollLeft = input.scrollLeft;
  });

  const sync = () => {
    if (hlRef.current && ref.current) hlRef.current.scrollLeft = ref.current.scrollLeft;
  };

  const metrics = () => {
    const cs = getComputedStyle(ref.current);
    return { font: cs.font, ls: parseFloat(cs.letterSpacing) || 0, pad: parseFloat(cs.paddingLeft) || 0 };
  };

  const updateSuggest = (text, caret) => {
    if (!vars) return setSuggest(null);
    const m = text.slice(0, caret).match(/\{\{([^{}\s]*)$/);
    if (!m) return setSuggest(null);
    const q = m[1].toLowerCase();
    const items = vars.list.filter((v) => v.name.toLowerCase().includes(q)).slice(0, 50);
    if (!items.length) return setSuggest(null);
    const { font, ls, pad } = metrics();
    const from = caret - m[1].length;
    const left = Math.max(0, Math.min(pad + textWidth(text.slice(0, from), font) + from * ls - ref.current.scrollLeft, ref.current.clientWidth - 260));
    setSuggest({ items, index: 0, from, caret, left });
  };

  const accept = (item) => {
    const text = String(value ?? '');
    const after = text.slice(suggest.caret);
    const closing = after.startsWith('}}') ? '' : '}}';
    const next = `${text.slice(0, suggest.from)}${item.name}${closing}${after}`;
    onChange(next);
    const caret = suggest.from + item.name.length + 2;
    setSuggest(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
      sync();
    });
  };

  const onMove = (e) => {
    const text = String(value ?? '');
    if (!text.includes('{{')) return hover && setHover(null);
    const rect = ref.current.getBoundingClientRect();
    const { font, ls, pad } = metrics();
    const x = e.clientX - rect.left - pad + ref.current.scrollLeft;
    const i = indexAt(text, x, font, ls);
    const tok = tokenize(text).find((t) => t.name && i >= t.start && i < t.end);
    if (!tok) return hover && setHover(null);
    if (hover?.name !== tok.name) setHover({ name: tok.name, left: Math.max(0, Math.min(e.clientX - rect.left, rect.width - 240)) });
  };

  return (
    <div className={`var-input ${className}`}>
      <div className="var-hl" ref={hlRef} aria-hidden>
        {tokenize(value).map((p, i) =>
          p.name ? (
            <span key={i} className={!vars ? '' : vars.describe(p.name) ? 'v-ok' : 'v-bad'}>
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {' '}
      </div>
      <input
        ref={ref}
        value={value ?? ''}
        spellCheck={false}
        autoComplete="off"
        {...rest}
        onChange={(e) => {
          onChange(e.target.value);
          updateSuggest(e.target.value, e.target.selectionStart);
        }}
        onScroll={sync}
        onSelect={sync}
        onKeyUp={sync}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setTimeout(() => setSuggest(null), 120)}
        onKeyDown={(e) => {
          if (suggest) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const d = e.key === 'ArrowDown' ? 1 : -1;
              setSuggest({ ...suggest, index: (suggest.index + d + suggest.items.length) % suggest.items.length });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              accept(suggest.items[suggest.index]);
              return;
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setSuggest(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {suggest && (
        <ul className="var-suggest glass" style={{ left: suggest.left }}>
          {suggest.items.map((it, i) => (
            <li
              key={it.name}
              className={i === suggest.index ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(it);
              }}
            >
              <span className="mono">{it.name}</span>
              <span className="var-suggest-scope">{scopeLabel(it.scope)}</span>
              {it.scope !== 'dynamic' && <span className="var-suggest-value mono">{it.secret ? mask(it.value) : it.value}</span>}
            </li>
          ))}
        </ul>
      )}
      {hover && !suggest && <VarCard name={hover.name} vars={vars} style={{ left: hover.left }} />}
    </div>
  );
}
