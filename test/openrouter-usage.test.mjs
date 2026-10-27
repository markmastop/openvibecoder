import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenRouterUsage } from '../src/models/openrouter-usage.mjs';

test('OpenRouter-gebruik toont gemelde gratis aanvragen en USD, zonder sleutelgegevens door te geven', async () => {
  const value = await fetchOpenRouterUsage('test-geheim', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.equal(options.headers.Authorization, 'Bearer test-geheim'); assert.equal(options.redirect, 'error');
    return Response.json({ data: { free_model_daily_requests: { used: 12, remaining: 38, limit: 50 }, usage_daily: 0, usage: 1.25, limit: null, limit_remaining: null, label: 'test-geheim', creator_user_id: 'niet-delen' } });
  } });
  assert.deepEqual(value.freeRequests, { used: 12, remaining: 38, limit: 50 });
  assert.equal(value.usageUsd.today, 0); assert.equal(value.usageUsd.total, 1.25); assert.equal(value.keyBudget.unlimited, true);
  assert.ok(!JSON.stringify(value).includes('test-geheim')); assert.ok(!JSON.stringify(value).includes('niet-delen'));
});
test("ontbrekende gebruiksvelden blijven unknown; providerfouten lekken geen antwoordtekst", async () => {
  const missing = await fetchOpenRouterUsage('test', { fetchImpl: async () => Response.json({ data: {} }) });
  assert.deepEqual(missing.freeRequests, { used: null, remaining: null, limit: null }); assert.equal(missing.usageUsd.today, null); assert.equal(missing.keyBudget.unlimited, false);
  await assert.rejects(fetchOpenRouterUsage('test', { fetchImpl: async () => new Response('geheime fouttekst', { status: 401 }) }), /rejected this API key/);
  await assert.rejects(fetchOpenRouterUsage('test', { fetchImpl: async () => { throw new Error('sleutel in interne fout'); } }), error => !error.message.includes('sleutel in interne fout'));
});
