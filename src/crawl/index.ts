/**
 * Crawl entry used by the CLI. The crawler itself requires an explicit path
 * list; when the caller passes a static graph instead, paths come from its
 * non-redirect routes.
 */
import type { Graph, RouteNode } from '../types.js';
import { crawl as crawlPaths, type CrawlOptions } from './crawler.js';

export interface CrawlRunOptions {
  baseUrl: string;
  paths?: string[];
  fromGraph?: Graph;
  allowHosts?: string[];
  maxClicksPerPage?: number;
}

function pathsFromGraph(graph: Graph): string[] {
  return [
    ...new Set(
      graph.nodes
        .filter((n): n is RouteNode => n.kind === 'route' && !n.redirectTo)
        .map((r) => r.fullPath),
    ),
  ].sort();
}

export async function crawl(opts: CrawlRunOptions): Promise<Graph> {
  const paths = opts.paths && opts.paths.length > 0 ? opts.paths : opts.fromGraph ? pathsFromGraph(opts.fromGraph) : [];
  if (paths.length === 0) {
    throw new Error('crawl needs --paths or a graph that already has routes');
  }
  const raw: CrawlOptions = {
    baseUrl: opts.baseUrl,
    paths,
    ...(opts.allowHosts ? { allowHosts: opts.allowHosts } : {}),
    ...(opts.maxClicksPerPage !== undefined ? { maxClicksPerPage: opts.maxClicksPerPage } : {}),
  };
  return crawlPaths(raw);
}

export { runProbe, checkEvidence, validatePlan } from './probe.js';
