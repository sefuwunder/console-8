// Console-8 — static file server. Bun, zero deps.
const PORT = 3035;
const ROOT = new URL('../', import.meta.url).pathname;

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/public/index.html' : decodeURIComponent(url.pathname);
    // shared src modules are importable by the browser
    if (path.startsWith('/src/') || path.startsWith('/public/')) {
      const file = Bun.file(ROOT + path.slice(1));
      if (await file.exists()) {
        const ext = path.slice(path.lastIndexOf('.'));
        return new Response(file, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream' } });
      }
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`console-8 on http://127.0.0.1:${PORT}`);
