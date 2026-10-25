// Loopback-only static host for the headless render page. It serves the app's
// own modules (src/, assets/, vendor/) and mcp/render/, nothing else.
import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm'};
const ROOTS = ['src', 'assets', 'vendor', path.join('mcp', 'render')];

export async function startStaticServer(appRoot) {
  const roots = ROOTS.map(root => path.resolve(appRoot, root));
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const target = path.resolve(appRoot, '.' + pathname);
      const type = TYPES[path.extname(target).toLowerCase()];
      if (!type || !roots.some(root => target.startsWith(root + path.sep)) || !(await stat(target)).isFile()) throw new Error('not found');
      response.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-cache'});
      response.end(await readFile(target));
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve))};
}
