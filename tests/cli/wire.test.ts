/**
 * Integration: the CLI service container reaches the real modules, not the
 * "not wired yet" stubs left while the builders were still running.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServices } from '../../src/cli/wire';
import { angularAdapter } from '../../src/adapters/angular';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createServices wiring', () => {
  it('binds the angular adapter, merge, and crawl, and refuses queries before a build', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uigraph-wire-'));
    dirs.push(dir);
    const services = await createServices(dir);
    expect(services.adapters.angular).toBe(angularAdapter);
    expect(services.adapters.next?.name).toBe('next');
    expect(typeof services.merge).toBe('function');
    expect(typeof services.crawl).toBe('function');
    expect(() => services.query.getScreen('/users')).toThrow(/no graph loaded/);
  });
});
