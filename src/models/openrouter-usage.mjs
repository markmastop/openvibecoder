const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
export async function fetchOpenRouterUsage(token, { fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("Could not retrieve OpenRouter usage. Try again later."); }
  if (!response.ok) throw new Error(response.status === 401 ? "OpenRouter rejected this API key. Check the model settings." : `OpenRouter usage is temporarily unavailable (HTTP ${response.status}).`);
  let data;
  try { data = (await response.json()).data; } catch {}
  if (!data || typeof data !== 'object') throw new Error("OpenRouter returned invalid usage data.");
  const free = data.free_model_daily_requests || {};
  const now = new Date();
  return {
    checkedAt: now.toISOString(),
    freeRequests: { used: count(free.used), remaining: count(free.remaining), limit: count(free.limit) },
    usageUsd: { today: amount(data.usage_daily), week: amount(data.usage_weekly), month: amount(data.usage_monthly), total: amount(data.usage) },
    keyBudget: { limit: amount(data.limit), unlimited: data.limit === null, remaining: amount(data.limit_remaining), reset: typeof data.limit_reset === 'string' ? data.limit_reset : null },
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    dailyResetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
  };
}
