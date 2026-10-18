/**
 * Dependency-injection seam between the CLI/MCP/verify layers (this side) and
 * the core/adapters/crawl modules other agents are building concurrently.
 *
 * Command handlers and MCP tool handlers only ever see this `Services` object.
 * Tests inject in-memory fakes; `src/cli/wire.ts` builds the real thing with
 * deferred dynamic imports so this side compiles and tests without the other
 * modules existing on disk.
 */
import type {
  Evidence,
  FrameworkAdapter,
  Graph,
  ProbePlan,
  QueryApi,
  Verdict,
} from '../types.js';

export interface CrawlOptions {
  baseUrl: string;
  /** Explicit path list to visit. */
  paths?: string[];
  /** Seed the crawl from an existing (static) graph. */
  fromGraph?: Graph;
}

export interface Services {
  /**
   * Query API bound to the currently loaded graph. When no graph has been
   * built yet, every method throws a 'no graph' error (callers surface it).
   */
  query: QueryApi;
  loadGraph(path: string): Promise<Graph>;
  saveGraph(path: string, graph: Graph): Promise<void>;
  /** Framework adapters by name ('angular', ...). */
  adapters: Record<string, FrameworkAdapter>;
  /** Executes a validated probe plan in a real browser. uigraph judges, not AI. */
  runProbe(plan: ProbePlan, baseUrl: string): Promise<Evidence>;
  /** Validates untrusted agent output (zod + safety rules). Throws on reject. */
  validatePlan(plan: unknown): ProbePlan;
  /** Deterministic judgment of probe evidence against the plan. */
  checkEvidence(plan: ProbePlan, evidence: Evidence): Verdict;
  /** Optional until integration: the Playwright crawler. */
  crawl?(options: CrawlOptions): Promise<Graph>;
  /** Optional until integration: core merge (static + runtime -> promoted). */
  merge?(staticGraph: Graph, runtimeGraph: Graph): Graph;
}

/** Persisted at <projectDir>/.uigraph/config.json. */
export interface UigraphConfig {
  baseUrl?: string;
  /** Where the merged graph lives, relative to the project dir. */
  graphPath?: string;
  /** Source globs/dirs the adapter scans, relative to the built project dir. */
  src?: string[];
}

export const DEFAULT_GRAPH_PATH = '.uigraph/graph';
