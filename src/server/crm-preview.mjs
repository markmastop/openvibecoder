import http from 'node:http';
import { watchedPreview } from './preview-watch.mjs';
import { randomUUID } from 'node:crypto';

// Separate origin: generated code never shares the Studio API or desktop bridge.
export function createPreviewService(loadHtml, { parentOrigins = () => [], getState = async () => null } = {}) {
  const pages = new Map();
  let server;
  let starting;
  return {
    async open(id) {
      await loadHtml(id);
      if (!server) {
        server = http.createServer(async (req, res) => {
          const host = `127.0.0.1:${server.address().port}`;
          const pathname = new URL(req.url, 'http://localhost').pathname;
          const route = [...pages].find(([path]) => pathname.startsWith(path.replace('index.html', '')));
          const id = route?.[1];
          const asset = route ? pathname.slice(route[0].lastIndexOf('/') + 1) : '';
          if (asset === '__studio_status.json' && req.headers.host === host && req.method === 'GET' && id) {
            try { const state = await getState(id); if (!state) throw new Error(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(state)); } catch { res.writeHead(404); res.end(); }
            return;
          }
          if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+\.(js|css))$/.test(asset)) { res.writeHead(404); res.end(); return; }
          if (req.headers.host !== host || req.method !== 'GET' || !id) { res.writeHead(404); res.end(); return; }
          try {
            const state = asset === 'index.html' ? await getState(id) : null;
            let loaded;
            try { loaded = await loadHtml(id, asset); } catch (error) {
              if (!state || (!state.building && !state.failed)) throw error;
              loaded = { content: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>App-preview · Open Vibe Coder</title></head><body></body></html>', allowEmbed: true, allowHttps: true };
            }
            const source = typeof loaded === 'string' ? loaded : loaded.content;
            const html = state ? watchedPreview(source, state) : source;
            const ancestors = loaded.allowEmbed ? parentOrigins().join(' ') || "'none'" : "'none'";
            const type = asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html';
            res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'".replace('connect-src https:;', loaded.allowHttps ? "connect-src 'self' https: wss:;" : 'connect-src https://crm-api.trimedixs.nl;').replace("frame-ancestors 'none'", `frame-ancestors ${ancestors}`) });
            res.end(html);
          } catch { res.writeHead(404); res.end(); }
        });
        starting = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      }
      await starting;
      let path = [...pages].find(([, value]) => value === id)?.[0];
      if (!path) { path = `/${randomUUID()}/index.html`; pages.set(path, id); }
      return `http://127.0.0.1:${server.address().port}${path}`;
    },
    close() { server?.close(); server?.closeAllConnections(); },
  };
}
