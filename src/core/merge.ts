/**
 * Merge a static graph with a runtime graph. Confidence promotion lives here
 * and only here: extracted/inferred plus observed becomes verified; an explicit
 * contradicted fact is the only thing that can knock verified down. AI
 * judgment never arrives through this function.
 */
import { CONFIDENCE_ORDER, edgeKey } from '../types.js';
import type {
  Confidence,
  ElementNode,
  FactSource,
  Graph,
  GraphEdge,
  GraphNode,
} from '../types.js';

const rank = (c: Confidence): number => {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return i === -1 ? CONFIDENCE_ORDER.length : i;
};

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === 'contradicted' || b === 'contradicted') return 'contradicted';
  const pair = new Set<Confidence>([a, b]);
  const staticLike = pair.has('extracted') || pair.has('inferred');
  if (staticLike && pair.has('observed') && !pair.has('verified')) return 'verified';
  return rank(a) <= rank(b) ? a : b;
}

function mergeSource(a: GraphNode | GraphEdge, b: GraphNode | GraphEdge, confidence: Confidence): FactSource {
  if (confidence === 'verified') return 'both';
  if (a.confidence === 'contradicted') return a.source;
  if (b.confidence === 'contradicted') return b.source;
  return rank(b.confidence) < rank(a.confidence) ? b.source : a.source;
}

function mergeElement(a: ElementNode, b: ElementNode): ElementNode {
  let confidence = mergeConfidence(a.confidence, b.confidence);
  const unique = b.locator.unique !== undefined ? b.locator.unique : a.locator.unique;
  // A runtime match that is not unique is ambiguous, unless one side was
  // already verified — ambiguity must not erase a prior verification.
  if (
    unique === false &&
    confidence === 'verified' &&
    a.confidence !== 'verified' &&
    b.confidence !== 'verified'
  ) {
    confidence = 'ambiguous';
  }
  const source = mergeSource(
    { ...a, confidence: a.confidence },
    { ...b, confidence: b.confidence },
    confidence === 'ambiguous' && a.confidence !== 'ambiguous' && b.confidence !== 'ambiguous'
      ? 'verified'
      : confidence,
  );
  return {
    ...a,
    role: a.role ?? b.role,
    name: a.name ?? b.name,
    text: a.text ?? b.text,
    i18nKey: a.i18nKey ?? b.i18nKey,
    locator: { ...a.locator, ...(unique !== undefined ? { unique } : {}) },
    confidence,
    source: confidence === 'verified' ? 'both' : source,
  };
}

function mergeNode(a: GraphNode, b: GraphNode): GraphNode {
  if (a.kind === 'element' && b.kind === 'element') return mergeElement(a, b);
  const confidence = mergeConfidence(a.confidence, b.confidence);
  const source = mergeSource(a, b, confidence);
  return { ...b, ...a, confidence, source };
}

function mergeEdge(a: GraphEdge, b: GraphEdge): GraphEdge {
  const confidence = mergeConfidence(a.confidence, b.confidence);
  const source = mergeSource(a, b, confidence);
  const evidence = a.evidence ?? b.evidence;
  return {
    ...b,
    ...a,
    confidence,
    source: confidence === 'verified' ? 'both' : source,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** First graph is the base (usually static); the second fills runtime facts. */
export function mergeGraphs(base: Graph, incoming: Graph): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const n of base.nodes) nodes.set(n.id, n);
  for (const n of incoming.nodes) {
    const prev = nodes.get(n.id);
    nodes.set(n.id, prev ? mergeNode(prev, n) : n);
  }

  const edges = new Map<string, GraphEdge>();
  for (const e of base.edges) edges.set(edgeKey(e), e);
  for (const e of incoming.edges) {
    const key = edgeKey(e);
    const prev = edges.get(key);
    edges.set(key, prev ? mergeEdge(prev, e) : e);
  }

  return {
    schemaVersion: base.schemaVersion,
    generator: base.generator,
    app: base.app,
    builtAt: incoming.builtAt || base.builtAt,
    fileHashes: { ...incoming.fileHashes, ...base.fileHashes },
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}
