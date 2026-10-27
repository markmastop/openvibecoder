import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import { runtimeTarget, desktopTarget, verifyRuntimePackage } from '../scripts/prepare-desktop.mjs';

test('desktop gebruikt de Rust-brug voor instellingen en bestanden, zonder browsernetwerk of opgeslagen sleutel', async () => {
  const calls = [];
  const window = {
    __TAURI__: { core: { invoke: async (command, input) => {
      calls.push({ command, input }); return { status: 200, body: '{"configured":true}' };
    } } },
    fetch() { assert.fail('Desktop mag niet rechtstreeks met een netwerkadres verbinden.'); },
  };
  vm.runInNewContext(await readFile(new URL('../src/ui/public/desktop-transport.js', import.meta.url), 'utf8'), { window, Response });
  const response = await window.bimClientFetch('/api/config', { method: 'POST', body: '{"provider":"openrouter","token":"fixture-key"}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, true);
  assert.equal(calls[0].command, 'client_request');
  assert.equal(calls[0].input.request.body.token, 'fixture-key');
  assert.equal(calls[0].input.request.path, '/api/config');
  assert.equal(window.token, undefined);
  assert.equal(window.bimDesktop, true);
  await window.bimClientFetch('/api/runs/run-1/file?path=app.mjs');
  assert.equal(calls[1].input.request.method, 'GET');
  window.__TAURI__.core.invoke = async () => { throw 'Herstart BIM Build Labs.'; };
  await assert.rejects(window.bimClientFetch('/api/status'), /Herstart BIM Build Labs/);
});

test('desktopruntime heeft expliciete Mac- en Windowsdoelen en geen stille fallback', () => {
  assert.equal(runtimeTarget('darwin', 'arm64')[1], 'aarch64-apple-darwin');
  assert.equal(runtimeTarget('darwin', 'x64')[1], 'x86_64-apple-darwin');
  assert.equal(runtimeTarget('win32', 'x64')[2], 'zip');
  assert.throws(() => runtimeTarget('win32', 'arm64'), /supported/);
});

test('echte desktopbouwdienst vereist sessieauthenticatie en bewaart instellingen buiten de app', { timeout: 10000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'bim-desktop-test-'));
  const authorization = 'fixture-local-session-'.repeat(3);
  const child = spawn(process.execPath, ['src/server/ui-server.mjs', '--desktop'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH, BIM_CLIENT_DATA_DIR: data, BIM_DESKTOP_TOKEN: authorization },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.stdin.end(); child.kill(); await exited; await rm(data, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktopdienst startte niet.')), 3000);
    child.once('error', reject);
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.startsWith('BIM_STUDIO_READY ')) { clearTimeout(timer); resolve(JSON.parse(line.slice(17)).port); }
    });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(endpoint + '/api/status')).status, 403);
  const headers = { Authorization: `Bearer ${authorization}` };
  assert.equal((await fetch(endpoint + '/api/status', { headers })).status, 200);
  const configured = await fetch(endpoint + '/api/config', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', token: 'fixture-only-no-real-key' }),
  });
  assert.equal(configured.status, 200);
  assert.match(await readFile(join(data, '.env.local'), 'utf8'), /fixture-only-no-real-key/);
  if (process.platform !== 'win32') assert.equal((await stat(join(data, '.env.local'))).mode & 0o777, 0o600);
  const checked = execFileSync(process.execPath, ['src/execution/runner.mjs', '--check'], {
    cwd: resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH, BIM_CLIENT_DATA_DIR: data }, encoding: 'utf8',
  });
  assert.match(checked, /No API request/);
  for (const path of ['/.env.local', '/', '/app.js']) assert.equal((await fetch(endpoint + path, { headers })).status, 404);
  child.stdin.end();
  assert.equal((await exited).code, 0);
});

test('crossvoorbereiding volgt het doelplatform, niet de Mac-host, en verifieert platformpakketten',()=>{
  assert.deepEqual(desktopTarget({TAURI_ENV_TARGET_TRIPLE:'x86_64-pc-windows-msvc'},'darwin','arm64'),{platform:'win32',arch:'x64'});
  assert.deepEqual(desktopTarget({},'darwin','arm64'),{platform:'darwin',arch:'arm64'});
  assert.throws(()=>desktopTarget({BIM_DESKTOP_TARGET:'../unknown'},'darwin','arm64'));
  const data=Buffer.from('fixture-package');const integrity='sha512-'+createHash('sha512').update(data).digest('base64');
  assert.doesNotThrow(()=>verifyRuntimePackage(data,integrity));assert.throws(()=>verifyRuntimePackage(Buffer.from('changed'),integrity));
});
