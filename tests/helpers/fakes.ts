/**
 * In-memory fakes for the injected Services. All CLI/MCP/verify tests run
 * against these — zero dependence on the core/adapters/crawl modules that
 * other agents are writing concurrently.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stableId } from '../../src/core/ids.js';
import { makeValidatePlan, checkEvidence } from '../../src/verify/validate.js';
import type { Services } from '../../src/cli/services.js';
import type {
  ActionNode,
  ElementNode,
  Evidence,
  Graph,
  GraphEdge,
  GraphNode,
  LocatorDescriptor,
  ProbePlan,
  QueryApi,
  RouteNode,
  ScreenAnswer,
  ScreenNode,
} from '../../src/types.js';
import { edgeKey as edgeKeyOf } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixture graph
// ---------------------------------------------------------------------------

export interface FixtureIds {
  rUsers: string;
  rUserDetail: string;
  rAdmin: string;
  sUsers: string;
  sUserDetail: string;
  sAdmin: string;
  eAdd: string;
  eDelete: string;
  eUnnamed: string;
  eAmbiguous: string;
  aAddNav: string;
  aDelete: string;
  aBack: string;
}

export interface Fixture {
  graph: Graph;
  ids: FixtureIds;
  /** edgeKeys of interest */
  keys: {
    addTriggers: string; // inferred, safe -> verify_edge
    deleteTriggers: string; // ambiguous, destructive -> review_edge
    addNavigates: string; // inferred, safe -> verify_edge
    backNavigates: string; // inferred, safe -> verify_edge
  };
}

const loc = (role: string, name: string): LocatorDescriptor => ({ strategy: 'role', role, name });

export function makeFixture(): Fixture {
  const ids: FixtureIds = {
    rUsers: stableId('route', '/users'),
    rUserDetail: stableId('route', '/users/:id'),
    rAdmin: stableId('route', '/admin'),
    sUsers: stableId('screen', '/users', 'default'),
    sUserDetail: stableId('screen', '/users/:id', 'default'),
    sAdmin: stableId('screen', '/admin', 'default'),
    eAdd: stableId('element', 'button', 'Add user'),
    eDelete: stableId('element', 'button', 'Delete user'),
    eUnnamed: stableId('element', 'button', ''),
    eAmbiguous: stableId('element', 'row', 'Row action'),
    aAddNav: stableId('action', 'navigate', '/users/:id'),
    aDelete: stableId('action', 'api', 'DELETE /api/users/:id'),
    aBack: stableId('action', 'navigate', '/users'),
  };

  const route = (id: string, fullPath: string, file?: string): RouteNode => ({
    id,
    kind: 'route',
    path: fullPath.replace(/^\//, ''),
    fullPath,
    paramNames: fullPath.includes(':id') ? ['id'] : [],
    guards: [],
    confidence: 'extracted',
    source: 'static',
    file,
    line: file ? 3 : undefined,
  });
  const screen = (id: string, routeId: string): ScreenNode => ({
    id,
    kind: 'screen',
    routeId,
    state: 'default',
    confidence: 'extracted',
    source: 'static',
  });

  const eAdd: ElementNode = {
    id: ids.eAdd,
    kind: 'element',
    locator: loc('button', 'Add user'),
    role: 'button',
    name: 'Add user',
    confidence: 'extracted',
    source: 'static',
    file: 'src/app/users.html',
    line: 20,
  };
  const eDelete: ElementNode = {
    id: ids.eDelete,
    kind: 'element',
    locator: loc('button', 'Delete user'),
    role: 'button',
    name: 'Delete user',
    confidence: 'extracted',
    source: 'static',
    file: 'src/app/users.html',
    line: 25,
  };
  const eUnnamed: ElementNode = {
    id: ids.eUnnamed,
    kind: 'element',
    locator: { strategy: 'css', css: 'button.icon' },
    role: 'button',
    unnamed: true,
    confidence: 'observed',
    source: 'runtime',
    file: 'src/app/users.html',
    line: 30,
  };
  const eAmbiguous: ElementNode = {
    id: ids.eAmbiguous,
    kind: 'element',
    locator: { strategy: 'text', name: 'Row action' },
    name: 'Row action',
    confidence: 'ambiguous',
    source: 'static',
    file: 'src/app/users.html',
  };

  const aAddNav: ActionNode = {
    id: ids.aAddNav,
    kind: 'action',
    type: 'navigate',
    safety: 'safe',
    detail: '/users/:id',
    confidence: 'inferred',
    source: 'static',
  };
  const aDelete: ActionNode = {
    id: ids.aDelete,
    kind: 'action',
    type: 'api',
    safety: 'destructive',
    detail: 'DELETE /api/users/:id',
    handler: 'UserListComponent.onDelete',
    confidence: 'inferred',
    source: 'static',
  };
  const aBack: ActionNode = {
    id: ids.aBack,
    kind: 'action',
    type: 'navigate',
    safety: 'safe',
    detail: '/users',
    confidence: 'inferred',
    source: 'static',
  };

  const nodes: GraphNode[] = [
    route(ids.rUsers, '/users', 'src/app/users.routes.ts'),
    route(ids.rUserDetail, '/users/:id'),
    route(ids.rAdmin, '/admin'),
    screen(ids.sUsers, ids.rUsers),
    screen(ids.sUserDetail, ids.rUserDetail),
    screen(ids.sAdmin, ids.rAdmin),
    eAdd,
    eDelete,
    eUnnamed,
    eAmbiguous,
    aAddNav,
    aDelete,
    aBack,
  ];

  const edge = (
    from: string,
    type: GraphEdge['type'],
    to: string,
    confidence: GraphEdge['confidence'],
  ): GraphEdge => ({ from, to, type, confidence, source: 'static' });

  const edges: GraphEdge[] = [
    edge(ids.rUsers, 'HAS_SCREEN', ids.sUsers, 'extracted'),
    edge(ids.rUserDetail, 'HAS_SCREEN', ids.sUserDetail, 'extracted'),
    edge(ids.rAdmin, 'HAS_SCREEN', ids.sAdmin, 'extracted'),
    edge(ids.sUsers, 'CONTAINS', ids.eAdd, 'extracted'),
    edge(ids.sUsers, 'CONTAINS', ids.eDelete, 'extracted'),
    edge(ids.sUsers, 'CONTAINS', ids.eUnnamed, 'observed'),
    edge(ids.sUsers, 'CONTAINS', ids.eAmbiguous, 'extracted'),
    edge(ids.eAdd, 'TRIGGERS', ids.aAddNav, 'inferred'),
    edge(ids.eDelete, 'TRIGGERS', ids.aDelete, 'ambiguous'),
    edge(ids.aAddNav, 'NAVIGATES_TO', ids.sUserDetail, 'inferred'),
    edge(ids.aBack, 'NAVIGATES_TO', ids.sUsers, 'inferred'),
    edge(ids.aDelete, 'NAVIGATES_TO', ids.sUsers, 'extracted'),
    edge(ids.sUsers, 'COVERED_BY', 'tests/users.spec.ts', 'extracted'),
  ];

  const graph: Graph = {
    schemaVersion: '0.1.0',
    generator: { name: 'uigraph', version: '0.1.0' },
    app: { name: 'fixture-app', framework: 'angular' },
    builtAt: '2026-10-17T00:00:00.000Z',
    fileHashes: { 'src/app/users.html': 'abc123', 'src/app/users.routes.ts': 'def456' },
    nodes,
    edges,
  };

  const key = (from: string, type: GraphEdge['type'], to: string): string =>
    edgeKeyOf({ from, type, to });

  return {
    graph,
    ids,
    keys: {
      addTriggers: key(ids.eAdd, 'TRIGGERS', ids.aAddNav),
      deleteTriggers: key(ids.eDelete, 'TRIGGERS', ids.aDelete),
      addNavigates: key(ids.aAddNav, 'NAVIGATES_TO', ids.sUserDetail),
      backNavigates: key(ids.aBack, 'NAVIGATES_TO', ids.sUsers),
    },
  };
}

// ---------------------------------------------------------------------------
// Fake QueryApi
// ---------------------------------------------------------------------------

export class FakeQuery implements QueryApi {
  constructor(private readonly graph: Graph) {}

  private node(id: string): GraphNode | undefined {
    return this.graph.nodes.find((n) => n.id === id);
  }

  private render(l: LocatorDescriptor): string {
    if (l.strategy === 'role') return `getByRole('${l.role}', { name: '${l.name ?? ''}' })`;
    if (l.strategy === 'css') return `locator('${l.css}')`;
    return `getByText('${l.name ?? ''}')`;
  }

  getScreen(route: string, state = 'default'): ScreenAnswer | null {
    const routeNode = this.graph.nodes.find(
      (n): n is RouteNode => n.kind === 'route' && n.fullPath === route,
    );
    if (!routeNode) return null;
    const screen = this.graph.nodes.find(
      (n): n is ScreenNode =>
        n.kind === 'screen' && n.routeId === routeNode.id && n.state === state,
    );
    if (!screen) return null;
    const elements = this.graph.edges
      .filter((e) => e.type === 'CONTAINS' && e.from === screen.id)
      .map((e) => this.node(e.to))
      .filter((n): n is ElementNode => !!n && n.kind === 'element')
      .map((n) => ({
        id: n.id,
        role: n.role,
        name: n.name,
        locator: n.locator,
        rendered: this.render(n.locator),
        confidence: n.confidence,
        actions: this.actionsOf(n.id).map((a) => a.detail ?? a.type),
      }));
    return { screen: { route, state }, preconditions: [], elements };
  }

  locatorsFor(query: string): ScreenAnswer['elements'] {
    const q = query.toLowerCase();
    return this.graph.nodes
      .filter((n): n is ElementNode => n.kind === 'element')
      .filter((n) => (n.name ?? '').toLowerCase().includes(q))
      .map((n) => ({
        id: n.id,
        role: n.role,
        name: n.name,
        locator: n.locator,
        rendered: this.render(n.locator),
        confidence: n.confidence,
      }));
  }

  pathTo(target: string, from?: string) {
    const routeNode = this.graph.nodes.find(
      (n): n is RouteNode => n.kind === 'route' && n.fullPath === target,
    );
    if (!routeNode) return null;
    return {
      target: { route: target, state: 'default' },
      steps: [
        { do: 'goto' as const, url: target, note: from ? `from ${from}` : undefined },
      ],
      preconditions: [],
    };
  }

  actionsOf(elementIdOrName: string) {
    const el = this.graph.nodes.find(
      (n): n is ElementNode =>
        n.kind === 'element' && (n.id === elementIdOrName || n.name === elementIdOrName),
    );
    if (!el) return [];
    return this.graph.edges
      .filter((e) => e.type === 'TRIGGERS' && e.from === el.id)
      .map((e) => this.node(e.to))
      .filter((n): n is ActionNode => !!n && n.kind === 'action')
      .map((a) => ({ type: a.type, safety: a.safety, detail: a.detail }));
  }

  staleCheck(files: string[]) {
    const set = new Set(files);
    const staleNodes = this.graph.nodes.filter((n) => n.file && set.has(n.file));
    const staleRoutes = new Set<string>();
    for (const n of staleNodes) {
      if (n.kind === 'route') staleRoutes.add((n as RouteNode).fullPath);
      if (n.kind === 'element') {
        const contains = this.graph.edges.find((e) => e.type === 'CONTAINS' && e.to === n.id);
        const screen = contains && this.node(contains.from);
        if (screen && screen.kind === 'screen') {
          const route = this.node((screen as ScreenNode).routeId);
          if (route && route.kind === 'route') staleRoutes.add((route as RouteNode).fullPath);
        }
      }
    }
    return {
      staleNodeIds: staleNodes.map((n) => n.id),
      staleRoutes: [...staleRoutes].sort(),
      summary: `${staleNodes.length} stale nodes across ${files.length} changed files`,
    };
  }

  explain(nameOrId: string): string | null {
    const n = this.graph.nodes.find(
      (node) => node.id === nameOrId || (node as { name?: string }).name === nameOrId,
    );
    if (!n) return null;
    return `${n.kind} ${(n as { name?: string }).name ?? n.id}: confidence ${n.confidence}, source ${n.source}`;
  }
}

// ---------------------------------------------------------------------------
// Fake store + evidence + services
// ---------------------------------------------------------------------------

export class FakeStore {
  graphs = new Map<string, Graph>();
  saves = 0;

  loadGraph = async (p: string): Promise<Graph> => {
    const g = this.graphs.get(p);
    if (!g) throw new Error(`fake store: no graph at ${p}`);
    return structuredClone(g);
  };

  saveGraph = async (p: string, graph: Graph): Promise<void> => {
    this.saves++;
    this.graphs.set(p, structuredClone(graph));
  };
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    ranAt: '2026-10-17T01:00:00.000Z',
    finalUrl: 'http://localhost:4200/users/5',
    stepResults: [{ ok: true }, { ok: true }],
    requests: [],
    matched: [true],
    ...overrides,
  };
}

export function makePlan(edgeKey: string, overrides: Partial<ProbePlan> = {}): ProbePlan {
  return {
    edgeKey,
    steps: [
      { action: 'goto', url: '/users' },
      { action: 'click', locator: { strategy: 'role', role: 'button', name: 'Add user' } },
    ],
    expect: [{ type: 'url', urlPattern: '/users/\\d+$' }],
    ...overrides,
  };
}

export interface FakeServicesOptions {
  graph?: Graph;
  store?: FakeStore;
  evidence?: Evidence;
  baseUrl?: string;
  runProbe?: Services['runProbe'];
  query?: QueryApi;
}

export function makeFakeServices(opts: FakeServicesOptions = {}): {
  services: Services;
  store: FakeStore;
  probeCalls: ProbePlan[];
} {
  const graph = opts.graph ?? makeFixture().graph;
  const store = opts.store ?? new FakeStore();
  const probeCalls: ProbePlan[] = [];
  const services: Services = {
    query: opts.query ?? new FakeQuery(graph),
    loadGraph: store.loadGraph,
    saveGraph: store.saveGraph,
    adapters: {
      angular: {
        name: 'angular',
        detect: async () => true,
        extract: async () => structuredClone(graph),
      },
    },
    runProbe:
      opts.runProbe ??
      (async (plan) => {
        probeCalls.push(plan);
        return opts.evidence ?? makeEvidence();
      }),
    validatePlan: makeValidatePlan(opts.baseUrl ?? 'http://localhost:4200'),
    checkEvidence,
  };
  return { services, store, probeCalls };
}

// ---------------------------------------------------------------------------
// Temp project dirs
// ---------------------------------------------------------------------------

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uigraph-test-'));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
