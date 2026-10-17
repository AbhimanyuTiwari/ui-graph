import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGraph, routeSlug, saveGraph } from '../../src/core/store';
import { edgeKey } from '../../src/types';
import type { Graph } from '../../src/types';
import { buildFixtureGraph, ids } from './fixture';

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function sortedCopy(g: Graph): Graph {
  return {
    ...g,
    nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...g.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

describe('routeSlug', () => {
  it("maps '/' to '_', strips ':', and '' to 'root'", () => {
    expect(routeSlug('/users/:id')).toBe('_users_id');
    expect(routeSlug('/login')).toBe('_login');
    expect(routeSlug('')).toBe('root');
  });
});

describe('store', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'uigraph-store-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'uigraph-store-b-'));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('round-trips the graph exactly (modulo canonical sort order)', () => {
    const g = buildFixtureGraph();
    saveGraph(dirA, g);
    expect(loadGraph(dirA)).toEqual(sortedCopy(g));
  });

  it('writes one file per route plus index.json and shared.json', () => {
    saveGraph(dirA, buildFixtureGraph());
    expect(listFiles(dirA)).toEqual([
      'index.json',
      'routes/_login.json',
      'routes/_users.json',
      'routes/_users_id.json',
      'shared.json',
    ]);
  });

  it('is byte-deterministic: saving twice yields identical bytes', () => {
    saveGraph(dirA, buildFixtureGraph());
    saveGraph(dirB, buildFixtureGraph());
    const files = listFiles(dirA);
    expect(listFiles(dirB)).toEqual(files);
    for (const f of files) {
      expect(readFileSync(join(dirB, f), 'utf8')).toBe(readFileSync(join(dirA, f), 'utf8'));
    }
  });

  it('is byte-deterministic regardless of input node/edge order', () => {
    const g = buildFixtureGraph();
    const shuffled: Graph = {
      ...g,
      nodes: [...g.nodes].reverse(),
      edges: [...g.edges].reverse(),
    };
    saveGraph(dirA, g);
    saveGraph(dirB, shuffled);
    for (const f of listFiles(dirA)) {
      expect(readFileSync(join(dirB, f), 'utf8')).toBe(readFileSync(join(dirA, f), 'utf8'));
    }
  });

  it('keeps builtAt out of route and shared files (only index.json changes)', () => {
    const g = buildFixtureGraph();
    saveGraph(dirA, g);
    saveGraph(dirB, { ...g, builtAt: '2027-01-01T00:00:00.000Z' });
    for (const f of listFiles(dirA)) {
      const a = readFileSync(join(dirA, f), 'utf8');
      const b = readFileSync(join(dirB, f), 'utf8');
      if (f === 'index.json') expect(a).not.toBe(b);
      else {
        expect(a).toBe(b);
        expect(a).not.toContain('builtAt');
      }
    }
    expect(loadGraph(dirB).builtAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('assigns owned nodes to their route file and the rest to shared.json', () => {
    const g = buildFixtureGraph();
    // An api node nothing reaches via CONTAINS/TRIGGERS -> shared.
    g.nodes.push({
      id: 'api_000000000001',
      kind: 'api',
      method: 'GET',
      urlPattern: '/api/health',
      confidence: 'extracted',
      source: 'static',
    });
    saveGraph(dirA, g);

    const users = JSON.parse(readFileSync(join(dirA, 'routes/_users.json'), 'utf8')) as {
      nodes: Array<{ id: string }>;
    };
    const usersIds = users.nodes.map((n) => n.id);
    // Route, its screens, their elements, and triggered actions all live with /users.
    for (const id of [ids.rUsers, ids.sUsers, ids.sFilters, ids.sConfirm, ids.eAlice, ids.eDelete, ids.eApply, ids.aDelete, ids.aOpenFilters]) {
      expect(usersIds).toContain(id);
    }
    const shared = JSON.parse(readFileSync(join(dirA, 'shared.json'), 'utf8')) as {
      nodes: Array<{ id: string }>;
    };
    const sharedIds = shared.nodes.map((n) => n.id);
    expect(sharedIds).toContain('api_000000000001');
    expect(sharedIds).toContain(ids.pAuth); // precondition is not CONTAINS/TRIGGERS-reachable
    expect(sharedIds).not.toContain(ids.rUsers);
  });

  it('cleans stale route files from a previous save', () => {
    const g = buildFixtureGraph();
    saveGraph(dirA, g);
    const smaller: Graph = {
      ...g,
      nodes: g.nodes.filter((n) => n.id !== ids.rDetail && n.id !== ids.sDetail),
      edges: g.edges.filter((e) => e.from !== ids.rDetail && e.to !== ids.sDetail),
    };
    saveGraph(dirA, smaller);
    expect(listFiles(dirA)).not.toContain('routes/_users_id.json');
    expect(loadGraph(dirA)).toEqual(sortedCopy(smaller));
  });
});
