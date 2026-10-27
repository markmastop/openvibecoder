import { format } from 'prettier/standalone';
import babel from 'prettier/plugins/babel';
import estree from 'prettier/plugins/estree';
import postcss from 'prettier/plugins/postcss';
import htmlPlugin from 'prettier/plugins/html';
import markdownPlugin from 'prettier/plugins/markdown';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';

const language = new Compartment();
const access = new Compartment();
let view, path = '', currentReadOnly = true, applying = false;
function mode(name) {
  if (/\.(jsx|js|mjs)$/.test(name)) return javascript({ jsx: true });
  if (name.endsWith('.json')) return json();
  if (name.endsWith('.css')) return css();
  if (name.endsWith('.html')) return html();
  if (name.endsWith('.md')) return markdown();
  return [];
}
function pretty(text, name, readOnly) {
  if (readOnly && name.endsWith('.json')) { try { return JSON.stringify(JSON.parse(text), null, 2) + '\n'; } catch {} }
  return text;
}
window.bimCodeEditor = {
  mount(parent, onChange) {
    view = new EditorView({ parent, state: EditorState.create({ extensions: [
      EditorView.cspNonce.of(document.getElementById('studio-editor-nonce')?.nonce || ''), lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(), bracketMatching(), indentOnInput(), syntaxHighlighting(defaultHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), language.of([]), access.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      EditorView.contentAttributes.of({ 'aria-label': "Source code with syntax highlighting" }),
      EditorView.theme({ '&': { height: '100%', fontSize: '12px', backgroundColor: '#fbfcfe' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '1.75' }, '.cm-content': { padding: '12px 0', minHeight: '300px' }, '.cm-gutters': { backgroundColor: '#f0f2f5', color: '#8993a0', border: 'none', paddingRight: '8px' }, '&.cm-focused': { outline: 'none' }, '.cm-activeLine': { backgroundColor: '#eff3f8' } }),
      EditorView.updateListener.of(update => { if (update.docChanged && !applying && !currentReadOnly) onChange(update.state.doc.toString()); }),
    ] }) });
  },
  update({ text, filePath, readOnly }) {
    if (!view) return;
    applying = true;
    try {
      const value = pretty(text, filePath, readOnly);
      const effects = [];
      if (path !== filePath) effects.push(language.reconfigure(mode(filePath)));
      if (currentReadOnly !== readOnly) effects.push(access.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]));
      if (view.state.doc.toString() !== value || effects.length) view.dispatch({ ...(view.state.doc.toString() !== value ? { changes: { from: 0, to: view.state.doc.length, insert: value } } : {}), effects });
      if (path !== filePath) { view.scrollDOM.scrollTop = 0; view.scrollDOM.scrollLeft = 0; }
      path = filePath; currentReadOnly = readOnly;
      requestAnimationFrame(() => view.requestMeasure());
    } finally { applying = false; }
  },
  async formatSource() {
    if (!view || currentReadOnly) return;
    const initialPath = path;
    const source = view.state.doc.toString();
    const parser = /\.(js|jsx|mjs)$/.test(path) ? 'babel' : path.endsWith('.json') ? 'json' : path.endsWith('.css') ? 'css' : path.endsWith('.html') ? 'html' : path.endsWith('.md') ? 'markdown' : null;
    if (!parser) return;
    const text = parser === 'json' ? JSON.stringify(JSON.parse(source), null, 2) + '\n' : await format(source, { parser, plugins: [babel, estree, postcss, htmlPlugin, markdownPlugin], tabWidth: 2, singleQuote: true });
    if (path !== initialPath || currentReadOnly || view.state.doc.toString() !== source) throw new Error("The file changed in the meantime. Try again.");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, scrollIntoView: true });
    requestAnimationFrame(() => { view.scrollDOM.scrollLeft = 0; view.scrollDOM.scrollTop = 0; });
  },
};
