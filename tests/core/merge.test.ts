import { describe, expect, it } from 'vitest';
import { mergeGraphs } from '../../src/core/merge';
import { SCHEMA_VERSION } from '../../src/types';
import type { Confidence, ElementNode, FactSource, Graph, GraphEdge, GraphNode } from '../../src/types';

function graph(partial: Partial<Graph>): Graph {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'uigraph', version: '0.1.0' },
    app: { name: 'app', framework: 'angular' },
    builtAt: '2026-10-17T00:00:00.000Z',
    fileHashes: {},
    nodes: [],
    edges: [],
    ...partial,
  };
}

function el(
  id: string,
  confidence: Confidence,
  source: FactSource,
  extra: Partial<ElementNode> = {},
): ElementNode {
  return {
    id,
    kind: 'element',
    locator: { strategy: 'role', role: 'button', name: 'Save' },
    confidence,
    source,
    ...extra,
  };
}

function findNode(g: Graph, id: string): GraphNode {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} missing`);
  return n;
}

describe('mergeGraphs node confidence', () => {
  it('promotes extracted + observed to verified with source both', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'extracted', 'static')] }),
      graph({ nodes: [el('element_a', 'observed', 'runtime')] }),
    );
    const n = findNode(merged, 'element_a');
    expect(n.confidence).toBe('verified');
    expect(n.source).toBe('both');
  });

  it('promotes inferred + observed to verified', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'inferred', 'static')] }),
      graph({ nodes: [el('element_a', 'observed', 'runtime')] }),
    );
    expect(findNode(merged, 'element_a').confidence).toBe('verified');
  });

  it('keeps the strongest claim otherwise (per CONFIDENCE_ORDER)', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'inferred', 'static')] }),
      graph({ nodes: [el('element_a', 'ai_reviewed', 'ai')] }),
    );
    const n = findNode(merged, 'element_a');
    expect(n.confidence).toBe('inferred');
    expect(n.source).toBe('static');
  });

  it('leaves runtime-only facts observed', () => {
    const merged = mergeGraphs(
      graph({}),
      graph({ nodes: [el('element_rt', 'observed', 'runtime')] }),
    );
    const n = findNode(merged, 'element_rt');
    expect(n.confidence).toBe('observed');
    expect(n.source).toBe('runtime');
  });

  it('never downgrades verified below verified for non-contradicted input', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'verified', 'both')] }),
      graph({ nodes: [el('element_a', 'ambiguous', 'runtime')] }),
    );
    expect(findNode(merged, 'element_a').confidence).toBe('verified');
  });

  it('downgrades verified only via an explicit contradicted input', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'verified', 'both')] }),
      graph({ nodes: [el('element_a', 'contradicted', 'runtime')] }),
    );
    const n = findNode(merged, 'element_a');
    expect(n.confidence).toBe('contradicted');
    expect(n.source).toBe('runtime');
  });
});

describe('mergeGraphs element merge', () => {
  it('runtime fills role, name and locator.unique', () => {
    const staticEl = el('element_a', 'extracted', 'static', {
      role: undefined,
      name: undefined,
      locator: { strategy: 'role', role: 'button', name: 'Save' },
    });
    const runtimeEl = el('element_a', 'observed', 'runtime', {
      role: 'button',
      name: 'Save',
      locator: { strategy: 'role', role: 'button', name: 'Save', unique: true },
    });
    const merged = mergeGraphs(graph({ nodes: [staticEl] }), graph({ nodes: [runtimeEl] }));
    const n = findNode(merged, 'element_a') as ElementNode;
    expect(n.role).toBe('button');
    expect(n.name).toBe('Save');
    expect(n.locator.unique).toBe(true);
    expect(n.confidence).toBe('verified');
  });

  it('keeps static role/name when both sides have them', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'extracted', 'static', { name: 'Save draft' })] }),
      graph({ nodes: [el('element_a', 'observed', 'runtime', { name: 'Save' })] }),
    );
    expect((findNode(merged, 'element_a') as ElementNode).name).toBe('Save draft');
  });

  it('marks the element ambiguous when runtime found multiple matches', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'extracted', 'static')] }),
      graph({
        nodes: [
          el('element_a', 'observed', 'runtime', {
            locator: { strategy: 'role', role: 'button', name: 'Save', unique: false },
          }),
        ],
      }),
    );
    const n = findNode(merged, 'element_a') as ElementNode;
    expect(n.confidence).toBe('ambiguous');
    expect(n.locator.unique).toBe(false);
  });

  it('does not let ambiguity downgrade an already-verified element', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_a', 'verified', 'both')] }),
      graph({
        nodes: [
          el('element_a', 'observed', 'runtime', {
            locator: { strategy: 'role', role: 'button', name: 'Save', unique: false },
          }),
        ],
      }),
    );
    const n = findNode(merged, 'element_a') as ElementNode;
    expect(n.confidence).toBe('verified');
    expect(n.locator.unique).toBe(false);
  });
});

describe('mergeGraphs edges and metadata', () => {
  const edge = (confidence: Confidence, source: FactSource, evidence?: string): GraphEdge => ({
    from: 'element_a',
    to: 'action_b',
    type: 'TRIGGERS',
    confidence,
    source,
    ...(evidence ? { evidence } : {}),
  });

  it('merges edges by edgeKey and promotes like nodes', () => {
    const merged = mergeGraphs(
      graph({ edges: [edge('extracted', 'static')] }),
      graph({ edges: [edge('observed', 'runtime', 'click observed 2026-10-17')] }),
    );
    expect(merged.edges).toHaveLength(1);
    const e = merged.edges[0]!;
    expect(e.confidence).toBe('verified');
    expect(e.source).toBe('both');
    expect(e.evidence).toBe('click observed 2026-10-17');
  });

  it('keeps runtime-only edges observed', () => {
    const merged = mergeGraphs(graph({}), graph({ edges: [edge('observed', 'runtime')] }));
    expect(merged.edges).toHaveLength(1);
    expect(merged.edges[0]!.confidence).toBe('observed');
  });

  it('unions fileHashes (runtime usually has none)', () => {
    const merged = mergeGraphs(
      graph({ fileHashes: { 'a.ts': 'h1', 'b.ts': 'h2' } }),
      graph({ fileHashes: { 'c.ts': 'h3' } }),
    );
    expect(merged.fileHashes).toEqual({ 'a.ts': 'h1', 'b.ts': 'h2', 'c.ts': 'h3' });
  });

  it('sorts merged nodes by id and edges by edgeKey', () => {
    const merged = mergeGraphs(
      graph({ nodes: [el('element_b', 'extracted', 'static'), el('element_a', 'extracted', 'static')] }),
      graph({}),
    );
    expect(merged.nodes.map((n) => n.id)).toEqual(['element_a', 'element_b']);
  });
});
