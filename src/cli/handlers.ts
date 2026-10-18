/**
 * Pure CLI command handlers. Each takes the injected Services (fakes in tests,
 * src/cli/wire.ts in production), does the work, and returns a CmdResult:
 * `data` for --json, `text` for the tight human line(s). No process.exit, no
 * printing here — src/cli/index.ts owns I/O.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Confidence, Graph, GraphNode, RouteNode, ScreenNode, VerifyTask } from '../types.js';
import { CONFIDENCE_ORDER } from '../types.js';
import {
  buildBundle,
  createTasks,
  enqueueTasks,
  graphPathOf,
  nextTask,
  readConfig,
  queueSummary,
  readTask,
  submitProbe,
  submitReview,
  writeConfig,
} from '../verify/queue.js';
import { exportGraph } from '../core/export.js';
import type { Services } from './services.js';
import { DEFAULT_GRAPH_PATH } from './services.js';

export interface CmdResult {
  ok: boolean;
  data: unknown;
  text: string;
}

export interface HandlerCtx {
  services: Services;
  /** Project root all relative paths resolve against. */
  projectDir: string;
}

const err = (message: string): CmdResult => ({
  ok: false,
  data: { ok: false, error: message },
  text: `error: ${message}`,
});

const unknownAnswer = (what: string): CmdResult => ({
  ok: true,
  data: { unknown: true, query: what },
  text: `unknown: the graph has no fact for "${what}" (not a guess — rebuild or crawl to learn more)`,
});

function resolveOut(ctx: HandlerCtx, out: string): string {
  return path.resolve(ctx.projectDir, out);
}

// ---------------------------------------------------------------------------
// build / crawl / merge
// ---------------------------------------------------------------------------

export async function buildCmd(
  ctx: HandlerCtx,
  dir: string | undefined,
  opts: { adapter?: string; out?: string; bundles?: string; sourceMaps?: boolean; src?: string[] },
): Promise<CmdResult> {
  const name = opts.adapter ?? 'angular';
  const adapter = ctx.services.adapters[name];
  if (!adapter) {
    return err(`unknown adapter "${name}" (available: ${Object.keys(ctx.services.adapters).join(', ') || 'none'})`);
  }
  const projectDir = path.resolve(ctx.projectDir, dir ?? '.');
  const bundles = opts.bundles?.split(',').map((item) => item.trim()).filter(Boolean);
  const src = opts.src && opts.src.length > 0 ? opts.src : readConfig(ctx.projectDir).src;
  const warnings: string[] = [];
  const graph = await adapter.extract(projectDir, {
    ...(bundles && bundles.length > 0 ? { bundles } : {}),
    ...(opts.sourceMaps !== undefined ? { sourceMaps: opts.sourceMaps } : {}),
    ...(src && src.length > 0 ? { src } : {}),
    onWarning: (message) => warnings.push(message),
  });
  const routes = graph.nodes.filter((n) => n.kind === 'route').length;
  if (routes === 0) {
    return err(
      `no routes found in ${projectDir}; an empty graph was not saved` +
        (warnings.length > 0 ? `\n${warnings.map((w) => `  warning: ${w}`).join('\n')}` : '') +
        '\n  hint: point --src at the folder holding the app code',
    );
  }
  const out = resolveOut(ctx, opts.out ?? DEFAULT_GRAPH_PATH);
  await ctx.services.saveGraph(out, graph);
  const data = { out, nodes: graph.nodes.length, edges: graph.edges.length, routes, app: graph.app, warnings };
  const lines = [
    `built ${graph.nodes.length} nodes / ${graph.edges.length} edges (${routes} routes) -> ${out}`,
    ...warnings.map((w) => `warning: ${w}`),
  ];
  return { ok: true, data, text: lines.join('\n') };
}

export async function crawlCmd(
  ctx: HandlerCtx,
  opts: { url?: string; paths?: string; fromGraph?: boolean; out?: string },
): Promise<CmdResult> {
  if (!ctx.services.crawl) return err('crawler not available (src/crawl not wired yet)');
  if (!opts.url) return err('--url <base> is required');
  let fromGraph: Graph | undefined;
  if (opts.fromGraph) {
    fromGraph = await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
  }
  const graph = await ctx.services.crawl({
    baseUrl: opts.url,
    paths: opts.paths ? opts.paths.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
    fromGraph,
  });
  const out = resolveOut(ctx, opts.out ?? '.uigraph/graph-runtime');
  await ctx.services.saveGraph(out, graph);
  const data = { out, nodes: graph.nodes.length, edges: graph.edges.length };
  return { ok: true, data, text: `crawled ${graph.nodes.length} nodes / ${graph.edges.length} edges -> ${out}` };
}

export async function mergeCmd(
  ctx: HandlerCtx,
  opts: { static?: string; runtime?: string; out?: string },
): Promise<CmdResult> {
  if (!ctx.services.merge) return err('core merge not available (src/core/merge not wired yet)');
  const staticGraph = await ctx.services.loadGraph(resolveOut(ctx, opts.static ?? DEFAULT_GRAPH_PATH));
  const runtimeGraph = await ctx.services.loadGraph(resolveOut(ctx, opts.runtime ?? '.uigraph/graph-runtime'));
  const merged = ctx.services.merge(staticGraph, runtimeGraph);
  const out = resolveOut(ctx, opts.out ?? DEFAULT_GRAPH_PATH);
  await ctx.services.saveGraph(out, merged);
  const counts = confidenceCounts(merged);
  const data = { out, nodes: merged.nodes.length, edges: merged.edges.length, byConfidence: counts };
  return { ok: true, data, text: `merged -> ${out} (${fmtCounts(counts)})` };
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

export function screenCmd(ctx: HandlerCtx, route: string, opts: { state?: string }): CmdResult {
  const answer = ctx.services.query.getScreen(route, opts.state);
  if (!answer) return unknownAnswer(`${route}${opts.state ? ` [${opts.state}]` : ''}`);
  const lines = answer.elements.map(
    (e) => `${e.role ?? '?'} "${e.name ?? ''}" (${e.confidence}) -> ${e.rendered}`,
  );
  return {
    ok: true,
    data: answer,
    text: [`screen ${answer.screen.route} [${answer.screen.state}]`, ...lines].join('\n'),
  };
}

export function locatorsCmd(ctx: HandlerCtx, query: string): CmdResult {
  const els = ctx.services.query.locatorsFor(query);
  if (els.length === 0) return unknownAnswer(query);
  return {
    ok: true,
    data: els,
    text: els.map((e) => `${e.id} ${e.role ?? '?'} "${e.name ?? ''}" (${e.confidence}) -> ${e.rendered}`).join('\n'),
  };
}

export function pathCmd(ctx: HandlerCtx, target: string, opts: { from?: string }): CmdResult {
  const answer = ctx.services.query.pathTo(target, opts.from);
  if (!answer) return unknownAnswer(target);
  const steps = answer.steps.map(
    (s, i) => `${i + 1}. ${s.do} ${s.url ?? s.rendered ?? ''}${s.note ? ` — ${s.note}` : ''}`,
  );
  return {
    ok: true,
    data: answer,
    text: [`path to ${answer.target.route} [${answer.target.state}]`, ...steps].join('\n'),
  };
}

export function actionsCmd(ctx: HandlerCtx, element: string): CmdResult {
  const actions = ctx.services.query.actionsOf(element);
  if (actions.length === 0) return unknownAnswer(element);
  return {
    ok: true,
    data: actions,
    text: actions.map((a) => `${a.type} [${a.safety}]${a.detail ? ` ${a.detail}` : ''}`).join('\n'),
  };
}

export function explainCmd(ctx: HandlerCtx, name: string): CmdResult {
  const explanation = ctx.services.query.explain(name);
  if (!explanation) return unknownAnswer(name);
  return { ok: true, data: { name, explanation }, text: explanation };
}

export function impactCmd(ctx: HandlerCtx, opts: { files?: string }): CmdResult {
  const files = (opts.files ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return err('--files a,b is required');
  const answer = ctx.services.query.staleCheck(files);
  return {
    ok: true,
    data: answer,
    text: `${answer.summary}\nstale routes: ${answer.staleRoutes.join(', ') || '(none)'}`,
  };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function confidenceCounts(graph: Graph): Record<Confidence, number> {
  const counts = Object.fromEntries(CONFIDENCE_ORDER.map((c) => [c, 0])) as Record<
    Confidence,
    number
  >;
  for (const n of graph.nodes) counts[n.confidence]++;
  for (const e of graph.edges) counts[e.confidence]++;
  return counts;
}

const fmtCounts = (c: Record<Confidence, number>): string =>
  CONFIDENCE_ORDER.filter((k) => c[k] > 0)
    .map((k) => `${k}:${c[k]}`)
    .join(' ');

function nodeLabel(n: GraphNode): string {
  switch (n.kind) {
    case 'route':
      return (n as RouteNode).fullPath;
    case 'screen': {
      const s = n as ScreenNode;
      return `${s.routeId} [${s.state}]`;
    }
    default: {
      const named = n as { name?: string };
      return named.name ?? n.id;
    }
  }
}

export async function reportCmd(ctx: HandlerCtx, opts: { out?: string }): Promise<CmdResult> {
  let graph: Graph;
  try {
    graph = await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
  } catch (e) {
    return err(`cannot load graph: ${e instanceof Error ? e.message : String(e)}`);
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const routeOf = (id: string): string => {
    const n = nodes.get(id);
    if (!n) return id;
    if (n.kind === 'route') return (n as RouteNode).fullPath;
    if (n.kind === 'screen') {
      const s = n as ScreenNode;
      const r = nodes.get(s.routeId);
      const base = r && r.kind === 'route' ? (r as RouteNode).fullPath : s.routeId;
      return s.state === 'default' ? base : `${base} [${s.state}]`;
    }
    return nodeLabel(n);
  };

  // Hub screens: most inbound NAVIGATES_TO.
  const inbound = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type === 'NAVIGATES_TO') inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  }
  const hubs = [...inbound.entries()]
    .map(([id, count]) => ({ screen: routeOf(id), count }))
    .sort((a, b) => b.count - a.count || a.screen.localeCompare(b.screen))
    .slice(0, 10);

  // A11y: interactive elements with no accessible name.
  const unnamed = graph.nodes
    .filter((n): n is GraphNode & { unnamed?: boolean } => n.kind === 'element')
    .filter((n) => (n as { unnamed?: boolean }).unnamed === true)
    .map((n) => ({ id: n.id, file: n.file, line: n.line }));

  // Ambiguous locators.
  const ambiguous = graph.nodes
    .filter((n) => n.kind === 'element' && n.confidence === 'ambiguous')
    .map((n) => ({ id: n.id, name: (n as { name?: string }).name, file: n.file }));

  // Routes with no COVERED_BY (directly or via their screens/elements).
  const covered = new Set<string>();
  for (const e of graph.edges) if (e.type === 'COVERED_BY') covered.add(e.from);
  const screenRoute = new Map<string, string>();
  for (const e of graph.edges) if (e.type === 'HAS_SCREEN') screenRoute.set(e.to, e.from);
  const coveredRoutes = new Set<string>();
  for (const id of covered) {
    coveredRoutes.add(id);
    const viaScreen = screenRoute.get(id);
    if (viaScreen) coveredRoutes.add(viaScreen);
  }
  const uncoveredRoutes = graph.nodes
    .filter((n): n is RouteNode => n.kind === 'route')
    .filter((r) => !coveredRoutes.has(r.id))
    .map((r) => r.fullPath)
    .sort();

  const counts = confidenceCounts(graph);

  const md = [
    '# uigraph report',
    '',
    `Built ${graph.builtAt} · app ${graph.app.name} (${graph.app.framework}) · ${graph.nodes.length} nodes / ${graph.edges.length} edges`,
    '',
    '## Hub screens (most inbound NAVIGATES_TO)',
    '',
    ...(hubs.length ? hubs.map((h) => `- ${h.screen} — ${h.count} inbound`) : ['(none)']),
    '',
    '## Unnamed interactive elements (a11y findings)',
    '',
    ...(unnamed.length
      ? unnamed.map((u) => `- ${u.id}${u.file ? ` (${u.file}${u.line ? `:${u.line}` : ''})` : ''}`)
      : ['(none)']),
    '',
    '## Ambiguous locators',
    '',
    ...(ambiguous.length
      ? ambiguous.map((a) => `- ${a.id}${a.name ? ` "${a.name}"` : ''}${a.file ? ` (${a.file})` : ''}`)
      : ['(none)']),
    '',
    '## Routes with no COVERED_BY',
    '',
    ...(uncoveredRoutes.length ? uncoveredRoutes.map((r) => `- ${r}`) : ['(none)']),
    '',
    '## Counts by confidence (nodes + edges)',
    '',
    '| confidence | count |',
    '| --- | --- |',
    ...CONFIDENCE_ORDER.map((c) => `| ${c} | ${counts[c]} |`),
    '',
  ].join('\n');

  const out = resolveOut(ctx, opts.out ?? 'GRAPH_REPORT.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  const data = {
    out,
    hubs: hubs.length,
    unnamed: unnamed.length,
    ambiguous: ambiguous.length,
    uncoveredRoutes: uncoveredRoutes.length,
    byConfidence: counts,
  };
  return {
    ok: true,
    data,
    text: `report -> ${out} (${hubs.length} hubs, ${unnamed.length} unnamed, ${ambiguous.length} ambiguous, ${uncoveredRoutes.length} uncovered routes; ${fmtCounts(counts)})`,
  };
}

export async function exportCmd(ctx: HandlerCtx, opts: { out?: string }): Promise<CmdResult> {
  let graph: Graph;
  try {
    graph = await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
  } catch (e) {
    return err(`cannot load graph: ${e instanceof Error ? e.message : String(e)}`);
  }
  const written = exportGraph(graph, resolveOut(ctx, opts.out ?? '.uigraph/export'));
  return {
    ok: true,
    data: written,
    text: `export -> ${written.graphJson}`,
  };
}

// ---------------------------------------------------------------------------
// verify queue
// ---------------------------------------------------------------------------

export async function verifyCmd(
  ctx: HandlerCtx,
  opts: { baseUrl?: string; max?: string | number },
): Promise<CmdResult> {
  let graph: Graph;
  try {
    graph = await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
  } catch (e) {
    return err(`cannot load graph: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (opts.baseUrl) writeConfig(ctx.projectDir, { baseUrl: opts.baseUrl });
  let tasks = createTasks(graph);
  const max = typeof opts.max === 'string' ? Number.parseInt(opts.max, 10) : opts.max;
  if (max && Number.isFinite(max)) tasks = tasks.slice(0, max);
  const { created, skipped } = enqueueTasks(ctx.projectDir, tasks);
  const summary = queueSummary(ctx.projectDir);
  const data = { created, skipped, queue: summary };
  return {
    ok: true,
    data,
    text: `queued ${created} new tasks (${skipped} already queued); queue: ${summary.open} open, ${summary.leased} leased, ${summary.done} done (${summary.verify_edge} verify_edge / ${summary.review_edge} review_edge)`,
  };
}

/** Lease the oldest open task and attach its bundle when the graph is loadable. */
export async function taskNextCmd(ctx: HandlerCtx): Promise<CmdResult> {
  const task = nextTask(ctx.projectDir);
  if (!task) return { ok: true, data: { task: null }, text: 'queue empty: no open tasks' };
  let bundle: string | undefined;
  try {
    const graph = await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
    bundle = buildBundle(graph, task.edgeKey, ctx.projectDir);
  } catch {
    /* graph not available: hand out the task without a bundle */
  }
  const withBundle: VerifyTask = bundle ? { ...task, bundle } : task;
  return {
    ok: true,
    data: withBundle,
    text: `task ${withBundle.id} (${withBundle.type}) leased until ${withBundle.leaseUntil}\nedge: ${withBundle.edgeKey}`,
  };
}

export async function taskSubmitCmd(
  ctx: HandlerCtx,
  taskId: string,
  opts: { plan?: string },
): Promise<CmdResult> {
  if (!opts.plan) return err('--plan <plan.json> is required');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(ctx.projectDir, opts.plan), 'utf8'));
  } catch (e) {
    return err(`cannot read plan file: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const result = await submitProbe(ctx.projectDir, taskId, raw, ctx.services);
    const data = {
      taskId,
      status: result.task.status,
      verdict: result.verdict ?? null,
      mode: result.mode,
      recipe: result.recipePath,
      graphUpdated: result.graphUpdated,
    };
    return {
      ok: true,
      data,
      text:
        result.mode === 'executed'
          ? `task ${taskId} done: ${result.verdict} (graph ${result.graphUpdated ? 'updated' : 'unchanged'}; recipe ${result.recipePath})`
          : `task ${taskId} done: plan stored as recipe (no baseUrl configured) -> ${result.recipePath}`,
    };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export async function taskReviewCmd(
  ctx: HandlerCtx,
  taskId: string,
  opts: { likely?: string | boolean; reasoning?: string },
): Promise<CmdResult> {
  if (opts.likely === undefined || !opts.reasoning) {
    return err('--likely true|false and --reasoning "..." are required');
  }
  const likely = typeof opts.likely === 'boolean' ? opts.likely : opts.likely === 'true';
  try {
    const result = await submitReview(ctx.projectDir, taskId, { likely, reasoning: opts.reasoning }, ctx.services);
    const data = {
      taskId,
      status: result.task.status,
      confidence: result.confidence ?? null,
      recipe: result.recipePath,
      graphUpdated: result.graphUpdated,
    };
    return {
      ok: true,
      data,
      text: `task ${taskId} reviewed (likely=${likely}); edge confidence: ${result.confidence ?? 'unchanged/unknown'} (capped at ai_reviewed, never verified)`,
    };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function taskShowCmd(ctx: HandlerCtx, taskId: string): CmdResult {
  const task = readTask(ctx.projectDir, taskId);
  if (!task) return err(`no such task: ${taskId}`);
  return { ok: true, data: task, text: `task ${task.id} (${task.type}) ${task.status}${task.verdict ? ` — ${task.verdict}` : ''}` };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export function installCmd(opts: {
  /** skills/uigraph source directory (resolved by the caller). */
  srcDir: string;
  /** Install into the current project instead of the home directory. */
  project?: boolean;
  homeDir: string;
  projectDir: string;
}): CmdResult {
  if (!fs.existsSync(opts.srcDir)) return err(`skill source not found: ${opts.srcDir}`);
  const root = opts.project ? opts.projectDir : opts.homeDir;
  const dests = [
    path.join(root, '.claude', 'skills', 'uigraph'),
    path.join(root, '.agents', 'skills', 'uigraph'),
  ];
  const written: string[] = [];
  for (const dest of dests) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(opts.srcDir, dest, { recursive: true });
    written.push(dest);
  }
  return {
    ok: true,
    data: { written },
    text: written.map((w) => `wrote ${w}`).join('\n'),
  };
}
