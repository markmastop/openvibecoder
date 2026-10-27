'use strict';

// De webuitvoering houdt fetch; de desktopuitvoering gebruikt uitsluitend de vaste Rust-brug.
window.bimDesktop = Boolean(window.__TAURI__?.core?.invoke);
window.bimClientFetch = window.bimDesktop
  ? async (path, options = {}) => {
    let reply;
    try {
      reply = await window.__TAURI__.core.invoke('client_request', {
        request: { path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null },
      });
    } catch (error) {
      throw new Error(typeof error === 'string' ? error : "The desktop connection could not perform the action.");
    }
    return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }
  : window.fetch.bind(window);
