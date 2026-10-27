import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { watchedPreview } from '../src/server/preview-watch.mjs';

function page(hasPrevious, state) {
  const nodes = { strong: {}, '.builder-caption': {}, svg: { style: {} }, '.preview-builder': { append(button) { nodes.button = button; } } };
  const children = [{ tagName: 'SCRIPT' }, ...(hasPrevious ? [{ tagName: 'MAIN' }] : [])];
  const host = { style: {}, setAttribute() {}, attachShadow() { return { set innerHTML(value) {}, querySelector: key => nodes[key] }; } };
  const timers = [];
  const context = { document: { body: { children, append: node => children.push(node) }, createElement: name => name === 'div' ? host : { addEventListener() {} } }, location: { href: 'http://127.0.0.1:1234/cap/index.html', reload() { context.reloads++; } }, window: { addEventListener() {} }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, URL, reloads: 0, fetch: async () => ({ ok: true, json: async () => state }) };
  const html = watchedPreview('<body></body>', state);
  new vm.Script(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))).runInNewContext(context);
  return { nodes, host, context, timers };
}
test('failed standalone preview offers old app only when one is actually loaded', () => {
  const state = { failed: true, ready: false, building: false, revision: 'failed' };
  const shell = page(false, state); assert.equal(shell.nodes.button.hidden, true);
  const old = page(true, state); assert.equal(old.nodes.button.hidden, false); assert.equal(old.context.reloads, 0);
});
test('preview reloads only after success and changed build revision', async () => {
  const state = { failed: false, ready: true, building: false, revision: 'v1' };
  const p = page(true, state); await p.timers.shift()(); assert.equal(p.context.reloads, 0);
  state.building = true; state.ready = false; await p.timers.shift()(); assert.equal(p.host.style.display, 'block'); assert.equal(p.context.reloads, 0);
  state.building = false; state.ready = true; state.revision = 'v2'; await p.timers.shift()(); assert.equal(p.context.reloads, 1);
});
