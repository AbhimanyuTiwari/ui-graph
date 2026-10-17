/**
 * uigraph MCP server (stdio). Thin SDK shell over the pure handlers in
 * src/mcp/handlers.ts — tests exercise the handlers, not a live session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Services } from '../cli/services.js';
import { createMcpHandlers } from './handlers.js';

const TRUTH =
  'The uigraph graph is the source of truth: answers are verified facts or an ' +
  "explicit 'unknown' — never guess beyond them.";

export interface McpServerOptions {
  services: Services;
  projectDir: string;
}

export function buildMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'uigraph', version: '0.1.0' });
  const h = createMcpHandlers(options);
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

  server.registerTool(
    'get_screen',
    {
      description: `Elements, locators and preconditions of one screen (route + state). ${TRUTH}`,
      inputSchema: { route: z.string(), state: z.string().optional() },
    },
    async (args) => text(await h.get_screen(args)),
  );

  server.registerTool(
    'locators_for',
    {
      description: `Verified locators matching a text query (e.g. "save button on /users"). ${TRUTH}`,
      inputSchema: { query: z.string() },
    },
    async (args) => text(await h.locators_for(args)),
  );

  server.registerTool(
    'path_to',
    {
      description: `Navigation steps (goto/click) to reach a target screen. ${TRUTH}`,
      inputSchema: { target: z.string(), from: z.string().optional() },
    },
    async (args) => text(await h.path_to(args)),
  );

  server.registerTool(
    'actions_of',
    {
      description: `What an element does when triggered (action type + safety class). ${TRUTH}`,
      inputSchema: { element: z.string() },
    },
    async (args) => text(await h.actions_of(args)),
  );

  server.registerTool(
    'stale_check',
    {
      description: `Which graph facts a set of changed files makes stale. ${TRUTH}`,
      inputSchema: { files: z.array(z.string()) },
    },
    async (args) => text(await h.stale_check(args)),
  );

  server.registerTool(
    'explain',
    {
      description: `Explain one node (route/screen/element/action) by name or id. ${TRUTH}`,
      inputSchema: { name: z.string() },
    },
    async (args) => text(await h.explain(args)),
  );

  server.registerTool(
    'next_task',
    {
      description:
        `Lease the oldest open verification task (10 min lease) with its context bundle. ` +
        `verify_edge: reply with submit_probe; review_edge: reply with submit_review. ${TRUTH}`,
      inputSchema: {},
    },
    async () => text(await h.next_task({})),
  );

  server.registerTool(
    'get_bundle',
    {
      description: `Compact context bundle for a task: the edge, its nodes, source lines, and the probe-plan instructions. ${TRUTH}`,
      inputSchema: { taskId: z.string() },
    },
    async (args) => text(await h.get_bundle(args)),
  );

  server.registerTool(
    'submit_probe',
    {
      description:
        `Submit a probe plan for a verify_edge task. uigraph validates it (safety rules: no destructive ` +
        `clicks, on-origin only), executes it in a real browser, and judges the evidence — the plan is a ` +
        `proposal, never a fact. ${TRUTH}`,
      inputSchema: { taskId: z.string(), plan: z.unknown() },
    },
    async (args) => text(await h.submit_probe(args)),
  );

  server.registerTool(
    'submit_review',
    {
      description:
        `Submit a read-the-code judgment for a review_edge task. Capped at confidence 'ai_reviewed' — ` +
        `a hint, never 'verified'. ${TRUTH}`,
      inputSchema: { taskId: z.string(), likely: z.boolean(), reasoning: z.string() },
    },
    async (args) => text(await h.submit_review(args)),
  );

  return server;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const server = buildMcpServer(options);
  await server.connect(new StdioServerTransport());
}
