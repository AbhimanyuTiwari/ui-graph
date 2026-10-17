/**
 * Shared internal model for the Angular adapter: the mutable extraction
 * context all phases write into, plus small deterministic helpers.
 * Only src/types.ts and src/core/ids.ts are imported from outside the adapter.
 */
import path from 'node:path';
import type { ClassDeclaration, Project } from 'ts-morph';
import {
  CONFIDENCE_ORDER,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
  edgeKey,
} from '../../types.js';

/** A component class found in the project, with its template resolved. */
export interface ComponentInfo {
  className: string;
  cls: ClassDeclaration;
  selector?: string;
  standalone: boolean;
  /** Repo-relative path of the .ts file. */
  file: string;
  /** Template text (inline or read from templateUrl); undefined when absent. */
  template?: string;
  /** Repo-relative path holding the template (the .ts file for inline ones). */
  templateFile?: string;
}

/** A template element (or screen) that triggers component methods. */
export interface HandlerRef {
  /** Node that TRIGGERS the resulting actions (element or screen id). */
  sourceId: string;
  componentName: string;
  /** Route the hosting screen belongs to (for modal screens etc.). */
  routeId: string;
  /** Method names invoked by the template event bindings ('onSubmit'). */
  methods: string[];
  /** Accessible name / visible text, used by the safety classifier. */
  elementText?: string;
  /** Static routerLink value on the element, if any. */
  routerLink?: string;
  /** External href on the element, if any. */
  externalHref?: string;
}

/** Mutable state threaded through the extraction phases. */
export interface Ctx {
  projectDir: string;
  project: Project;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Absolute paths of every file whose content shaped the graph. */
  parsedFiles: Set<string>;
  /** className -> info, for every @Component class under src/. */
  components: Map<string, ComponentInfo>;
  routes: RouteNode[];
  handlers: HandlerRef[];
}

const strength = (c: Confidence): number => {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return i === -1 ? CONFIDENCE_ORDER.length : i;
};

/** Add a node; on id collision keep the stronger-confidence claim. */
export function addNode<T extends GraphNode>(ctx: Ctx, node: T): T {
  const existing = ctx.nodes.get(node.id);
  if (!existing || strength(node.confidence) < strength(existing.confidence)) {
    ctx.nodes.set(node.id, node);
    return node;
  }
  return existing as T;
}

/** Add an edge; on identity collision keep the stronger-confidence claim. */
export function addEdge(ctx: Ctx, edge: GraphEdge): void {
  const key = edgeKey(edge);
  const existing = ctx.edges.get(key);
  if (!existing || strength(edge.confidence) < strength(existing.confidence)) {
    ctx.edges.set(key, edge);
  }
}

/** Repo-relative posix path (stable across machines for fileHashes/node.file). */
export function rel(ctx: Ctx, absPath: string): string {
  return path.relative(ctx.projectDir, absPath).split(path.sep).join('/');
}

/** Join route path segments into a '/'-rooted full path ('' segments vanish). */
export function joinRoutePath(prefix: string, segment: string): string {
  const parts = [prefix, segment]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

/** ':id' param names of a full path, in order. */
export function paramNamesOf(fullPath: string): string[] {
  return fullPath
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));
}

/** Collapse whitespace in template-derived text. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
