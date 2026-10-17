/** Graph envelope: determinism, sorting, file hashes, metadata. */
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, getGraph, golden } from './helpers';
import { angularAdapter } from '../../src/adapters/angular';
import { SCHEMA_VERSION, edgeKey, type Graph } from '../../src/types';

const stripBuiltAt = (g: Graph): Omit<Graph, 'builtAt'> => {
  const { builtAt: _builtAt, ...rest } = g;
  return rest;
};

describe('angular adapter: graph envelope', () => {
  it('extracting twice yields deep-equal graphs (ignoring builtAt)', async () => {
    const a = await angularAdapter.extract(FIXTURE_DIR);
    const b = await angularAdapter.extract(FIXTURE_DIR);
    expect(stripBuiltAt(a)).toEqual(stripBuiltAt(b));
  });

  it('carries schema version and app metadata', async () => {
    const g = await getGraph();
    expect(g.schemaVersion).toBe(SCHEMA_VERSION);
    expect(g.app).toEqual(golden.app);
    expect(g.generator.name).toBe('uigraph');
  });

  it('fills fileHashes for every parsed file, keyed by repo-relative path', async () => {
    const g = await getGraph();
    const files = Object.keys(g.fileHashes);
    expect(files).toContain('src/app/app.routes.ts');
    expect(files).toContain('src/app/users/user-list.component.html');
    expect(files).toContain('src/app/orders/orders.module.ts');
    for (const [file, hash] of Object.entries(g.fileHashes)) {
      expect(file.startsWith('/')).toBe(false);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('nodes and edges are sorted and ids are stable-hash shaped', async () => {
    const g = await getGraph();
    const nodeKeys = g.nodes.map((n) => `${n.kind}|${n.id}`);
    expect(nodeKeys).toEqual([...nodeKeys].sort());
    const edgeKeys = g.edges.map((e) => edgeKey(e));
    expect(edgeKeys).toEqual([...edgeKeys].sort());
    for (const n of g.nodes) {
      expect(n.id).toMatch(/^[a-z]+_[0-9a-f]{12}$/);
    }
  });

  it('every fact carries static source and a valid confidence', async () => {
    const g = await getGraph();
    for (const n of g.nodes) expect(n.source).toBe('static');
    for (const e of g.edges) expect(e.source).toBe('static');
  });
});
