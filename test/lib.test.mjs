import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from './../src/config/config.mjs';
import { redact } from './../src/config/redact.mjs';
import { estimateNeurons, modelRequest, measureUsage, selectModel } from './../src/models/providers.mjs';
import { cleanEnvironment, sandboxProfile } from './../src/execution/sandbox.mjs';
import { assistantMessageForHistory, parseToolArguments } from './../src/parsing/tool-arguments.mjs';
import { acceptancePassed } from './../src/execution/acceptance.mjs';

test('lokale configuratie is data en voert geen shellcode uit', () => {
  assert.deepEqual(parseEnv('# comment\nKEY="abc"\nVALUE=$(whoami)\n'), { KEY: 'abc', VALUE: '$(whoami)' });
  assert.throws(() => parseEnv('ongeldige regel'));
});
test('API-sleutels worden uit fout- en logtekst verwijderd', () => {
  assert.equal(redact({ error: 'token geheim-token geheim-token' }, ['geheim-token']), '{"error":"token [REDACTED] [REDACTED]"}');
});
test('modelcode erft geen provider- of andere geheime omgevingsvariabelen', () => {
  assert.deepEqual(cleanEnvironment({ PATH: '/bin', LANG: 'nl', CLOUDFLARE_API_TOKEN: 'secret', OTHER_SECRET: 'other' }), { PATH: '/bin', LANG: 'nl' });
});
test('neuronschatting gebruikt de vastgelegde modeltarieven en markeert ontbrekende metingen', () => {
  assert.equal(estimateNeurons('@cf/qwen/qwen3-30b-a3b-fp8', { prompt_tokens: 20000, completion_tokens: 2000 }), 153.45);
  assert.equal(estimateNeurons('@cf/zai-org/glm-4.7-flash', { prompt_tokens: 20000, completion_tokens: 2000 }), 182.8);
  assert.equal(estimateNeurons('@cf/qwen/qwen3-30b-a3b-fp8', {}), null);
  assert.throws(() => estimateNeurons('ander-model', {}));
});
test('alleen bekende appgereedschappen en begrensde broncode worden geaccepteerd', () => {
  assert.deepEqual(parseToolArguments({ function: { name: 'write_app', arguments: '{"source":"export const x = 1;"}' } }), { source: 'export const x = 1;' });
  assert.throws(() => parseToolArguments({ function: { name: 'shell', arguments: '{}' } }));
  assert.throws(() => parseToolArguments({ function: { name: 'write_app', arguments: '{"source":""}' } }));
});
test('uitvoerprofiel opent alleen de proefmappen en bevat geen netwerktoestemming', () => {
  const profile = sandboxProfile({ runDir: '/tmp/proef', nodeDir: '/node', appDir: '/tmp/proef/app', stateDir: '/tmp/proef/state' });
  assert.match(profile, /deny default/);
  assert.doesNotMatch(profile, /allow network/);
  assert.match(profile, /file-write\* \(subpath "\/tmp\/proef\/app"\) \(subpath "\/tmp\/proef\/state"\)/);
  assert.doesNotMatch(profile, /allow process\*/);
});
test('exitcode nul zonder de achttien echte tests telt niet als geslaagde proef', () => {
  const names = Array.from({ length: 18 }, (_, i) => `test-${i}`);
  assert.equal(acceptancePassed({ passed: true, output: 'ok 1 - acceptance.mjs\n# tests 1\n# pass 1\n# fail 0\n' }, names), false);
  const output = names.map((name, i) => `ok ${i + 1} - ${name}`).join('\n') + '\n# tests 18\n# pass 18\n# fail 0\n# cancelled 0\n# skipped 0\n';
  assert.equal(acceptancePassed({ passed: true, output }, names), true);
  assert.equal(acceptancePassed({ passed: true, output: output.replace('# skipped 0', '# skipped 1') }, names), false);
});
test('OpenRouter begrenst de router en het vaste gratis codemodel op nulkosten', () => {
  const request = modelRequest({ provider: 'openrouter', token: 'fake-token' }, { messages: [], tools: [], maxTokens: 8192, temperature: 0.6 });
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.body.model, 'openrouter/free');
  assert.deepEqual(request.body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  const fixed = modelRequest({ provider: 'openrouter', token: 'fake-token' }, { model: 'cohere/north-mini-code:free', messages: [], tools: [], maxTokens: 8192, temperature: 0.6 });
  assert.equal(fixed.body.model, 'cohere/north-mini-code:free');
  assert.deepEqual(fixed.body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  assert.deepEqual(fixed.body.reasoning, { enabled: false });
  assert.equal(request.body.reasoning, undefined);
  assert.equal(estimateNeurons('cohere/north-mini-code:free', {}), null);
  assert.throws(() => selectModel('openrouter', 'cohere/north-mini-code'));
  assert.throws(() => selectModel('openrouter', 'betaald/model'));
  assert.throws(() => selectModel('cloudflare', 'openrouter/free'));
});
test('OpenRouter-gebruik vereist gemelde nulkosten en claimt geen Cloudflare-neurons', () => {
  assert.deepEqual(measureUsage('openrouter', 'openrouter/free', { prompt_tokens: 100, completion_tokens: 20, cost: 0 }), { estimatedNeurons: null, reportedCostUsd: 0 });
  assert.throws(() => measureUsage('openrouter', 'openrouter/free', { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 }));
  assert.throws(() => measureUsage('openrouter', 'openrouter/free', { prompt_tokens: 100, completion_tokens: 20 }));
});

test('een toolvervolgaanroep behoudt reasoning en ondertekende reasoning_details ongewijzigd', () => {
  const toolCalls = [{ id: 'fixture-call', type: 'function', function: { name: 'read_app', arguments: '{}' } }];
  const details = [{ type: 'reasoning.encrypted', data: 'fixture-encrypted', id: 'fixture-detail', format: 'fixture-format', signature: 'fixture-signature' }];
  const message = { content: null, tool_calls: toolCalls, reasoning: 'fixture-reasoning', reasoning_details: details };
  const request = modelRequest({ provider: 'openrouter', token: 'fake-token' }, {
    messages: [assistantMessageForHistory(message), { role: 'tool', tool_call_id: 'fixture-call', content: 'app.mjs bestaat nog niet' }],
    tools: [], maxTokens: 8192, temperature: 0.6,
  });
  assert.equal(request.body.messages[0].reasoning, message.reasoning);
  assert.equal(request.body.messages[0].reasoning_details, details);
  assert.equal(request.body.messages[0].tool_calls, toolCalls);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)).messages[0], { role: 'assistant', ...message });
  assert.deepEqual(assistantMessageForHistory({ content: 'klaar' }), { role: 'assistant', content: 'klaar' });
});
