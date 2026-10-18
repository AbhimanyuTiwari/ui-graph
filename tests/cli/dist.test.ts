/**
 * The published bin is the compiled output, which must itself run under Node
 * ESM (extensionless relative imports compile fine and then fail at runtime).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(root, 'dist/cli/index.js');
const work = mkdtempSync(path.join(tmpdir(), 'uigraph-dist-'));

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!existsSync(bin))('built CLI (run `npm run build` first)', () => {
  it('builds and queries a project from dist/', () => {
    const run = (...args: string[]): string =>
      execFileSync('node', [bin, ...args], { cwd: work, encoding: 'utf8' });
    const out = run('build', path.join(root, 'fixtures/angular-ngmodule-app'));
    expect(out).toMatch(/built \d+ nodes \/ \d+ edges \(8 routes\)/);
    expect(run('screen', '/reports/sales')).toMatch(/Run report/);
  });
});
