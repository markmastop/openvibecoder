export const MODELS = Object.freeze({
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/zai-org/glm-4.7-flash': { input: 5500, output: 36400 },
});
export const DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export const OPENROUTER_CODE_MODEL = 'cohere/north-mini-code:free';
export const MODEL_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({ label: 'OpenRouter Free', defaultModel: OPENROUTER_FREE_MODEL, models: Object.freeze([OPENROUTER_FREE_MODEL, OPENROUTER_CODE_MODEL]) }),
  cloudflare: Object.freeze({ label: 'Cloudflare Workers AI', defaultModel: DEFAULT_MODEL, models: Object.freeze(Object.keys(MODELS)) }),
});

export function selectModel(provider, requestedModel) {
  if (!Object.hasOwn(MODEL_PROVIDERS, provider)) throw new Error("Choose MODEL_PROVIDER=openrouter or MODEL_PROVIDER=cloudflare.");
  const profile = MODEL_PROVIDERS[provider];
  const model = requestedModel ?? profile.defaultModel;
  if (!profile.models.includes(model)) throw new Error("This model is not allowed by the provider's free experiment profile.");
  return model;
}

export function modelRequest(config, { model, messages, tools, maxTokens, temperature }) {
  const selectedModel = selectModel(config.provider, model);
  const body = { model: selectedModel, messages, tools, max_tokens: maxTokens, temperature, stream: false };
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  if (config.provider === 'openrouter') {
    // Alleen de vaste gratis profielen, zonder betaalde model-fallback of servergereedschappen.
    body.provider = { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } };
    if (selectedModel === OPENROUTER_CODE_MODEL) body.reasoning = { enabled: false };
    headers['X-OpenRouter-Title'] = 'Open Vibe Coder';
    return { url: 'https://openrouter.ai/api/v1/chat/completions', headers, body };
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/chat/completions`, headers, body };
}

export function estimateNeurons(model, usage) {
  if (MODEL_PROVIDERS.openrouter.models.includes(model)) return null;
  if (!MODELS[model]) throw new Error("This model is not included in the free experiment profile.");
  if (!validTokenUsage(usage)) return null;
  return (usage.prompt_tokens * MODELS[model].input + usage.completion_tokens * MODELS[model].output) / 1_000_000;
}

const validTokenUsage = usage => Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0
  && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;

export function measureUsage(provider, model, usage) {
  selectModel(provider, model);
  if (!validTokenUsage(usage)) throw new Error("The response does not contain measurable token usage. Execution stops to avoid untracked consumption.");
  if (provider === 'openrouter') {
    if (!Number.isFinite(usage.cost) || usage.cost < 0) throw new Error("OpenRouter did not report verifiable costs. Execution stops; check your account dashboard.");
    if (usage.cost > 0) throw new Error("OpenRouter reported a cost above zero. Execution stops; check your account dashboard.");
    return { estimatedNeurons: null, reportedCostUsd: usage.cost };
  }
  return { estimatedNeurons: estimateNeurons(model, usage), reportedCostUsd: null };
}
