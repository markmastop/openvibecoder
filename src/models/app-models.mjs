import { fetchFreeModels, isFreeModelId } from './openrouter-catalog.mjs';
export const DEFAULT_APP_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
// Preferences only: availability and zero prices are always checked against the live catalogue.
export const APP_MODELS = Object.freeze([
  { id: 'cohere/north-mini-code:free', label: "North Mini Code · free" },
  { id: 'poolside/laguna-xs-2.1:free', label: "Laguna XS 2.1 · free" },
  { id: 'poolside/laguna-s-2.1:free', label: "Laguna S 2.1 · free" },
  { id: DEFAULT_APP_MODEL, label: "Nemotron 3 Super · free" },
]);
export function appPlan({ prompt = '', mode = 'improve', changeSize = 'auto', modelId = 'auto' } = {}) {
  if (!['auto', 'small', 'large'].includes(changeSize)) throw new Error("Choose automatic, small, or large change.");
  const large = mode === 'create' || prompt.length > 1500 || /(?:(?:nieuw(?:e)?|new)\s+(?:scherm|screen|module|pagina|page|app)|(?:voeg|bouw|maak|add|build|create).{0,55}(?:scherm|screen|page|module|dashboard)|(?:meerdere|multiple)\s+(?:schermen|bestanden|screens|files)|architectuur|architecture|refactor)/is.test(prompt);
  const size = changeSize === 'auto' ? (large ? 'large' : 'small') : changeSize;
  // New projects always need a complete first app, even with a small-model override.
  const format = mode === 'create' || size === 'large' ? 'files' : 'edits';
  const chosen = modelId === 'auto' || modelId === undefined ? DEFAULT_APP_MODEL : modelId;
  if (!isFreeModelId(chosen)) throw new Error("Choose a model from the free model list.");
  const separateScreens = format === 'files' && (mode === 'create' || /scherm|screen|pagina|page|dashboard|refactor|opsplits|split/i.test(prompt));
  return { size, format, separateScreens, model: chosen, automaticModel: !modelId || modelId === 'auto', reason: changeSize === 'auto' ? (size === 'small' ? "Focused follow-up request: targeted patch." : "New project, new screen, or broader change.") : "Scope selected by you.", maxTokens: format === 'edits' ? 4000 : 16000, contextLimit: size === 'small' ? 18000 : 65000, timeoutMs: size === 'small' ? 120000 : 240000 };
}
export async function checkFreeAppModel(id, { fetchImpl = fetch } = {}) {
  if (id !== 'auto' && !isFreeModelId(id)) throw new Error("Choose a free OpenRouter model.");
  const models = await fetchFreeModels({ fetchImpl });
  const model = id === 'auto'
    ? models.find(m => m.id === DEFAULT_APP_MODEL) || APP_MODELS.map(preferred => models.find(m => m.id === preferred.id)).find(Boolean) || models[0]
    : models.find(m => m.id === id);
  if (!model) throw new Error("This model is no longer verifiably free. Choose another free model; no AI request was made.");
  return model;
}
