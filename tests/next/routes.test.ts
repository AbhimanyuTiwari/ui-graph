import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextAdapter } from '../../src/adapters/next';
import type { ActionNode, ElementNode, RouteNode } from '../../src/types';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/next-app');

describe('next adapter', () => {
  it('detects a Next.js project and rejects anything else', async () => {
    await expect(nextAdapter.detect(FIXTURE)).resolves.toBe(true);
    await expect(nextAdapter.detect('/tmp')).resolves.toBe(false);
  });

  it('extracts app-router routes, including a dynamic segment', async () => {
    const graph = await nextAdapter.extract(FIXTURE);
    const routes = graph.nodes
      .filter((n): n is RouteNode => n.kind === 'route')
      .map((r) => r.fullPath)
      .sort();
    expect(routes).toEqual(['/', '/about', '/users', '/users/:id']);
    expect(graph.nodes.find((n): n is RouteNode => n.kind === 'route' && n.fullPath === '/users/:id')?.paramNames).toEqual(['id']);
    expect(graph.app).toEqual({ name: 'next-fixture-app', framework: 'next' });
  });

  it('records links, labels, and a destructive button', async () => {
    const graph = await nextAdapter.extract(FIXTURE);
    const alice = graph.nodes.find((n): n is ElementNode => n.kind === 'element' && n.name === 'Alice');
    expect(alice?.role).toBe('link');
    expect(alice?.attrs?.href).toBe('/users/1');
    const email = graph.nodes.find((n): n is ElementNode => n.kind === 'element' && n.attrs?.name === 'email');
    expect(email?.locator.strategy).toBe('label');
    const del = graph.nodes.find((n): n is ActionNode => n.kind === 'action' && n.handler === 'Delete user');
    expect(del?.safety).toBe('destructive');
  });

  it('is deterministic aside from builtAt', async () => {
    const a = await nextAdapter.extract(FIXTURE);
    const b = await nextAdapter.extract(FIXTURE);
    const strip = (g: typeof a) => {
      const { builtAt: _builtAt, ...rest } = g;
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
  });
});
