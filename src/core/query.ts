/**
 * Read-only query API over a graph. Answers stay small and auditable.
 * pathTo never steps through an action whose safety is not 'safe'.
 */
import { assignOwners } from './store.js';
import { renderPlaywright } from './render.js';
import { edgeKey } from '../types.js';
import type {
  ActionNode,
  ElementNode,
  Graph,
  GraphEdge,
  GraphNode,
  PathAnswer,
  PathStep,
  QueryApi,
  RouteNode,
  ScreenAnswer,
  ScreenNode,
  StaleAnswer,
} from '../types.js';

const ELEMENT_CAP = 40;

interface Indexes {
  byId: Map<string, GraphNode>;
  routes: RouteNode[];
  screens: ScreenNode[];
  edgesFrom: Map<string, GraphEdge[]>;
  edgesTo: Map<string, GraphEdge[]>;
}

function indexGraph(graph: Graph): Indexes {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const edgesFrom = new Map<string, GraphEdge[]>();
  const edgesTo = new Map<string, GraphEdge[]>();
  const edges = [...graph.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  for (const e of edges) {
    const from = edgesFrom.get(e.from);
    if (from) from.push(e);
    else edgesFrom.set(e.from, [e]);
    const to = edgesTo.get(e.to);
    if (to) to.push(e);
    else edgesTo.set(e.to, [e]);
  }
  return {
    byId,
    routes: graph.nodes.filter((n): n is RouteNode => n.kind === 'route'),
    screens: graph.nodes.filter((n): n is ScreenNode => n.kind === 'screen'),
    edgesFrom,
    edgesTo,
  };
}

function routeOf(ix: Indexes, fullPath: string): RouteNode | undefined {
  return ix.routes.find((r) => r.fullPath === fullPath && !r.redirectTo);
}

function screenOf(ix: Indexes, routeId: string, state: string): ScreenNode | undefined {
  return ix.screens.find((s) => s.routeId === routeId && s.state === state);
}

function preconditions(ix: Indexes, routeId: string): string[] {
  const out: string[] = [];
  for (const e of ix.edgesFrom.get(routeId) ?? []) {
    if (e.type !== 'REQUIRES') continue;
    const n = ix.byId.get(e.to);
    if (n?.kind === 'precondition' && !out.includes(n.detail)) out.push(n.detail);
  }
  return out;
}

function elementView(ix: Indexes, el: ElementNode): ScreenAnswer['elements'][number] {
  const actions = (ix.edgesFrom.get(el.id) ?? [])
    .filter((e) => e.type === 'TRIGGERS')
    .map((e) => ix.byId.get(e.to))
    .filter((n): n is ActionNode => n?.kind === 'action')
    .map((a) => a.detail)
    .filter((d): d is string => d !== undefined)
    .sort();
  return {
    id: el.id,
    ...(el.role !== undefined ? { role: el.role } : {}),
    ...(el.name !== undefined ? { name: el.name } : {}),
    locator: el.locator,
    rendered: renderPlaywright(el.locator),
    confidence: el.confidence,
    ...(actions.length > 0 ? { actions } : {}),
  };
}

function containsElements(ix: Indexes, screenId: string): ElementNode[] {
  return (ix.edgesFrom.get(screenId) ?? [])
    .filter((e) => e.type === 'CONTAINS')
    .map((e) => ix.byId.get(e.to))
    .filter((n): n is ElementNode => n?.kind === 'element')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));
}

function resolveScreen(ix: Indexes, target: string): ScreenNode | null {
  const hash = target.indexOf('#');
  if (hash !== -1) {
    const route = routeOf(ix, target.slice(0, hash));
    if (!route) return null;
    return screenOf(ix, route.id, target.slice(hash + 1)) ?? null;
  }
  if (target.startsWith('/')) {
    const route = routeOf(ix, target);
    if (!route) return null;
    return screenOf(ix, route.id, 'default') ?? null;
  }
  const byTitle = ix.screens.find((s) => s.title === target);
  return byTitle ?? null;
}

function routeForScreen(ix: Indexes, screen: ScreenNode): RouteNode | undefined {
  return ix.routes.find((r) => r.id === screen.routeId);
}

interface ClickHop {
  element: ElementNode;
  dest: ScreenNode;
}

function safeHops(ix: Indexes, screen: ScreenNode): ClickHop[] {
  const hops: ClickHop[] = [];
  for (const el of containsElements(ix, screen.id)) {
    for (const trig of ix.edgesFrom.get(el.id) ?? []) {
      if (trig.type !== 'TRIGGERS') continue;
      const action = ix.byId.get(trig.to);
      if (action?.kind !== 'action' || action.safety !== 'safe') continue;
      for (const out of ix.edgesFrom.get(action.id) ?? []) {
        if (out.type !== 'NAVIGATES_TO' && out.type !== 'OPENS') continue;
        const destNode = ix.byId.get(out.to);
        let dest: ScreenNode | undefined;
        if (destNode?.kind === 'screen') dest = destNode;
        else if (destNode?.kind === 'route') dest = screenOf(ix, destNode.id, 'default');
        if (!dest || dest.id === screen.id) continue;
        hops.push({ element: el, dest });
      }
    }
  }
  hops.sort((a, b) => a.element.id.localeCompare(b.element.id) || a.dest.id.localeCompare(b.dest.id));
  return hops;
}

function targetedRouteIds(ix: Indexes): Set<string> {
  const ids = new Set<string>();
  for (const screen of ix.screens) {
    for (const e of ix.edgesTo.get(screen.id) ?? []) {
      if (e.type === 'NAVIGATES_TO') ids.add(screen.routeId);
    }
  }
  for (const route of ix.routes) {
    for (const e of ix.edgesTo.get(route.id) ?? []) {
      if (e.type === 'NAVIGATES_TO') ids.add(route.id);
    }
  }
  return ids;
}

function defaultScreens(ix: Indexes, routes: RouteNode[]): ScreenNode[] {
  const screens: ScreenNode[] = [];
  for (const route of [...routes].sort((a, b) => a.fullPath.localeCompare(b.fullPath))) {
    const screen = screenOf(ix, route.id, 'default');
    if (screen) screens.push(screen);
  }
  return screens;
}

interface FoundPath {
  screens: ScreenNode[];
  clicks: Array<ElementNode | null>;
}

function findPath(ix: Indexes, target: ScreenNode, from: string | undefined): FoundPath | null {
  let starts: ScreenNode[];
  if (from !== undefined) {
    const route = routeOf(ix, from);
    const screen = route ? screenOf(ix, route.id, 'default') : undefined;
    if (!screen) return null;
    starts = [screen];
  } else {
    const targeted = targetedRouteIds(ix);
    const entries = ix.routes.filter((r) => !r.redirectTo && !targeted.has(r.id));
    starts = defaultScreens(ix, entries.length > 0 ? entries : ix.routes.filter((r) => !r.redirectTo));
  }

  const direct = starts.find((s) => s.id === target.id);
  if (direct) return { screens: [direct], clicks: [null] };

  interface Frame {
    screen: ScreenNode;
    prev: number;
    via: ElementNode | null;
  }
  const frames: Frame[] = starts.map((screen) => ({ screen, prev: -1, via: null }));
  const seen = new Set(starts.map((s) => s.id));
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    for (const hop of safeHops(ix, frame.screen)) {
      if (seen.has(hop.dest.id)) continue;
      seen.add(hop.dest.id);
      frames.push({ screen: hop.dest, prev: i, via: hop.element });
      if (hop.dest.id === target.id) {
        const chain: ScreenNode[] = [];
        const clicks: Array<ElementNode | null> = [];
        let cur = frames.length - 1;
        while (cur !== -1) {
          const f = frames[cur]!;
          chain.push(f.screen);
          clicks.push(f.via);
          cur = f.prev;
        }
        chain.reverse();
        clicks.reverse();
        return { screens: chain, clicks };
      }
    }
  }
  return null;
}

function labelOf(node: GraphNode): string {
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
      return node.name;
    case 'api':
      return `${node.method} ${node.urlPattern}`;
    case 'form':
      return node.name ?? node.id;
    case 'precondition':
      return node.detail;
  }
}
function describe(node: GraphNode, ix: Indexes): string {
  const label = labelOf(node);
  const where = node.file ? `${node.file}${node.line !== undefined ? `:${node.line}` : ''}` : 'unknown file';
  const types = new Set<string>();
  for (const e of ix.edgesFrom.get(node.id) ?? []) types.add(e.type);
  for (const e of ix.edgesTo.get(node.id) ?? []) types.add(e.type);
  const connections = [...types].sort().join(', ');
  return `${node.kind} ${label} (${node.confidence}), defined in ${where}. Edges: ${connections}.`;
}

function findByName(ix: Indexes, query: string): GraphNode | undefined {
  const q = query.toLowerCase();
  const named = ix.byId.values();
  const matches: GraphNode[] = [];
  for (const n of named) {
    const fields: Array<string | undefined> = [];
    if (n.kind === 'route') fields.push(n.fullPath, n.path, n.componentName);
    else if (n.kind === 'element') fields.push(n.name, n.text);
    else if (n.kind === 'screen') fields.push(n.title, n.state);
    else if (n.kind === 'action') fields.push(n.handler, n.detail);
    else if (n.kind === 'component' || n.kind === 'form') fields.push(n.name);
    else if (n.kind === 'precondition') fields.push(n.detail);
    else if (n.kind === 'api') fields.push(`${n.method} ${n.urlPattern}`);
    if (fields.some((f) => f?.toLowerCase() === q)) matches.push(n);
  }
  matches.sort((a, b) => {
    const rank = (n: GraphNode): number =>
      n.kind === 'route' ? 0 : n.kind === 'element' ? 1 : n.kind === 'screen' ? 2 : 3;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
  return matches[0];
}

export function makeQueryApi(graph: Graph): QueryApi {
  const ix = indexGraph(graph);

  const getScreen: QueryApi['getScreen'] = (route, state = 'default') => {
    const r = routeOf(ix, route);
    if (!r) return null;
    const screen = screenOf(ix, r.id, state);
    if (!screen) return null;
    const elements = containsElements(ix, screen.id);
    const truncated = elements.length > ELEMENT_CAP;
    return {
      screen: { route: r.fullPath, state: screen.state },
      preconditions: preconditions(ix, r.id),
      elements: elements.slice(0, ELEMENT_CAP).map((el) => elementView(ix, el)),
      ...(truncated ? { truncated: true } : {}),
    };
  };

  return {
    getScreen,

    locatorsFor(query: string): ScreenAnswer['elements'] {
      const q = query.toLowerCase();
      const hits = graph.nodes.filter((n): n is ElementNode => {
        if (n.kind !== 'element') return false;
        const fields = [n.name, n.text, n.i18nKey, ...Object.values(n.attrs ?? {})];
        return fields.some((f) => f?.toLowerCase().includes(q));
      });
      hits.sort((a, b) => {
        const av = a.confidence === 'verified' ? 0 : 1;
        const bv = b.confidence === 'verified' ? 0 : 1;
        if (av !== bv) return av - bv;
        const ae = (a.name ?? '').toLowerCase() === q ? 0 : 1;
        const be = (b.name ?? '').toLowerCase() === q ? 0 : 1;
        if (ae !== be) return ae - be;
        return a.id.localeCompare(b.id);
      });
      return hits.map((el) => elementView(ix, el));
    },

    pathTo(target: string, from?: string): PathAnswer | null {
      const screen = resolveScreen(ix, target);
      if (!screen) return null;
      const found = findPath(ix, screen, from);
      if (!found || found.screens.length === 0) return null;
      const start = found.screens[0];
      if (!start) return null;
      const startRoute = routeForScreen(ix, start);
      if (!startRoute) return null;
      const steps: PathStep[] = [{ do: 'goto', url: startRoute.fullPath }];
      for (let i = 1; i < found.screens.length; i++) {
        const el = found.clicks[i];
        if (!el) return null;
        steps.push({
          do: 'click',
          locator: el.locator,
          rendered: renderPlaywright(el.locator),
        });
      }
      const pres: string[] = [];
      for (const s of found.screens) {
        for (const p of preconditions(ix, s.routeId)) {
          if (!pres.includes(p)) pres.push(p);
        }
      }
      const route = routeForScreen(ix, screen);
      if (!route) return null;
      return {
        target: { route: route.fullPath, state: screen.state },
        steps,
        preconditions: pres,
      };
    },

    actionsOf(elementIdOrName: string) {
      const byId = ix.byId.get(elementIdOrName);
      const el =
        byId?.kind === 'element'
          ? byId
          : graph.nodes.find(
              (n): n is ElementNode =>
                n.kind === 'element' && n.name?.toLowerCase() === elementIdOrName.toLowerCase(),
            );
      if (!el) return [];
      return (ix.edgesFrom.get(el.id) ?? [])
        .filter((e) => e.type === 'TRIGGERS')
        .map((e) => ix.byId.get(e.to))
        .filter((n): n is ActionNode => n?.kind === 'action')
        .map((a) => ({
          type: a.type,
          safety: a.safety,
          ...(a.detail !== undefined ? { detail: a.detail } : {}),
        }));
    },

    staleCheck(files: string[]): StaleAnswer {
      const wanted = new Set(files);
      const owners = assignOwners(graph);
      const stale = graph.nodes.filter((n) => n.file !== undefined && wanted.has(n.file));
      const staleNodeIds = stale.map((n) => n.id).sort();
      const routeIds = new Set<string>();
      for (const n of stale) {
        const owner = owners.get(n.id);
        if (owner) routeIds.add(owner);
      }
      const staleRoutes = ix.routes
        .filter((r) => routeIds.has(r.id))
        .map((r) => r.fullPath)
        .sort();
      const summary =
        staleNodeIds.length === 0
          ? 'nothing stale'
          : `${staleNodeIds.length} stale nodes on ${staleRoutes.join(', ') || 'shared nodes'}`;
      return { staleNodeIds, staleRoutes, summary };
    },

    explain(nameOrId: string): string | null {
      const node = ix.byId.get(nameOrId) ?? findByName(ix, nameOrId);
      if (!node) return null;
      return describe(node, ix);
    },
  };
}
