import { acceptanceFile } from '../src/paths.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sandboxProfile, cleanEnvironment } from '../src/execution/sandbox.mjs';
import { acceptancePassed } from '../src/execution/acceptance.mjs';

if (process.platform !== 'darwin') throw new Error("This execution self-check requires macOS. The local interface can run on Windows; model code isolation is not yet available there.");
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qwen-check-')));
const outside = await realpath(await mkdtemp(join(tmpdir(), 'qwen-canary-')));
const appDir = join(workspace, 'app');
const stateDir = join(workspace, 'state');
await mkdir(appDir); await mkdir(stateDir);
const nodePath = await realpath(process.execPath);
try {
  const canary = join(outside, 'dummy.txt');
  await writeFile(canary, "dummy - not a real key");
  const profilePath = join(workspace, 'sandbox.sb');
  await writeFile(profilePath, sandboxProfile({ runDir: workspace, nodeDir: dirname(dirname(nodePath)), nodePath, appDir, stateDir }));
  const script = `
import assert from 'node:assert/strict';
import { readFile, writeFile, link, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { Worker } from 'node:worker_threads';
const appDir = ${JSON.stringify(appDir)};
const canary = ${JSON.stringify(canary)};
const denied = error => ['EPERM','EACCES'].includes(error.code);
await writeFile(appDir + '/allowed.txt', 'ok');
assert.equal(await readFile(appDir + '/allowed.txt', 'utf8'), 'ok');
await assert.rejects(readFile(canary), denied);
await assert.rejects(writeFile(canary, 'changed'), denied);
await symlink(canary, appDir + '/symlink');
await assert.rejects(readFile(appDir + '/symlink'), denied);
try { await link(canary, appDir + '/hardlink'); await assert.rejects(readFile(appDir + '/hardlink'), denied); }
catch (error) { if (!denied(error)) throw error; }
assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
const shell = spawnSync('/bin/sh', ['-c', 'printf forbidden']);
assert.ok(shell.error && denied(shell.error), 'Subprocesses must be blocked.');
await new Promise((resolve, reject) => {
  const socket = net.connect(9, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); reject(new Error('Netwerktoegang was toegestaan.')); });
  socket.once('error', error => { socket.destroy(); if (denied(error)) resolve(); else reject(error); });
});
await new Promise((resolve, reject) => {
  const worker = new Worker('require("node:worker_threads").parentPort.postMessage("worker-ok")', { eval: true });
  worker.once('message', value => { if (value === 'worker-ok') resolve(); else reject(new Error('Worker onbruikbaar.')); worker.terminate(); });
  worker.once('error', reject);
});
console.log('canary-ok');
`;
  await writeFile(join(workspace, 'canary.mjs'), script);
  const run = parameters => {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, nodePath, ...parameters], {
      cwd: workspace, env: cleanEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 500_000,
    });
    return { passed: result.status === 0 && !result.error, output: (result.stdout || '') + (result.stderr || ''), result };
  };
  const checked = run(['canary.mjs']);
  assert.ok(checked.passed && checked.output.includes('canary-ok'), checked.output || JSON.stringify({ status: checked.result.status, signal: checked.result.signal, error: checked.result.error?.message }));
  const suite = await readFile(acceptanceFile, 'utf8');
  const names = [...suite.matchAll(/^test\((['"])(.*?)\1/gm)].map(match => match[2]);
  assert.equal(names.length, 18);
  await copyFile(acceptanceFile, join(workspace, 'acceptance.mjs'));
  await writeFile(join(appDir, 'app.mjs'), 'process.exit(0);');
  const early = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, nodePath, '--test', '--experimental-test-isolation=none', 'acceptance.mjs'], {
    cwd: workspace, env: { ...cleanEnvironment(), CANDIDATE_PATH: join(appDir, 'app.mjs'), STATE_DIR: stateDir, PHASE: 'baseline' },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 500_000,
  });
  assert.equal(acceptancePassed({ passed: early.status === 0 && !early.error, output: (early.stdout || '') + (early.stderr || '') }, names), false);
  console.log("Self-check passed: workspace accessible; outside files, links, subprocesses, and network blocked; Workers available; early exit does not count as passing.");
  console.log("This checks the execution environment. No model was called and no HR app was evaluated.");
} finally {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
