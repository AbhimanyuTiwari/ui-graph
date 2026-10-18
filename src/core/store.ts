/**
 * Deterministic on-disk store: one JSON file per route plus index.json and
 * shared.json. Same graph in, byte-identical files out — nodes are sorted by
 * id, edges by edgeKey, object keys alphabetically, 2-space indent. builtAt
 * lives only in index.json so route files do not churn between rebuilds.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { edgeKey } from '../types.js';
import type { Graph, GraphEdge, GraphNode, RouteNode, ScreenNode } from '../types.js';

/** Route fullPath -> file slug: '/'→'_', ':'→'', '' → 'root'. */
export function routeSlug(fullPath: string): string {
  const slug = fullPath.replaceAll('/', '_').replaceAll(':', '');
  return slug === '' ? 'root' : slug;
}

const byId = (a: GraphNode, b: GraphNode): number => a.id.localeCompare(b.id);
const byKey = (a: GraphEdge, b: GraphEdge): number => edgeKey(a).localeCompare(edgeKey(b));

/** Recursively sort object keys (arrays keep order) and drop undefined. */
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(canonical(value), null, 2)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Assign each node its owning route ("first owner wins", routes visited in
 * fullPath order): a route owns itself, its screens (ScreenNode.routeId), and
 * everything reachable from those screens via CONTAINS/TRIGGERS edges.
 * Unowned nodes are shared.
 */
/**
 * File slug per route id. Routes can share a fullPath (a layout route and its
 * empty-path child) or collapse to the same slug ('/a/b' vs '/a_b'); later
 * ones get their id appended so no route file overwrites another.
 */
function slugsFor(routes: RouteNode[]): Map<string, string> {
  const slugs = new Map<string, string>();
  const taken = new Set<string>();
  const ordered = [...routes].sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.id.localeCompare(b.id));
  for (const route of ordered) {
    const base = routeSlug(route.fullPath);
    const slug = taken.has(base) ? `${base}~${route.id}` : base;
    taken.add(slug);
    slugs.set(route.id, slug);
  }
  return slugs;
}

export function assignOwners(graph: Graph): Map<string, string> {
  const owner = new Map<string, string>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of [...graph.edges].sort(byKey)) {
    if (e.type !== 'CONTAINS' && e.type !== 'TRIGGERS') continue;
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }
  const routes = graph.nodes
    .filter((n): n is RouteNode => n.kind === 'route')
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  const nodesSorted = [...graph.nodes].sort(byId);

  for (const route of routes) {
    if (!owner.has(route.id)) owner.set(route.id, route.id);
    const screens = nodesSorted.filter(
      (n): n is ScreenNode => n.kind === 'screen' && n.routeId === route.id,
    );
    const queue: string[] = [];
    for (const screen of screens) {
      if (!owner.has(screen.id)) owner.set(screen.id, route.id);
      queue.push(screen.id);
    }
    const visited = new Set<string>(queue);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of outgoing.get(cur) ?? []) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        if (!owner.has(e.to)) owner.set(e.to, route.id);
        queue.push(e.to);
      }
    }
  }
  return owner;
}

interface IndexFile {
  schemaVersion: string;
  generator: Graph['generator'];
  app: Graph['app'];
  builtAt: string;
  fileHashes: Record<string, string>;
  routes: Array<{ id: string; fullPath: string; slug: string }>;
}

interface PartFile {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface RouteFile extends PartFile {
  fullPath: string;
}

export function saveGraph(dir: string, graph: Graph): void {
  const nodes = [...graph.nodes].sort(byId);
  const edges = [...graph.edges].sort(byKey);
  const owner = assignOwners(graph);
  const routes = nodes
    .filter((n): n is RouteNode => n.kind === 'route')
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.id.localeCompare(b.id));
  const slugs = slugsFor(routes);

  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'routes'), { recursive: true, force: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });

  const index: IndexFile = {
    schemaVersion: graph.schemaVersion,
    generator: graph.generator,
    app: graph.app,
    builtAt: graph.builtAt,
    fileHashes: graph.fileHashes,
    routes: routes.map((r) => ({ id: r.id, fullPath: r.fullPath, slug: slugs.get(r.id) ?? routeSlug(r.fullPath) })),
  };
  writeJson(join(dir, 'index.json'), index);

  // An edge lives with the route owning its `from` node, else its `to` node.
  const edgeOwner = (e: GraphEdge): string | undefined => owner.get(e.from) ?? owner.get(e.to);

  for (const route of routes) {
    const file: RouteFile = {
      fullPath: route.fullPath,
      nodes: nodes.filter((n) => owner.get(n.id) === route.id),
      edges: edges.filter((e) => edgeOwner(e) === route.id),
    };
    writeJson(join(dir, 'routes', `${slugs.get(route.id) ?? routeSlug(route.fullPath)}.json`), file);
  }

  const shared: PartFile = {
    nodes: nodes.filter((n) => !owner.has(n.id)),
    edges: edges.filter((e) => edgeOwner(e) === undefined),
  };
  writeJson(join(dir, 'shared.json'), shared);
}

export function loadGraph(dir: string): Graph {
  const index = readJson<IndexFile>(join(dir, 'index.json'));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const route of index.routes) {
    const part = readJson<RouteFile>(join(dir, 'routes', `${route.slug}.json`));
    nodes.push(...part.nodes);
    edges.push(...part.edges);
  }
  const shared = readJson<PartFile>(join(dir, 'shared.json'));
  nodes.push(...shared.nodes);
  edges.push(...shared.edges);
  return {
    schemaVersion: index.schemaVersion,
    generator: index.generator,
    app: index.app,
    builtAt: index.builtAt,
    fileHashes: index.fileHashes,
    nodes: nodes.sort(byId),
    edges: edges.sort(byKey),
  };
}
