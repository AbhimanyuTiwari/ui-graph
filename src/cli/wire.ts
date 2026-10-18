/**
 * Real wiring of the Services object. Every module is imported statically, so a
 * missing or mis-built module fails loudly at startup instead of degrading to a
 * "not wired" stub.
 */
import type { Graph, QueryApi } from '../types.js';
import { angularAdapter } from '../adapters/angular/index.js';
import { nextAdapter } from '../adapters/next/index.js';
import { mergeGraphs } from '../core/merge.js';
import { makeQueryApi } from '../core/query.js';
import { loadGraph, saveGraph } from '../core/store.js';
import { crawl } from '../crawl/index.js';
import { checkEvidence, runProbe } from '../crawl/probe.js';
import { graphPathOf, readConfig } from '../verify/queue.js';
import { makeValidatePlan } from '../verify/validate.js';
import type { Services } from './services.js';

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

  // QueryApi is synchronous, so the graph is loaded up front when it exists;
  // otherwise every query throws a clear 'no graph' error.
  let query: QueryApi = throwingQuery(
    `no graph loaded at ${graphPathOf(projectDir)} — run "uigraph build" first`,
  );
  try {
    query = makeQueryApi(loadGraph(graphPathOf(projectDir)));
  } catch {
    /* graph not built yet: keep the throwing stub */
  }

  return {
    query,
    loadGraph: async (p: string): Promise<Graph> => loadGraph(p),
    saveGraph: async (p: string, g: Graph): Promise<void> => saveGraph(p, g),
    adapters: { [angularAdapter.name]: angularAdapter, [nextAdapter.name]: nextAdapter },
    runProbe,
    validatePlan: makeValidatePlan(config.baseUrl),
    checkEvidence,
    crawl,
    merge: mergeGraphs,
  };
}
