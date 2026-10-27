import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { extractHtml, checkHtml } from '../src/execution/crm-runner.mjs';
import { createPreviewService } from '../src/server/crm-preview.mjs';

test('HTML-uitpakken accepteert uitsluitend volledig document, geen begeleidende tekst', () => {
  const html = '<!doctype html><html><body>test</body></html>';
  assert.equal(extractHtml(html), html + '\n');
  assert.equal(extractHtml('```html\n' + html + '\n```'), html + '\n');
  for (const input of ['uitleg\n' + html, '<html></html>', '<!doctype html><html>', null]) assert.throws(() => extractHtml(input));
});
test('JavaScript wordt alleen geparseerd; syntaxisfout wordt gevonden', () => {
  globalThis.crmMustNotRun = false;
  const checked = checkHtml('<!doctype html><html><script>globalThis.crmMustNotRun = true;</script></html>');
  assert.equal(checked[1].pass, true);
  assert.equal(globalThis.crmMustNotRun, false);
  assert.equal(checkHtml('<!doctype html><html><script>const x = var(--muted);</script></html>')[1].pass, false);
  delete globalThis.crmMustNotRun;
});
test('preview heeft aparte origin, alleen toegestane pagina en beperkte connecties', async t => {
  const service = createPreviewService(async id => { assert.equal(id, 'run1'); return '<!doctype html><html>ok</html>'; });
  t.after(() => service.close());
  const url = await service.open('run1');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src https:\/\/crm-api.trimedixs.nl;/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(new URL('/api/config', url))).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  const foreignHost = await new Promise((resolve, reject) => { const req = http.get(url, { headers: { Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(foreignHost, 404);
});

test('React-preview mag alleen in de expliciete Studio-origins worden ingebed', async t => {
  const service = createPreviewService(async () => ({ content: '<!doctype html><html>React fixture</html>', allowHttps: true, allowEmbed: true }), { parentOrigins: () => ['http://127.0.0.1:4179', 'tauri://localhost'] });
  t.after(() => service.close());
  const response = await fetch(await service.open('react1'));
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:4179 tauri:\/\/localhost;/);
  assert.match(csp, /connect-src 'self' https: wss:;/);
  assert.ok(!csp.includes('frame-ancestors *'));
});
