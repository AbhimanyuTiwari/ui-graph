import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportGraph } from '../../src/core/export';
import { buildFixtureGraph } from '../core/fixture';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('graphify-style export', () => {
  it('writes graph.json, a report, and HTML with EXTRACTED and INFERRED tags', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uigraph-export-'));
    dirs.push(dir);
    const graph = buildFixtureGraph();
    const written = exportGraph(graph, dir);
    const json = JSON.parse(readFileSync(written.graphJson, 'utf8')) as { nodes: unknown[]; edges: unknown[] };
    expect(json.nodes).toHaveLength(graph.nodes.length);
    expect(json.edges).toHaveLength(graph.edges.length);
    const report = readFileSync(written.report, 'utf8');
    expect(report).toContain('EXTRACTED');
    expect(report).toContain('INFERRED');
    const html = readFileSync(written.html, 'utf8');
    expect(html).toContain('EXTRACTED');
    expect(html).toContain('/users');
    expect(html).not.toContain('<script');
  });
});
