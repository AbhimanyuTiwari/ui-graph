/**
 * Graphify-style export: graph.json, a markdown report, and a static HTML
 * page. Edge tags use EXTRACTED / INFERRED (and the other confidence names
 * in uppercase). The HTML has no script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { edgeKey, type Confidence, type Graph, type GraphEdge, type GraphNode } from '../types.js';

export interface ExportPaths {
  graphJson: string;
  report: string;
  html: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) out[key] = canonical(obj[key]);
    }
    return out;
  }
  return value;
}

export function factTag(confidence: Confidence): string {
  if (confidence === 'extracted') return 'EXTRACTED';
  if (confidence === 'inferred') return 'INFERRED';
  return confidence.toUpperCase();
}

function nodeLabel(node: GraphNode): string {
  switch (node.kind) {
    case 'route':
      return node.fullPath;
    case 'screen':
      return node.state;
    case 'element':
      return node.name ?? node.id;
    case 'action':
      return node.handler ?? node.detail ?? node.id;
    case 'component':
    case 'form':
      return node.name ?? node.id;
    case 'api':
      return `${node.method} ${node.urlPattern}`;
    case 'precondition':
      return node.detail;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function edgeLine(graph: Graph, edge: GraphEdge): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  return `${factTag(edge.confidence)} ${edge.type} ${from ? nodeLabel(from) : edge.from} -> ${to ? nodeLabel(to) : edge.to}`;
}

export function exportGraph(graph: Graph, outDir: string): ExportPaths {
  mkdirSync(outDir, { recursive: true });
  const graphJson = path.join(outDir, 'graph.json');
  const report = path.join(outDir, 'GRAPH_REPORT.md');
  const html = path.join(outDir, 'graph.html');

  const nodes = [...graph.nodes].sort((a, b) => `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`));
  const edges = [...graph.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const body = canonical({ ...graph, nodes, edges });
  writeFileSync(graphJson, `${JSON.stringify(body, null, 2)}\n`);

  const lines = [
    '# uigraph graph',
    '',
    `App ${graph.app.name} (${graph.app.framework}). ${nodes.length} nodes, ${edges.length} edges.`,
    '',
    'Tags: EXTRACTED is literal in source. INFERRED was resolved (call graph, lazy route, bundle without a source map).',
    '',
    '## Routes',
    '',
    ...nodes.filter((node) => node.kind === 'route').map((node) => `- ${nodeLabel(node)} (${factTag(node.confidence)})`),
    '',
    '## Edges',
    '',
    ...edges.map((edge) => `- ${edgeLine(graph, edge)}`),
    '',
  ];
  writeFileSync(report, lines.join('\n'));

  const rows = edges
    .map((edge) => `<tr><td>${escapeHtml(factTag(edge.confidence))}</td><td>${escapeHtml(edge.type)}</td><td>${escapeHtml(edgeLine(graph, edge))}</td></tr>`)
    .join('\n');
  const routes = nodes
    .filter((node) => node.kind === 'route')
    .map((node) => `<li>${escapeHtml(nodeLabel(node))}</li>`)
    .join('');
  writeFileSync(
    html,
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>uigraph ${escapeHtml(graph.app.name)}</title></head>
<body>
<h1>${escapeHtml(graph.app.name)}</h1>
<ul>${routes}</ul>
<table>
<thead><tr><th>tag</th><th>type</th><th>edge</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`,
  );

  return { graphJson, report, html };
}
