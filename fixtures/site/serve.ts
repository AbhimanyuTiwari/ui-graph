/**
 * Tiny static server for the crawl fixture site.
 * - Serves the sibling *.html files over node:http on an ephemeral port.
 * - Stubs /api/*: GET /api/users answers a JSON list; every /api request
 *   (method + path) is recorded in `log` so tests can assert what the
 *   crawler/probes actually sent (e.g. "no DELETE ever happened").
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = dirname(fileURLToPath(import.meta.url));

export interface SiteRequest {
  method: string;
  path: string;
}

export interface FixtureSite {
  url: string;
  close(): Promise<void>;
  /** Every request to /api/*, in arrival order. */
  log: SiteRequest[];
}

export async function startSite(): Promise<FixtureSite> {
  const log: SiteRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://fixture.local');
      const path = u.pathname;

      if (path.startsWith('/api/')) {
        log.push({ method: req.method ?? 'GET', path });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.method === 'GET' && path === '/api/users') {
          res.end(
            JSON.stringify([
              { id: 1, name: 'Alice Anderson' },
              { id: 2, name: 'Bob Brown' },
              { id: 3, name: 'Cara Chen' },
            ]),
          );
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }

      const file = path === '/' ? '/index.html' : path;
      if (file.includes('..') || !file.endsWith('.html')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      try {
        const body = await readFile(join(siteDir, '.' + file));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('fixture server has no bound port');
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    log,
  };
}
