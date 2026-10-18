/**
 * NgModule-style apps: code outside src/, inline RouterModule.forRoot routes,
 * lazy modules that import a routing module, and routes imported from a sibling file.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { angularAdapter } from '../../src/adapters/angular';
import { makeQueryApi } from '../../src/core/query';
import { routeByFullPath, routesOf } from './helpers';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/angular-ngmodule-app');

describe('angular adapter: NgModule app without src/', () => {
  it('finds forRoot routes and follows lazy modules into their routing modules', async () => {
    const warnings: string[] = [];
    const g = await angularAdapter.extract(DIR, { onWarning: (m) => warnings.push(m) });
    expect(warnings.filter((w) => !w.includes('/missing'))).toEqual([]);
    expect(routesOf(g).map((r) => r.fullPath).sort()).toEqual([
      '/',
      '/missing',
      '/orders',
      '/orders',
      '/orders/:orderId',
      '/reports',
      '/reports/sales',
      '/reports/sales',
    ]);
    expect(routeByFullPath(g, '/orders/:orderId')?.componentName).toBe('OrderListComponent');
    expect(routeByFullPath(g, '/orders')?.guards).toEqual(['AuthGuard']);
  });

  it('reports an unresolvable lazy import instead of dropping it silently', async () => {
    const warnings: string[] = [];
    await angularAdapter.extract(DIR, { onWarning: (m) => warnings.push(m) });
    expect(warnings.join('\n')).toMatch(/lazy route "\/missing".*@alias\/not\/here/);
  });

  it('honours an explicit --src and reports when nothing matches', async () => {
    const warnings: string[] = [];
    const g = await angularAdapter.extract(DIR, { src: ['nowhere'], onWarning: (m) => warnings.push(m) });
    expect(routesOf(g)).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/no TypeScript sources matched.*nowhere/);
    const glob = await angularAdapter.extract(DIR, { src: ['app/**/*.ts'] });
    expect(routesOf(glob)).toHaveLength(8);
  });

  it('warns when route arrays exist but none is an entry point', async () => {
    const warnings: string[] = [];
    const g = await angularAdapter.extract(DIR, { src: ['app/orders'], onWarning: (m) => warnings.push(m) });
    expect(routesOf(g)).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/no root.*orders-routing\.module\.ts/);
  });

  it('keeps a layout route and its empty-path child apart so the screen resolves', async () => {
    const g = await angularAdapter.extract(DIR);
    const screen = makeQueryApi(g).getScreen('/reports/sales');
    expect(screen?.elements.map((e) => e.name)).toContain('Run report');
  });
});
