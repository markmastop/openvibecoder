export function assistantMessageForHistory(message) {
  const history = { role: 'assistant', content: message.content ?? null };
  for (const field of ['tool_calls', 'reasoning', 'reasoning_details']) {
    if (Object.hasOwn(message, field)) history[field] = message[field];
  }
  return history;
}

export function parseToolArguments(call) {
  if (!['read_app', 'write_app'].includes(call?.function?.name)) throw new Error("Unknown tool.");
  const args = JSON.parse(call.function.arguments || '{}');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
  if (call.function.name === 'write_app' && (typeof args.source !== 'string' || !args.source.trim() || args.source.length > 80_000)) throw new Error("write_app requires non-empty source code of at most 80,000 characters.");
  return args;
}
