// Compiler diagnostics only: never execute log content or expose absolute paths.
export function buildFeedback(log = '', fallback = "The build failed.") {
  const clean = String(log).replace(/\x1b\[[0-9;]*m/g, '').slice(-20_000);
  const match = clean.match(/^(.+?):(\d+):(\d+):\s*(?:ERROR:\s*)?([^\n]+)/m);
  const candidate = match?.[1].replaceAll('\\', '/');
  const file = candidate?.match(/(?:^|\/)((?:src\/|index\.html|vite\.config\.)[^:\n]*)$/)?.[1] || null;
  const message = (match?.[4] || clean.match(/(?:ERROR:|Error:)\s*([^\n]+)/)?.[1] || fallback).slice(0, 600);
  const line = file ? Number(match[2]) : null;
  const column = file ? Number(match[3]) : null;
  const duplicate = message.match(/(?:symbol|identifier) ["']([^"']+)["'] (?:has already been declared|is already declared)/i);
  const explanation = duplicate ? `“${duplicate[1]}” is defined more than once. Remove the duplicate definition.` : /Expected .+ but found/i.test(message) ? "The code contains a syntax error, such as a mismatched quote." : "The compiler cannot build the current code. Check the build log for details.";
  return { message, explanation, file, line, column, log: clean,
    repairPrompt: `Fix only the current build error${file ? ` in ${file}, line ${line}` : ''}: ${JSON.stringify(message)}. Use the supplied build feedback. Preserve working features and styling. Do not add functionality. Check for duplicate definitions and syntax errors.` };
}

// Read only public error metadata, never model reasoning or request credentials.
export function providerFailure(data, httpStatus = 200) {
  const choice = data?.choices?.[0];
  const error = data?.error || choice?.error;
  if (httpStatus < 400 && !error && choice?.finish_reason !== 'error') return null;
  const code = error?.code ? String(error.code) : httpStatus >= 400 ? String(httpStatus) : null;
  const provider = String(data?.provider || 'OpenRouter').slice(0, 80);
  const message = String(error?.message || "The model provider could not return a response.").slice(0, 600);
  return { kind: 'provider', code, provider, message, type: String(error?.metadata?.error_type || '').slice(0, 100) };
}

export function requestFeedback(failure, prompt) {
  if(failure.step==='planning') return {kind:failure.kind,title:"Planning could not produce a usable build plan",explanation:"Preparation stopped. The builder did not start; no new code was saved or built.",message:failure.message,log:failure.message,action:'retry',retryPrompt:prompt};
  const provider = failure.kind === 'provider';
  if (failure.kind === 'execution') return { kind: 'execution', title: "Open Vibe Coder could not complete the request", explanation: failure.message, message: failure.message, log: failure.message, action: 'retry', retryPrompt: prompt };
  return { kind: failure.kind, title: provider ? "The model provider returned an error" : "The model response could not be processed",
    explanation: provider ? `${failure.provider || "The provider"} could not complete the request${failure.code ? ` (code ${failure.code})` : ''}. No new code was built. The previous working app remains available, if one exists.` : "Open Vibe Coder could not safely process the generated code. Your existing app was preserved; no new build was run.",
    message: failure.message, log: [failure.message, failure.type].filter(Boolean).join('\n'),
    action: 'retry', retryPrompt: prompt };
}
