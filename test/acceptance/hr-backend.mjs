import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, test } from 'node:test';
import { Worker } from 'node:worker_threads';

const accounts = {
  employeeA: { username: 'user-a', password: 'oefen-a', id: 'emp-a', role: 'employee', balanceHours: 40 },
  employeeB: { username: 'user-b', password: 'oefen-b', id: 'emp-b', role: 'employee', balanceHours: 40 },
  managerA: { username: 'manager-a', password: 'oefen-ma', id: 'manager-a', role: 'manager', balanceHours: 0 },
  managerB: { username: 'manager-b', password: 'oefen-mb', id: 'manager-b', role: 'manager', balanceHours: 0 },
};
const phase = process.env.PHASE;
const stateDir = process.env.STATE_DIR;
const candidatePath = process.env.CANDIDATE_PATH;
const options = { timeout: 3000, concurrency: false };
let createApp;

before(async () => {
  assert.ok(phase === 'baseline' || phase === 'change', 'Stel PHASE in op baseline of change.');
  assert.ok(stateDir && isAbsolute(stateDir), "STATE_DIR moet de absolute tijdelijke toestandsmap of deze proef zijn.");
  assert.ok(candidatePath && isAbsolute(candidatePath), 'CANDIDATE_PATH moet het absolute pad naar de kandidaatmodule zijn.');
  await mkdir(stateDir, { recursive: true });
  try {
    await access(candidatePath);
  } catch {
    assert.fail('Kandidaat ontbreekt. Laat het model eerst app.mjs maken en stel CANDIDATE_PATH correct in.');
  }
  let candidate;
  try {
    candidate = await import(pathToFileURL(candidatePath).href);
  } catch {
    assert.fail('Kandidaat kon niet worden geladen. Lever geldige Node.js 22-modulecode op zonder externe afhankelijkheden.');
  }
  assert.equal(typeof candidate.createApp, 'function', 'Exporteer createApp({ storageFile }) uit de kandidaatmodule.');
  createApp = candidate.createApp;
}, { timeout: 3000 });

async function fixture(t) {
  const caseDir = await mkdtemp(join(stateDir, 'hr-case-'));
  t.after(async () => { await rm(caseDir, { recursive: true, force: true }); });
  const storageFile = join(caseDir, 'state.json');
  const app = await createApp({ storageFile });
  assert.equal(typeof app?.fetch, 'function', 'createApp moet een object met fetch(request) opleveren.');
  return { app, storageFile };
}

async function freshWorkerApp(t, storageFile) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const pending = new Map();
  let nextId = 0;
  let stopped = false;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      try {
        const candidate = await import(workerData.moduleUrl);
        const app = await candidate.createApp({ storageFile: workerData.storageFile });
        if (typeof app?.fetch !== 'function') throw new Error();
        parentPort.on('message', async ({ id, request }) => {
          try {
            const response = await app.fetch(new Request(request.url, {
              method: request.method,
              headers: request.headers,
              ...(request.body === undefined ? {} : { body: request.body }),
            }));
            if (!(response instanceof Response)) throw new Error();
            parentPort.postMessage({ id, response: {
              status: response.status,
              headers: [...response.headers],
              body: await response.text(),
            } });
          } catch {
            parentPort.postMessage({ id, error: 'Kandidaat kon het verzoek na herstart niet afhandelen.' });
          }
        });
        parentPort.postMessage({ ready: true });
      } catch {
        parentPort.postMessage({ ready: false, error: 'Kandidaat kon in een nieuwe Worker niet worden geladen.' });
      }
    })();
  `, {
    eval: true,
    execArgv: [],
    workerData: { moduleUrl: pathToFileURL(candidatePath).href, storageFile },
  });
  function fail(error) {
    stopped = true;
    rejectReady(error);
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  }
  worker.on('error', () => fail(new Error('De Worker voor de opslagcontrole is gestopt door een fout.')));
  worker.on('exit', () => fail(new Error('De Worker voor de opslagcontrole is beëindigd.')));
  worker.on('message', (message) => {
    if (message.ready === true) {
      resolveReady();
      return;
    }
    if (message.ready === false) {
      fail(new Error(message.error));
      return;
    }
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error));
    else operation.resolve(message.response);
  });
  t.after(async () => { await worker.terminate(); });
  await ready;
  return {
    async fetch(request) {
      assert.ok(!stopped, 'De Worker voor de opslagcontrole moet nog actief zijn.');
      const serialized = {
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
      };
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, request: serialized });
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  };
}

async function call(app, method, path, { token, body, rawBody } = {}) {
  const headers = new Headers();
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
  const init = { method, headers };
  if (body !== undefined || rawBody !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
  }
  const response = await app.fetch(new Request(`https://hr.test${path}`, init));
  assert.ok(response instanceof Response, `${method} ${path}: fetch moet een Response teruggeven.`);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json(?:\s*;|$)/i,
    `${method} ${path}: ook foutantwoorden moeten application/json gebruiken.`);
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    assert.fail(`${method} ${path}: antwoord bevat geen geldige JSON.`);
  }
  assert.ok(data !== null && typeof data === 'object' && !Array.isArray(data),
    `${method} ${path}: verwacht een JSON-object.`);
  return { status: response.status, data };
}

async function login(app, account) {
  const result = await call(app, 'POST', '/login', { body: {
    username: account.username, password: account.password,
  } });
  assert.equal(result.status, 200, 'Een vast oefenaccount moet kunnen inloggen.');
  assert.equal(typeof result.data.token, 'string', 'Login moet een tokenstring teruggeven.');
  assert.ok(result.data.token.length > 0, 'Login mag geen leeg token teruggeven.');
  return result.data.token;
}

async function me(app, token, account, balanceHours = account.balanceHours) {
  const result = await call(app, 'GET', '/me', { token });
  assert.equal(result.status, 200);
  assert.equal(result.data.id, account.id);
  assert.equal(result.data.role, account.role);
  assert.equal(result.data.balanceHours, balanceHours);
  return result.data;
}

function checkRequest(value, { employeeId, hours, status, id } = {}) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Verwacht een aanvraagobject.');
  assert.equal(typeof value.id, 'string', 'Een aanvraag-ID moet een string zijn.');
  assert.ok(value.id.length > 0, 'Een aanvraag-ID mag niet leeg zijn.');
  assert.equal(typeof value.employeeId, 'string');
  assert.equal(typeof value.hours, 'number');
  assert.ok(Number.isInteger(value.hours) && value.hours > 0);
  assert.ok(value.status === 'pending' || value.status === 'approved');
  if (employeeId !== undefined) assert.equal(value.employeeId, employeeId);
  if (hours !== undefined) assert.equal(value.hours, hours);
  if (status !== undefined) assert.equal(value.status, status);
  if (id !== undefined) assert.equal(value.id, id);
  return value;
}

async function add(app, token, hours, employeeId, extra = {}) {
  const result = await call(app, 'POST', '/requests', { token, body: { hours, ...extra } });
  assert.equal(result.status, 201, 'Een geldige aanvraag moet worden aangemaakt.');
  return checkRequest(result.data.request, { employeeId, hours, status: 'pending' });
}

async function list(app, token) {
  const result = await call(app, 'GET', '/requests', { token });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.data.requests), 'requests moet een JSON-array zijn.');
  const ids = new Set();
  for (const request of result.data.requests) {
    checkRequest(request);
    assert.ok(!ids.has(request.id), 'Een aanvraag mag maar één keer in de lijst staan.');
    ids.add(request.id);
  }
  return result.data.requests;
}

async function get(app, token, request) {
  const result = await call(app, 'GET', `/requests/${encodeURIComponent(request.id)}`, { token });
  assert.equal(result.status, 200);
  return checkRequest(result.data.request, { id: request.id, employeeId: request.employeeId, hours: request.hours });
}

async function approve(app, token, request) {
  return call(app, 'POST', `/requests/${encodeURIComponent(request.id)}/approve`, { token });
}

function denied(result) {
  assert.ok(result.status === 403 || result.status === 404, 'Toegang buiten de bevoegdheid moet 403 of 404 geven.');
  assert.equal(result.data.request, undefined, 'Een weigering mag de afgeschermde aanvraag niet alsnog meesturen.');
  assert.equal(result.data.requests, undefined, 'Een weigering mag geen afgeschermde aanvragenlijst meesturen.');
}

test('01 all fixed accounts sign in with the correct identity, role, and starting balance', options, async (t) => {
  const { app } = await fixture(t);
  const tokens = [];
  for (const account of Object.values(accounts)) {
    const token = await login(app, account);
    tokens.push(token);
    await me(app, token, account);
  }
  assert.equal(new Set(tokens).size, tokens.length, 'Verschillende accounts mogen geen gedeelde sessie krijgen.');
});

test('02 incorrect credentials and invalid login fields do not grant access', options, async (t) => {
  const { app } = await fixture(t);
  for (const body of [
    { username: 'user-a', password: 'fout' },
    { username: "unknown", password: 'oefen-a' },
    { username: 'user-a', password: 'oefen-b' },
  ]) {
    const result = await call(app, 'POST', '/login', { body });
    assert.equal(result.status, 401);
    assert.equal(result.data.token, undefined, 'Een geweigerde login mag geen token teruggeven.');
  }
  for (const body of [{}, { username: 'user-a' }, { username: 1, password: 'oefen-a' },
    { username: 'user-a', password: null }, null, [], 'user-a']) {
    assert.equal((await call(app, 'POST', '/login', { body })).status, 400);
  }
  await me(app, await login(app, accounts.employeeA), accounts.employeeA);
});

test('03 protected routes reject missing, invented, and corrupted tokens', options, async (t) => {
  const { app } = await fixture(t);
  const token = await login(app, accounts.employeeA);
  const request = await add(app, token, 8, 'emp-a');
  for (const invalid of [undefined, 'verzonnen-token', `${token}beschadigd`]) {
    for (const [method, path, body] of [
      ['GET', '/me'], ['GET', '/requests'], ['POST', '/requests', { hours: 8 }],
      ['GET', `/requests/${request.id}`], ['POST', `/requests/${request.id}/approve`],
    ]) {
      const result = await call(app, method, path, { token: invalid, body });
      assert.equal(result.status, 401);
      assert.equal(result.data.request, undefined);
      assert.equal(result.data.requests, undefined);
    }
  }
  assert.equal((await list(app, token)).length, 1);
  await me(app, token, accounts.employeeA);
});

test('04 an eight-hour request is readable without immediately deducting the balance', options, async (t) => {
  const { app } = await fixture(t);
  const token = await login(app, accounts.employeeA);
  const request = await add(app, token, 8, 'emp-a');
  assert.equal((await get(app, token, request)).status, 'pending');
  const requests = await list(app, token);
  assert.equal(requests.length, 1);
  checkRequest(requests[0], { id: request.id, employeeId: 'emp-a', hours: 8, status: 'pending' });
  await me(app, token, accounts.employeeA);
});

test('05 supplied owner, role, ID, and status cannot override server decisions', options, async (t) => {
  const { app } = await fixture(t);
  const token = await login(app, accounts.employeeA);
  const request = await add(app, token, 8, 'emp-a', {
    employeeId: 'emp-b', role: 'manager', id: 'door-aanvaller-gekozen', status: 'approved',
  });
  assert.notEqual(request.id, 'door-aanvaller-gekozen');
  assert.equal((await approve(app, token, request)).status, 403);
  await me(app, token, accounts.employeeA);
});

test('06 invalid hours and data types do not change requests or balances', options, async (t) => {
  const { app } = await fixture(t);
  const token = await login(app, accounts.employeeA);
  const invalidHours = [0, -8, 1, 2, 6, 7.5, '8', null, true, [], {}];
  if (phase === 'baseline') invalidHours.push(4, 12);
  for (const hours of invalidHours) {
    assert.equal((await call(app, 'POST', '/requests', { token, body: { hours } })).status, 400,
      `Ongeldige uren moeten 400 geven (type ${typeof hours}).`);
  }
  assert.equal((await call(app, 'POST', '/requests', { token, body: {} })).status, 400);
  for (const body of [null, [], '8']) {
    assert.equal((await call(app, 'POST', '/requests', { token, body })).status, 400);
  }
  assert.equal((await list(app, token)).length, 0);
  await me(app, token, accounts.employeeA);
});

test('07 invalid JSON returns a controlled 400 and leaves state intact', options, async (t) => {
  const { app } = await fixture(t);
  const token = await login(app, accounts.employeeA);
  assert.equal((await call(app, 'POST', '/login', { rawBody: '{' })).status, 400);
  assert.equal((await call(app, 'POST', '/requests', { token, rawBody: '{' })).status, 400);
  assert.equal((await list(app, token)).length, 0);
  await me(app, token, accounts.employeeA);
});

test('08 employee lists contain only their own requests', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const b = await login(app, accounts.employeeB);
  const requestA = await add(app, a, 8, 'emp-a');
  const requestB = await add(app, b, 16, 'emp-b');
  assert.notEqual(requestA.id, requestB.id);
  assert.deepEqual((await list(app, a)).map((request) => request.id), [requestA.id]);
  assert.deepEqual((await list(app, b)).map((request) => request.id), [requestB.id]);
});

test('09 employees cannot directly read another employee request', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const b = await login(app, accounts.employeeB);
  const requestA = await add(app, a, 8, 'emp-a');
  denied(await call(app, 'GET', `/requests/${requestA.id}`, { token: b }));
  assert.equal((await get(app, a, requestA)).status, 'pending');
});

test('10 managers see only requests from their own team', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const b = await login(app, accounts.employeeB);
  const ma = await login(app, accounts.managerA);
  const mb = await login(app, accounts.managerB);
  const requestA = await add(app, a, 8, 'emp-a');
  const requestB = await add(app, b, 8, 'emp-b');
  assert.deepEqual((await list(app, ma)).map((request) => request.id), [requestA.id]);
  assert.deepEqual((await list(app, mb)).map((request) => request.id), [requestB.id]);
  await get(app, ma, requestA);
  await get(app, mb, requestB);
  denied(await call(app, 'GET', `/requests/${requestB.id}`, { token: ma }));
  denied(await call(app, 'GET', `/requests/${requestA.id}`, { token: mb }));
});

test('11 employees cannot approve their own or other employees requests', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const b = await login(app, accounts.employeeB);
  const request = await add(app, a, 8, 'emp-a');
  assert.equal((await approve(app, a, request)).status, 403);
  assert.equal((await approve(app, b, request)).status, 403);
  assert.equal((await get(app, a, request)).status, 'pending');
  await me(app, a, accounts.employeeA);
});

test('12 managers from another team cannot change balances or statuses', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const mb = await login(app, accounts.managerB);
  const request = await add(app, a, 8, 'emp-a');
  assert.equal((await call(app, 'POST', '/requests', { token: mb, body: { hours: 8 } })).status, 403);
  denied(await approve(app, mb, request));
  assert.equal((await get(app, a, request)).status, 'pending');
  await me(app, a, accounts.employeeA);
});

test('13 the correct manager approves and deducts only the correct employee balance', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const b = await login(app, accounts.employeeB);
  const ma = await login(app, accounts.managerA);
  const request = await add(app, a, 8, 'emp-a');
  const result = await approve(app, ma, request);
  assert.equal(result.status, 200);
  checkRequest(result.data.request, { id: request.id, employeeId: 'emp-a', hours: 8, status: 'approved' });
  assert.equal((await get(app, a, request)).status, 'approved');
  await me(app, a, accounts.employeeA, 32);
  await me(app, b, accounts.employeeB);
  await me(app, ma, accounts.managerA);
});

test('14 repeated approval deducts a request only once', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const ma = await login(app, accounts.managerA);
  const request = await add(app, a, 8, 'emp-a');
  assert.equal((await approve(app, ma, request)).status, 200);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await approve(app, ma, request);
    assert.ok(result.status === 200 || result.status === 409);
    if (result.status === 200) checkRequest(result.data.request, { id: request.id, status: 'approved' });
  }
  await me(app, a, accounts.employeeA, 32);
  assert.equal((await get(app, a, request)).status, 'approved');
});

test('15 concurrent approvals cause exactly one deduction', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const ma = await login(app, accounts.managerA);
  const request = await add(app, a, 8, 'emp-a');
  const results = await Promise.all([approve(app, ma, request), approve(app, ma, request)]);
  assert.ok(results.some((result) => result.status === 200));
  for (const result of results) {
    assert.ok(result.status === 200 || result.status === 409);
    if (result.status === 200) checkRequest(result.data.request, { id: request.id, status: 'approved' });
  }
  await me(app, a, accounts.employeeA, 32);
  assert.equal((await get(app, a, request)).status, 'approved');
});

test('16 insufficient balance returns 409 without negative balances or partial changes', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const ma = await login(app, accounts.managerA);
  const created = await call(app, 'POST', '/requests', { token: a, body: { hours: 48 } });
  assert.ok(created.status === 201 || created.status === 409);
  if (created.status === 201) {
    const request = checkRequest(created.data.request, { employeeId: 'emp-a', hours: 48, status: 'pending' });
    assert.equal((await approve(app, ma, request)).status, 409);
    assert.equal((await get(app, a, request)).status, 'pending');
    assert.equal((await list(app, a)).length, 1);
  } else {
    assert.equal((await list(app, a)).length, 0);
  }
  await me(app, a, accounts.employeeA);
});

test('17 requests, approvals, and balances persist after reloading', options, async (t) => {
  const { app, storageFile } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const ma = await login(app, accounts.managerA);
  const pending = await add(app, a, 8, 'emp-a');
  const saved = await stat(storageFile).catch(() => null);
  assert.ok(saved?.isFile() && saved.size > 0,
    'Na de eerste aanvraag moet storageFile als niet-leeg bestand bestaan.');
  const approved = await add(app, a, 16, 'emp-a');
  assert.notEqual(pending.id, approved.id);
  assert.equal((await approve(app, ma, approved)).status, 200);
  const reloaded = await freshWorkerApp(t, storageFile);
  const nextA = await login(reloaded, accounts.employeeA);
  const nextMa = await login(reloaded, accounts.managerA);
  await me(reloaded, nextA, accounts.employeeA, 24);
  assert.equal((await get(reloaded, nextA, pending)).status, 'pending');
  assert.equal((await get(reloaded, nextA, approved)).status, 'approved');
  assert.equal((await list(reloaded, nextA)).length, 2);
  const repeat = await approve(reloaded, nextMa, approved);
  assert.ok(repeat.status === 200 || repeat.status === 409);
  await me(reloaded, nextA, accounts.employeeA, 24);
});

test('18 the phase hours increment works while preserving eight-hour requests', options, async (t) => {
  const { app } = await fixture(t);
  const a = await login(app, accounts.employeeA);
  const ma = await login(app, accounts.managerA);
  const validHours = phase === 'change' ? [4, 12, 8] : [16, 8];
  let expectedBalance = 40;
  const ids = new Set();
  for (const hours of validHours) {
    const request = await add(app, a, hours, 'emp-a');
    assert.ok(!ids.has(request.id));
    ids.add(request.id);
    const result = await approve(app, ma, request);
    assert.equal(result.status, 200);
    checkRequest(result.data.request, { id: request.id, employeeId: 'emp-a', hours, status: 'approved' });
    expectedBalance -= hours;
    await me(app, a, accounts.employeeA, expectedBalance);
  }
  assert.equal((await list(app, a)).length, validHours.length);
});
