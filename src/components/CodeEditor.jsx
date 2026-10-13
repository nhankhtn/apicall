import { useMemo, useRef } from 'react';
import { useUi } from '../store.js';
import CodeMirror, { EditorView, EditorState, Decoration, ViewPlugin, MatchDecorator, hoverTooltip } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { openSearchPanel } from '@codemirror/search';
import { scopeLabel } from './vars.jsx';

const baseTheme = EditorView.theme({
  '&': { fontSize: '12.5px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '&.cm-focused': { outline: 'none' },
});

// {{variable}} support: highlight, autocomplete after "{{", hover card.
function varExtensions(varsRef) {
  const deco = new MatchDecorator({
    regexp: /\{\{\s*([^{}]+?)\s*\}\}/g,
    decoration: (m) => Decoration.mark({ class: varsRef.current?.describe(m[1]) ? 'cm-var-ok' : 'cm-var-bad' }),
  });
  const highlighter = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = deco.createDeco(view);
      }
      update(u) {
        this.decorations = deco.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const complete = (ctx) => {
    const m = ctx.matchBefore(/\{\{[^{}\s]*$/);
    if (!m || !varsRef.current) return null;
    return {
      from: m.from + 2,
      options: varsRef.current.list.map((v) => ({
        label: v.name,
        detail: scopeLabel(v.scope),
        info: v.scope === 'dynamic' ? undefined : v.secret ? '••••••' : String(v.value),
        apply: (view, completion, from, to) => {
          const closing = view.state.sliceDoc(to, to + 2) === '}}' ? '' : '}}';
          view.dispatch({ changes: { from, to, insert: `${v.name}${closing}` }, selection: { anchor: from + v.name.length + 2 } });
        },
      })),
      validFor: /^[^{}\s]*$/,
    };
  };
  const hover = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      return {
        pos: from,
        end: to,
        above: true,
        create() {
          const d = varsRef.current?.describe(m[1]);
          const dom = document.createElement('div');
          dom.className = 'var-card cm';
          const name = document.createElement('div');
          name.className = 'var-card-name mono';
          name.textContent = m[1];
          const val = document.createElement('div');
          val.className = d ? 'var-card-value mono' : 'var-card-missing';
          val.textContent = d ? (d.secret ? '••••••' : String(d.value)) : 'Unresolved variable';
          dom.append(name, val);
          if (d) {
            const scope = document.createElement('div');
            scope.className = 'var-card-scope';
            scope.textContent = scopeLabel(d.scope);
            dom.append(scope);
          }
          return { dom };
        },
      };
    }
    return null;
  });
  return [highlighter, EditorState.languageData.of(() => [{ autocomplete: complete }]), hover];
}

// `vars` (from useVars) turns on {{variable}} support. `onSearchRef` receives a function that
// opens the search panel, for an external "search" button.
export default function CodeEditor({ value, onChange, language = 'text', readOnly = false, placeholder, height = '100%', onCreateEditor, wrap = false, vars, onSearchRef }) {
  const isDark = useUi((st) => st.theme === 'dark');
  const varsRef = useRef(vars);
  varsRef.current = vars;
  const withVars = !!vars;
  const extensions = useMemo(() => {
    const ext = [baseTheme];
    if (language === 'json') ext.push(json());
    if (language === 'javascript') ext.push(javascript());
    if (wrap) ext.push(EditorView.lineWrapping);
    if (withVars) ext.push(...varExtensions(varsRef));
    return ext;
  }, [language, wrap, withVars]);

  return (
    <CodeMirror
      className="code-editor"
      value={value ?? ''}
      height={height}
      theme={isDark ? 'dark' : 'light'}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      placeholder={placeholder}
      onChange={onChange}
      onCreateEditor={(view) => {
        if (onSearchRef) onSearchRef.current = () => openSearchPanel(view);
        onCreateEditor?.(view);
      }}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly, autocompletion: true, searchKeymap: true }}
    />
  );
}
