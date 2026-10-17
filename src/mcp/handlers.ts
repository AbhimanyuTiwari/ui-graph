/**
 * Pure MCP tool handlers: (args) => compact JSON string, each capped to stay
 * under ~1k tokens (structural truncation first, note appended when trimmed).
 * src/mcp/server.ts wraps these with the SDK; tests call them directly with
 * fake Services.
 */
import type { Services } from '../cli/services.js';
import {
  buildBundle,
  graphPathOf,
  nextTask,
  readTask,
  submitProbe,
  submitReview,
} from '../verify/queue.js';
import type { Graph } from '../types.js';

export interface McpCtx {
  services: Services;
  projectDir: string;
}

// ~1k tokens ≈ 4000 chars.
const CHAR_LIMIT = 4000;

function shrinkArrays(value: unknown, keep: number): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, keep).map((v) => shrinkArrays(v, keep));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shrinkArrays(v, keep);
    }
    return out;
  }
  return value;
}

/** Compact JSON, truncated with an explicit note when it would exceed the cap. */
export function compactJson(value: unknown): string {
  const full = JSON.stringify(value);
  if (full.length <= CHAR_LIMIT) return full;
  const note = 'response truncated to stay compact; refine your query';
  for (const keep of [10, 5, 2]) {
    const shrunk = shrinkArrays(value, keep);
    const wrapped = Array.isArray(shrunk)
      ? { items: shrunk, truncated: true, note }
      : { ...(shrunk as Record<string, unknown>), truncated: true, note };
    const json = JSON.stringify(wrapped);
    if (json.length <= CHAR_LIMIT) return json;
  }
  return JSON.stringify({
    truncated: true,
    note: 'response too large; refine your query',
    preview: full.slice(0, CHAR_LIMIT - 200),
  });
}

const unknown = (query: string): string =>
  compactJson({
    unknown: true,
    query,
    note: 'the graph has no fact for this — an explicit unknown, not a guess',
  });

async function loadGraphOrNull(ctx: McpCtx): Promise<Graph | null> {
  try {
    return await ctx.services.loadGraph(graphPathOf(ctx.projectDir));
  } catch {
    return null;
  }
}

const errJson = (e: unknown): string =>
  compactJson({ ok: false, error: e instanceof Error ? e.message : String(e) });

export interface McpHandlers {
  get_screen(args: { route: string; state?: string }): Promise<string>;
  locators_for(args: { query: string }): Promise<string>;
  path_to(args: { target: string; from?: string }): Promise<string>;
  actions_of(args: { element: string }): Promise<string>;
  stale_check(args: { files: string[] }): Promise<string>;
  explain(args: { name: string }): Promise<string>;
  next_task(args: Record<string, never>): Promise<string>;
  get_bundle(args: { taskId: string }): Promise<string>;
  submit_probe(args: { taskId: string; plan: unknown }): Promise<string>;
  submit_review(args: { taskId: string; likely: boolean; reasoning: string }): Promise<string>;
}

export function createMcpHandlers(ctx: McpCtx): McpHandlers {
  return {
    async get_screen({ route, state }) {
      try {
        const answer = ctx.services.query.getScreen(route, state);
        return answer ? compactJson(answer) : unknown(`${route}${state ? ` [${state}]` : ''}`);
      } catch (e) {
        return errJson(e);
      }
    },

    async locators_for({ query }) {
      try {
        const els = ctx.services.query.locatorsFor(query);
        return els.length ? compactJson(els) : unknown(query);
      } catch (e) {
        return errJson(e);
      }
    },

    async path_to({ target, from }) {
      try {
        const answer = ctx.services.query.pathTo(target, from);
        return answer ? compactJson(answer) : unknown(target);
      } catch (e) {
        return errJson(e);
      }
    },

    async actions_of({ element }) {
      try {
        const actions = ctx.services.query.actionsOf(element);
        return actions.length ? compactJson(actions) : unknown(element);
      } catch (e) {
        return errJson(e);
      }
    },

    async stale_check({ files }) {
      try {
        return compactJson(ctx.services.query.staleCheck(files));
      } catch (e) {
        return errJson(e);
      }
    },

    async explain({ name }) {
      try {
        const explanation = ctx.services.query.explain(name);
        return explanation ? compactJson({ name, explanation }) : unknown(name);
      } catch (e) {
        return errJson(e);
      }
    },

    async next_task() {
      try {
        const task = nextTask(ctx.projectDir);
        if (!task) return compactJson({ task: null, note: 'queue empty: no open tasks' });
        const graph = await loadGraphOrNull(ctx);
        const bundle = graph ? buildBundle(graph, task.edgeKey, ctx.projectDir) : undefined;
        return compactJson(bundle ? { ...task, bundle } : task);
      } catch (e) {
        return errJson(e);
      }
    },

    async get_bundle({ taskId }) {
      try {
        const task = readTask(ctx.projectDir, taskId);
        if (!task) return errJson(new Error(`no such task: ${taskId}`));
        if (task.bundle) return compactJson({ taskId, bundle: task.bundle });
        const graph = await loadGraphOrNull(ctx);
        if (!graph) return errJson(new Error('graph not available; run uigraph build first'));
        return compactJson({ taskId, bundle: buildBundle(graph, task.edgeKey, ctx.projectDir) });
      } catch (e) {
        return errJson(e);
      }
    },

    async submit_probe({ taskId, plan }) {
      try {
        const result = await submitProbe(ctx.projectDir, taskId, plan, ctx.services);
        return compactJson({
          taskId,
          status: result.task.status,
          verdict: result.verdict ?? null,
          mode: result.mode,
          graphUpdated: result.graphUpdated,
        });
      } catch (e) {
        return errJson(e);
      }
    },

    async submit_review({ taskId, likely, reasoning }) {
      try {
        const result = await submitReview(ctx.projectDir, taskId, { likely, reasoning }, ctx.services);
        return compactJson({
          taskId,
          status: result.task.status,
          confidence: result.confidence ?? null,
          graphUpdated: result.graphUpdated,
          note: 'AI review caps at ai_reviewed; only probes can verify',
        });
      } catch (e) {
        return errJson(e);
      }
    },
  };
}
