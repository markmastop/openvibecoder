export const isFreeModelId = id => typeof id === 'string' && /^[a-zA-Z0-9][\w.-]*\/[\w.:-]+:free$/.test(id);
export function isFreeTextModel(model) {
  const prices = model?.pricing;
  return isFreeModelId(model?.id) && prices && Object.hasOwn(prices, 'prompt') && Object.hasOwn(prices, 'completion')
    && Object.values(prices).every(value => ['string', 'number'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) === 0)
    && (!model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'));
}
export async function fetchFreeModels({ fetchImpl = fetch } = {}) {
  let response;
  try { response = await fetchImpl('https://openrouter.ai/api/v1/models', { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error("The OpenRouter model catalogue is unavailable. Try again."); }
  if (!response.ok) throw new Error("The OpenRouter model catalogue is unavailable. Try again.");
  let data;
  try { data = (await response.json()).data; } catch {}
  if (!Array.isArray(data)) throw new Error("OpenRouter returned an invalid model catalogue.");
  const models = data.filter(isFreeTextModel).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  if (!models.length) throw new Error("OpenRouter currently offers no verifiably free text models.");
  return models;
}
export function publicModel(model) {
  const context = Number.isSafeInteger(model.context_length) ? model.context_length : null;
  return {
    id: model.id, label: `${model.name || model.id} · free`,
    contextLength: context,
    use: context ? `${context.toLocaleString('en-GB')} context tokens` : "Generate text and code",
    example: "Build an app from my description.",
    note: "Free according to the current OpenRouter catalogue. Availability and quality vary by model.",
  };
}
