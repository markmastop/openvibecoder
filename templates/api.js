export function isApiConfigured() { return Boolean(import.meta.env.VITE_API_BASE_URL); }

export async function apiRequest(path, { method = 'GET', body, headers = {}, token, signal, timeoutMs = 15000 } = {}) {
  if (!isApiConfigured()) throw new Error("Set the API base URL in Connections in Open Vibe Coder first.");
  if (typeof path !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) throw new Error("Use a relative API path.");
  const base = new URL(import.meta.env.VITE_API_BASE_URL.replace(/\/?$/, '/'));
  const url = new URL(path.replace(/^\//, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("The API path is outside the configured base URL.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { const error = new Error(`API request failed (HTTP ${response.status}).`); error.status = response.status; throw error; }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    if (response.headers.get('content-type')?.includes('json')) { try { return JSON.parse(text); } catch { throw new Error("The API returned invalid JSON."); } }
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? "API request cancelled." : "The API did not respond in time.");
    if (error instanceof TypeError) throw new Error("API unreachable. Check the URL, connection, and CORS settings.");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const api = {
  get: (path, options) => apiRequest(path, options),
  post: (path, body, options) => apiRequest(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => apiRequest(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => apiRequest(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => apiRequest(path, { ...options, method: 'DELETE' }),
};
