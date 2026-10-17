/** Route extraction: counts, redirects, lazy loading, params, guards. */
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_DIR,
  edges,
  getGraph,
  golden,
  preconditionsOf,
  routeByFullPath,
  routesOf,
} from './helpers';
import { angularAdapter } from '../../src/adapters/angular';

describe('angular adapter: detect', () => {
  it('detects the fixture app via its package.json dependency', async () => {
    await expect(angularAdapter.detect(FIXTURE_DIR)).resolves.toBe(true);
  });

  it('rejects a directory that is not an Angular project', async () => {
    await expect(angularAdapter.detect('/tmp')).resolves.toBe(false);
  });
});

describe('angular adapter: routes', () => {
  it('extracts the exact route count, including lazy and redirect routes', async () => {
    const g = await getGraph();
    const routes = routesOf(g);
    expect(routes).toHaveLength(golden.routes.count);
    expect(routes.map((r) => r.fullPath).sort()).toEqual(golden.routes.fullPaths);
  });

  it('models the root redirect', async () => {
    const g = await getGraph();
    const redirect = routesOf(g).find((r) => r.redirectTo);
    expect(redirect?.fullPath).toBe(golden.routes.redirect.fullPath);
    expect(redirect?.redirectTo).toBe(golden.routes.redirect.redirectTo);
  });

  it('keeps the lazy loadChildren parent and merges its child routes under the prefix', async () => {
    const g = await getGraph();
    const routes = routesOf(g);
    const parent = routes.find((r) => r.fullPath === '/orders' && r.lazy);
    expect(parent).toBeDefined();
    expect(parent?.componentName).toBeUndefined();
    const child = routes.find(
      (r) => r.fullPath === '/orders' && r.componentName === golden.routes.lazyChild.componentName,
    );
    expect(child).toBeDefined();
    expect(child?.confidence).toBe(golden.routes.lazyChild.confidence);
  });

  it('resolves loadComponent lazy routes to the component name', async () => {
    const g = await getGraph();
    const settings = routeByFullPath(g, golden.routes.loadComponent.fullPath);
    expect(settings?.lazy).toBe(true);
    expect(settings?.componentName).toBe(golden.routes.loadComponent.componentName);
  });

  it('records route param names', async () => {
    const g = await getGraph();
    for (const [fullPath, params] of Object.entries(golden.routes.paramNames)) {
      expect(routeByFullPath(g, fullPath)?.paramNames).toEqual(params);
    }
  });

  it('attaches an auth precondition via REQUIRES on every guarded route', async () => {
    const g = await getGraph();
    const pre = preconditionsOf(g).find(
      (p) => p.type === golden.guards.precondition.type && p.detail === golden.guards.precondition.detail,
    );
    expect(pre).toBeDefined();
    const requires = edges(g, 'REQUIRES');
    for (const fullPath of golden.guards.guardedFullPaths) {
      const route = routeByFullPath(g, fullPath);
      expect(route?.guards).toContain(golden.guards.precondition.detail);
      expect(
        requires.some((e) => e.from === route?.id && e.to === pre?.id),
        `REQUIRES edge missing for ${fullPath}`,
      ).toBe(true);
    }
  });

  it('links routes to their components with ROUTE_RENDERS', async () => {
    const g = await getGraph();
    const renders = edges(g, 'ROUTE_RENDERS');
    const login = routeByFullPath(g, '/login');
    const target = g.nodes.find(
      (n) => n.kind === 'component' && 'name' in n && n.name === 'LoginComponent',
    );
    expect(renders.some((e) => e.from === login?.id && e.to === target?.id)).toBe(true);
  });
});
