#!/usr/bin/env node
/**
 * uigraph CLI (commander). Thin shell: parse argv, build Services via wire.ts,
 * call the pure handler, print compact JSON (--json) or tight text.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  actionsCmd,
  buildCmd,
  crawlCmd,
  explainCmd,
  impactCmd,
  installCmd,
  locatorsCmd,
  mergeCmd,
  pathCmd,
  reportCmd,
  screenCmd,
  taskNextCmd,
  taskReviewCmd,
  taskShowCmd,
  taskSubmitCmd,
  verifyCmd,
  type CmdResult,
  type HandlerCtx,
} from './handlers.js';
import { createServices } from './wire.js';

const program = new Command();
program
  .name('uigraph')
  .description('Deterministic UI knowledge graph for AI test agents')
  .option('--json', 'print compact JSON instead of text')
  .version('0.1.0');

function print(result: CmdResult): void {
  const json = Boolean(program.opts<{ json?: boolean }>().json);
  if (json) {
    console.log(JSON.stringify(result.ok ? result.data : result.data));
  } else {
    console.log(result.text);
  }
  if (!result.ok) process.exitCode = 1;
}

async function ctx(): Promise<HandlerCtx> {
  const projectDir = process.cwd();
  return { services: await createServices(projectDir), projectDir };
}

const run =
  (fn: (c: HandlerCtx) => CmdResult | Promise<CmdResult>) => async (): Promise<void> => {
    try {
      print(await fn(await ctx()));
    } catch (e) {
      print({
        ok: false,
        data: { ok: false, error: e instanceof Error ? e.message : String(e) },
        text: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

program
  .command('build [dir]')
  .description('static extraction -> graph')
  .option('--adapter <name>', 'framework adapter', 'angular')
  .option('--out <path>', 'output graph path', '.uigraph/graph')
  .action((dir: string | undefined, opts: { adapter: string; out: string }) =>
    run((c) => buildCmd(c, dir, opts))(),
  );

program
  .command('crawl')
  .description('real-browser crawl -> runtime graph')
  .requiredOption('--url <base>', 'base URL of the running app')
  .option('--paths <list>', 'comma-separated paths to visit')
  .option('--from-graph', 'seed the crawl from the static graph')
  .option('--out <path>', 'output graph path', '.uigraph/graph-runtime')
  .action((opts: { url: string; paths?: string; fromGraph?: boolean; out: string }) =>
    run((c) => crawlCmd(c, opts))(),
  );

program
  .command('merge')
  .description('merge static + runtime graphs (confidence promotion in core)')
  .option('--static <path>', 'static graph path', '.uigraph/graph')
  .option('--runtime <path>', 'runtime graph path', '.uigraph/graph-runtime')
  .option('--out <path>', 'output graph path', '.uigraph/graph')
  .action((opts: { static: string; runtime: string; out: string }) =>
    run((c) => mergeCmd(c, opts))(),
  );

program
  .command('screen <route>')
  .description('elements + locators of a screen')
  .option('--state <state>', 'screen state (default/empty/error/modal:<name>)')
  .action((route: string, opts: { state?: string }) => run((c) => screenCmd(c, route, opts))());

program
  .command('locators <query>')
  .description('locators matching a text query')
  .action((query: string) => run((c) => locatorsCmd(c, query))());

program
  .command('path <target>')
  .description('navigation steps to reach a screen')
  .option('--from <route>', 'start route')
  .action((target: string, opts: { from?: string }) => run((c) => pathCmd(c, target, opts))());

program
  .command('actions <element>')
  .description('what an element does (type + safety)')
  .action((element: string) => run((c) => actionsCmd(c, element))());

program
  .command('explain <name>')
  .description('explain a node by name or id')
  .action((name: string) => run((c) => explainCmd(c, name))());

program
  .command('impact')
  .description('which graph facts changed files make stale')
  .requiredOption('--files <list>', 'comma-separated changed files')
  .action((opts: { files: string }) => run((c) => impactCmd(c, opts))());

program
  .command('report')
  .description('markdown health report of the graph')
  .option('--out <path>', 'output file', 'GRAPH_REPORT.md')
  .action((opts: { out: string }) => run((c) => reportCmd(c, opts))());

program
  .command('verify')
  .description('create verification tasks for weak edges')
  .option('--base-url <url>', 'app base URL; probes execute when set')
  .option('--max <n>', 'cap the number of tasks created')
  .action((opts: { baseUrl?: string; max?: string }) => run((c) => verifyCmd(c, opts))());

const task = program.command('task').description('work the verify queue');
task
  .command('next')
  .description('lease the oldest open task (with bundle)')
  .action(() => run((c) => taskNextCmd(c))());
task
  .command('show <taskId>')
  .description('print one task')
  .action((taskId: string) => run((c) => taskShowCmd(c, taskId))());
task
  .command('submit <taskId>')
  .description('submit a probe plan for a verify_edge task')
  .requiredOption('--plan <file>', 'probe plan JSON file')
  .action((taskId: string, opts: { plan: string }) =>
    run((c) => taskSubmitCmd(c, taskId, opts))(),
  );
task
  .command('review <taskId>')
  .description('submit a code-review judgment (caps at ai_reviewed)')
  .requiredOption('--likely <bool>', 'true|false: does the edge look right?')
  .requiredOption('--reasoning <text>', 'one-paragraph reasoning')
  .action((taskId: string, opts: { likely: string; reasoning: string }) =>
    run((c) => taskReviewCmd(c, taskId, opts))(),
  );

program
  .command('install')
  .description('install the uigraph skill for coding agents')
  .option('--project', 'install into ./.claude and ./.agents instead of ~')
  .action((opts: { project?: boolean }) =>
    run(() =>
      installCmd({
        srcDir: path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../skills/uigraph'),
        project: opts.project,
        homeDir: os.homedir(),
        projectDir: process.cwd(),
      }),
    )(),
  );

program
  .command('mcp')
  .description('start the uigraph MCP server on stdio')
  .action(async () => {
    const { startMcpServer } = await import('../mcp/server.js');
    const projectDir = process.cwd();
    await startMcpServer({ services: await createServices(projectDir), projectDir });
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
