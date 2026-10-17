/**
 * Real wiring of the Services object. The core/adapters/crawl modules are
 * being written concurrently and may not exist on disk yet, so:
 *
 *  - compile-time: only `import type` from frozen contracts; every real module
 *    is reached through a *computed* dynamic import (`import(new URL(...).href)`),
 *    which tsc types as Promise<any> and never tries to resolve — this file
 *    typechecks with the other agents' files absent;
 *  - run-time: each import is wrapped in try/catch. A missing module degrades
 *    to a stub that throws a clear 'not wired yet' error only when that
 *    capability is actually used (optional capabilities become undefined).
 *
 * Expected module paths/exports at integration (first match wins):
 *   ../core/store.js    loadGraph|load|readGraph / saveGraph|save|writeGraph
 *   ../core/query.js    createQuery|buildQuery|makeQuery|queryApi (graph) => QueryApi
 *   ../core/merge.js    merge|mergeGraphs (a, b) => Graph
 *   ../adapters/angular/index.js  any export shaped like FrameworkAdapter
 *   ../crawl/index.js   crawl|runCrawl (options) => Promise<Graph>
 *   ../crawl/probe.js   runProbe|probe|executeProbe / checkEvidence|judgeEvidence
 */
import type {
  Evidence,
  FrameworkAdapter,
  Graph,
  ProbePlan,
  QueryApi,
  Verdict,
} from '../types.js';
import { checkEvidence as localCheckEvidence, makeValidatePlan } from '../verify/validate.js';
import { graphPathOf, readConfig } from '../verify/queue.js';
import type { CrawlOptions, Services } from './services.js';

type AnyModule = Record<string, unknown>;

async function tryImport(relPath: string): Promise<AnyModule | null> {
  try {
    const href = new URL(relPath, import.meta.url).href;
    const mod: unknown = await import(href);
    return mod as AnyModule;
  } catch {
    return null;
  }
}

function pickFn<T>(mod: AnyModule | null, names: string[]): T | undefined {
  if (!mod) return undefined;
  for (const name of names) {
    const value = mod[name];
    if (typeof value === 'function') return value as T;
  }
  const dflt = mod['default'];
  if (dflt && typeof dflt === 'object') return pickFn<T>(dflt as AnyModule, names);
  return undefined;
}

function notWired(what: string, module: string): never {
  throw new Error(`${what} not wired yet: ${module} is missing or exports an unexpected shape (integration pending)`);
}

function isAdapter(value: unknown): value is FrameworkAdapter {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as FrameworkAdapter).name === 'string' &&
    typeof (value as FrameworkAdapter).detect === 'function' &&
    typeof (value as FrameworkAdapter).extract === 'function'
  );
}

function throwingQuery(reason: string): QueryApi {
  const boom = (): never => {
    throw new Error(reason);
  };
  return {
    getScreen: boom,
    locatorsFor: boom,
    pathTo: boom,
    actionsOf: boom,
    staleCheck: boom,
    explain: boom,
  };
}

/** Build the production Services for a project directory. */
export async function createServices(projectDir: string): Promise<Services> {
  const config = readConfig(projectDir);

  const storeMod = await tryImport('../core/store.js');
  const loadGraphFn = pickFn<(p: string) => Promise<Graph>>(storeMod, [
    'loadGraph',
    'load',
    'readGraph',
  ]);
  const saveGraphFn = pickFn<(p: string, g: Graph) => Promise<void>>(storeMod, [
    'saveGraph',
    'save',
    'writeGraph',
  ]);
  const loadGraph = async (p: string): Promise<Graph> =>
    loadGraphFn ? loadGraphFn(p) : notWired('graph store', 'src/core/store');
  const saveGraph = async (p: string, g: Graph): Promise<void> =>
    saveGraphFn ? saveGraphFn(p, g) : notWired('graph store', 'src/core/store');

  // Query API: QueryApi is synchronous, so the graph is loaded up front when
  // it exists; otherwise every query throws a clear 'no graph' error.
  let query: QueryApi = throwingQuery(
    `no graph loaded at ${graphPathOf(projectDir)} — run "uigraph build" first`,
  );
  const queryMod = await tryImport('../core/query.js');
  const queryFactory = pickFn<(g: Graph) => QueryApi>(queryMod, [
    'createQuery',
    'buildQuery',
    'makeQuery',
    'makeQueryApi',
    'queryApi',
  ]);
  if (queryFactory && loadGraphFn) {
    try {
      query = queryFactory(await loadGraphFn(graphPathOf(projectDir)));
    } catch {
      /* graph not built yet: keep the throwing stub */
    }
  } else if (!queryFactory) {
    query = throwingQuery('query engine not wired yet: src/core/query is missing (integration pending)');
  }

  const adapters: Record<string, FrameworkAdapter> = {};
  const angularMod = await tryImport('../adapters/angular/index.js');
  if (angularMod) {
    const candidates = [angularMod['angularAdapter'], angularMod['adapter'], angularMod['default'], ...Object.values(angularMod)];
    const found = candidates.find(isAdapter);
    if (found) adapters[found.name] = found;
  }
  const nextMod = await tryImport('../adapters/next/index.js');
  if (nextMod) {
    const candidates = [nextMod['nextAdapter'], nextMod['adapter'], nextMod['default'], ...Object.values(nextMod)];
    const found = candidates.find(isAdapter);
    if (found) adapters[found.name] = found;
  }

  const crawlMod = await tryImport('../crawl/index.js');
  const crawlFn = pickFn<(o: CrawlOptions) => Promise<Graph>>(crawlMod, ['crawl', 'runCrawl']);

  const probeMod = await tryImport('../crawl/probe.js');
  const runProbeFn = pickFn<(plan: ProbePlan, baseUrl: string) => Promise<Evidence>>(probeMod, [
    'runProbe',
    'probe',
    'executeProbe',
  ]);
  const checkEvidenceFn =
    pickFn<(plan: ProbePlan, evidence: Evidence) => Verdict>(probeMod, [
      'checkEvidence',
      'judgeEvidence',
    ]) ?? localCheckEvidence;

  return {
    query,
    loadGraph,
    saveGraph,
    adapters,
    runProbe: async (plan, baseUrl) =>
      runProbeFn ? runProbeFn(plan, baseUrl) : notWired('probe runner', 'src/crawl/probe'),
    validatePlan: makeValidatePlan(config.baseUrl),
    checkEvidence: checkEvidenceFn,
    crawl: crawlFn,
    merge: pickFn<(a: Graph, b: Graph) => Graph>(await tryImport('../core/merge.js'), [
      'merge',
      'mergeGraphs',
    ]),
  };
}
