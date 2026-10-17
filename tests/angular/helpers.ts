/**
 * Shared test plumbing for the Angular adapter suite: extracts the fixture app
 * once and exposes typed lookups over the resulting graph.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ActionNode,
  ApiEndpointNode,
  ElementNode,
  FormNode,
  Graph,
  GraphEdge,
  PreconditionNode,
  RouteNode,
  ScreenNode,
} from '../../src/types';
import { angularAdapter } from '../../src/adapters/angular';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, '../../fixtures/angular-app');

export const golden = JSON.parse(
  readFileSync(path.resolve(here, '../../evals/angular-golden.json'), 'utf8'),
) as Record<string, never> & {
  app: { name: string; framework: string };
  routes: {
    count: number;
    fullPaths: string[];
    redirect: { fullPath: string; redirectTo: string };
    lazyParent: { fullPath: string; lazy: boolean; componentName: string | null };
    lazyChild: { fullPath: string; componentName: string; confidence: string };
    loadComponent: { fullPath: string; lazy: boolean; componentName: string };
    paramNames: Record<string, string[]>;
  };
  guards: {
    guardedFullPaths: string[];
    precondition: { type: string; detail: string };
  };
  loginButton: { locator: { strategy: string; role: string; name: string } };
  emailField: {
    locator: { strategy: string; name: string };
    attrs: Record<string, string>;
  };
  editButton: { name: string; collection: { keyHint: string } };
  unnamedButton: { component: string; handler: string };
  deleteAction: {
    handler: string;
    safety: string;
    api: { method: string; urlPattern: string };
  };
  saveAction: {
    handler: string;
    safety: string;
    api: { method: string; urlPattern: string };
  };
  serviceHop: {
    handler: string;
    api: { method: string; urlPattern: string };
    confidence: string;
  };
  loginFlow: {
    handler: string;
    api: { method: string; urlPattern: string };
    navigateTo: string;
  };
  screenStates: Record<string, string[]>;
  modal: { route: string; state: string };
  externalAction: { handler: string; type: string };
  forms: Record<string, Record<string, string[]>>;
};

let cached: Promise<Graph> | undefined;

/** Extract the fixture once per test run (each test file shares the result). */
export function getGraph(): Promise<Graph> {
  cached ??= angularAdapter.extract(FIXTURE_DIR);
  return cached;
}

// -- typed node lookups -------------------------------------------------------

export const routesOf = (g: Graph): RouteNode[] =>
  g.nodes.filter((n): n is RouteNode => n.kind === 'route');

export const routeByFullPath = (g: Graph, fullPath: string): RouteNode | undefined =>
  routesOf(g).find((r) => r.fullPath === fullPath && !r.redirectTo);

export const screensOf = (g: Graph): ScreenNode[] =>
  g.nodes.filter((n): n is ScreenNode => n.kind === 'screen');

export const elementsOf = (g: Graph): ElementNode[] =>
  g.nodes.filter((n): n is ElementNode => n.kind === 'element');

export const actionsOf = (g: Graph): ActionNode[] =>
  g.nodes.filter((n): n is ActionNode => n.kind === 'action');

export const apisOf = (g: Graph): ApiEndpointNode[] =>
  g.nodes.filter((n): n is ApiEndpointNode => n.kind === 'api');

export const formsOf = (g: Graph): FormNode[] =>
  g.nodes.filter((n): n is FormNode => n.kind === 'form');

export const preconditionsOf = (g: Graph): PreconditionNode[] =>
  g.nodes.filter((n): n is PreconditionNode => n.kind === 'precondition');

export const edges = (g: Graph, type: GraphEdge['type']): GraphEdge[] =>
  g.edges.filter((e) => e.type === type);

/** Screen states registered for a route fullPath. */
export function statesFor(g: Graph, fullPath: string): string[] {
  const route = routeByFullPath(g, fullPath);
  if (!route) return [];
  return screensOf(g)
    .filter((s) => s.routeId === route.id)
    .map((s) => s.state)
    .sort();
}

/** Actions reachable from a handler like 'UserDetailComponent.onDelete'. */
export const actionsByHandler = (g: Graph, handler: string): ActionNode[] =>
  actionsOf(g).filter((a) => a.handler === handler);
