/**
 * File-based verification queue at <projectDir>/.uigraph/queue/.
 *
 * One JSON file per VerifyTask (strict-schema, nothing else goes in the file).
 * Coding agents lease tasks, read a compact bundle, and reply with a probe
 * plan (verify_edge) or a judgment (review_edge). uigraph validates, executes
 * and judges — the agent never writes a fact directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stableId } from '../core/ids.js';
import { VerifyTaskSchema } from '../schemas.js';
import type {
  ActionNode,
  Confidence,
  Evidence,
  Graph,
  GraphEdge,
  GraphNode,
  ProbePlan,
  Verdict,
  VerifyTask,
} from '../types.js';
import { edgeKey as edgeKeyOf } from '../types.js';
import type { UigraphConfig } from '../cli/services.js';
import { DEFAULT_GRAPH_PATH } from '../cli/services.js';
import { checkEvidence as defaultCheckEvidence } from './validate.js';

export const LEASE_MS = 10 * 60 * 1000;
const UNSAFE: ReadonlySet<string> = new Set(['mutate', 'destructive', 'unknown']);

// ---------------------------------------------------------------------------
// Paths + config
// ---------------------------------------------------------------------------

export const queueDir = (projectDir: string): string => path.join(projectDir, '.uigraph', 'queue');
export const recipesDir = (projectDir: string): string =>
  path.join(projectDir, '.uigraph', 'recipes');
const configPath = (projectDir: string): string => path.join(projectDir, '.uigraph', 'config.json');

export function readConfig(projectDir: string): UigraphConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(projectDir), 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      return {
        baseUrl: typeof o['baseUrl'] === 'string' ? o['baseUrl'] : undefined,
        graphPath: typeof o['graphPath'] === 'string' ? o['graphPath'] : undefined,
      };
    }
  } catch {
    /* missing or malformed config -> defaults */
  }
  return {};
}

export function writeConfig(projectDir: string, patch: UigraphConfig): UigraphConfig {
  const merged = { ...readConfig(projectDir), ...patch };
  fs.mkdirSync(path.dirname(configPath(projectDir)), { recursive: true });
  fs.writeFileSync(configPath(projectDir), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export function graphPathOf(projectDir: string): string {
  return path.resolve(projectDir, readConfig(projectDir).graphPath ?? DEFAULT_GRAPH_PATH);
}

// ---------------------------------------------------------------------------
// Task creation
// ---------------------------------------------------------------------------

export interface CreateTasksOptions {
  /** Edge confidences that need verification. */
  confidences?: Confidence[];
}

function nodeById(graph: Graph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

function edgeTouchesUnsafeAction(edge: GraphEdge, nodes: Map<string, GraphNode>): boolean {
  for (const id of [edge.from, edge.to]) {
    const n = nodes.get(id);
    if (n && n.kind === 'action' && UNSAFE.has((n as ActionNode).safety)) return true;
  }
  return false;
}

/**
 * One task per edge whose confidence is in `confidences`
 * (default ['inferred','ambiguous']). Edges touching an action whose safety is
 * mutate/destructive/unknown are never probed: they become 'review_edge'
 * (read-the-code judgment, capped at ai_reviewed) instead of 'verify_edge'.
 */
export function createTasks(graph: Graph, options: CreateTasksOptions = {}): VerifyTask[] {
  const confidences = options.confidences ?? ['inferred', 'ambiguous'];
  const want = new Set<Confidence>(confidences);
  const nodes = nodeById(graph);
  const seen = new Set<string>();
  const tasks: VerifyTask[] = [];
  for (const edge of graph.edges) {
    if (!want.has(edge.confidence)) continue;
    const key = edgeKeyOf(edge);
    const id = stableId('task', key);
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({
      id,
      type: edgeTouchesUnsafeAction(edge, nodes) ? 'review_edge' : 'verify_edge',
      edgeKey: key,
      status: 'open',
    });
  }
  return tasks;
}

/** Persist tasks that are not already queued. Existing files are never clobbered. */
export function enqueueTasks(
  projectDir: string,
  tasks: VerifyTask[],
): { created: number; skipped: number } {
  const dir = queueDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  let created = 0;
  let skipped = 0;
  for (const task of tasks) {
    const file = path.join(dir, `${task.id}.json`);
    if (fs.existsSync(file)) {
      skipped++;
      continue;
    }
    writeTask(projectDir, task);
    created++;
  }
  return { created, skipped };
}

// ---------------------------------------------------------------------------
// Task files
// ---------------------------------------------------------------------------

function taskFile(projectDir: string, taskId: string): string {
  return path.join(queueDir(projectDir), `${taskId}.json`);
}

function writeTask(projectDir: string, task: VerifyTask): void {
  fs.mkdirSync(queueDir(projectDir), { recursive: true });
  fs.writeFileSync(taskFile(projectDir, task.id), JSON.stringify(task, null, 2) + '\n');
}

export function readTask(projectDir: string, taskId: string): VerifyTask | null {
  try {
    const raw = JSON.parse(fs.readFileSync(taskFile(projectDir, taskId), 'utf8')) as unknown;
    return VerifyTaskSchema.parse(raw);
  } catch {
    return null;
  }
}

export function listTasks(projectDir: string): VerifyTask[] {
  const dir = queueDir(projectDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const withTime: Array<{ task: VerifyTask; born: number }> = [];
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      const task = VerifyTaskSchema.parse(JSON.parse(fs.readFileSync(full, 'utf8')));
      const st = fs.statSync(full);
      withTime.push({ task, born: st.birthtimeMs || st.mtimeMs });
    } catch {
      /* skip unreadable/invalid task files */
    }
  }
  withTime.sort((a, b) => a.born - b.born || a.task.id.localeCompare(b.task.id));
  return withTime.map((t) => t.task);
}

export function queueSummary(projectDir: string): {
  total: number;
  open: number;
  leased: number;
  done: number;
  failed: number;
  verify_edge: number;
  review_edge: number;
} {
  const tasks = listTasks(projectDir);
  const by = (p: (t: VerifyTask) => boolean) => tasks.filter(p).length;
  return {
    total: tasks.length,
    open: by((t) => t.status === 'open'),
    leased: by((t) => t.status === 'leased'),
    done: by((t) => t.status === 'done'),
    failed: by((t) => t.status === 'failed'),
    verify_edge: by((t) => t.type === 'verify_edge'),
    review_edge: by((t) => t.type === 'review_edge'),
  };
}

/**
 * Oldest open task -> leased for 10 minutes (persisted). Expired leases are
 * reopened first, so a crashed agent's task comes back automatically.
 */
export function nextTask(projectDir: string, now: Date = new Date()): VerifyTask | null {
  const tasks = listTasks(projectDir);
  for (const t of tasks) {
    if (t.status === 'leased' && t.leaseUntil && Date.parse(t.leaseUntil) < now.getTime()) {
      const reopened: VerifyTask = { ...t, status: 'open' };
      delete reopened.leaseUntil;
      writeTask(projectDir, reopened);
      t.status = 'open';
      delete t.leaseUntil;
    }
  }
  const open = tasks.find((t) => t.status === 'open');
  if (!open) return null;
  const leased: VerifyTask = {
    ...open,
    status: 'leased',
    leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
  };
  writeTask(projectDir, leased);
  return leased;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

const BUNDLE_LIMIT = 4000;

const BUNDLE_FOOTER = [
  '--- how to answer ---',
  'A probe plan is a small JSON recipe uigraph executes in a real browser to',
  'verify the edge above. You plan it; uigraph runs it and judges the evidence.',
  'Shape: { "edgeKey": "<copy the edge key above>",',
  '  "steps": [ { "action": "goto|click|fill|press|waitFor", "url"?, "locator"?, "value"? } ],',
  '  "expect": [ { "type": "element|url|request", "locator"?, "urlPattern"?, "method"? } ] }',
  'Locator: { "strategy": "role|label|placeholder|text|attr|css", "role"?, "name"?,',
  '  "nameRegex"?, "attr"?: {"name","value"}, "css"?, "scope"?, "filterText"? }.',
  'Safety rules (plans violating them are rejected):',
  ' - never click or press anything destructive or mutating (delete/remove/pay/',
  '   send/publish/logout/...); such edges are review-only.',
  ' - goto only relative paths or URLs on the configured base origin (on-origin only).',
  'Reply via submit_probe with the plan JSON (review_edge tasks: submit_review).',
].join('\n');

function trimNode(node: GraphNode | undefined, id: string): string {
  if (!node) return JSON.stringify({ id, missing: true });
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined || v === null) continue;
    clone[k] = v;
  }
  let s = JSON.stringify(clone);
  if (s.length > 700) s = s.slice(0, 700) + '…';
  return s;
}

function codeExcerpt(projectDir: string, node: GraphNode | undefined, budget: number): string {
  if (!node?.file) return '';
  const abs = path.resolve(projectDir, node.file);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
  const lines = content.split('\n');
  const center = Math.max(1, node.line ?? 1);
  const start = Math.max(1, center - 12);
  const end = Math.min(lines.length, center + 12);
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join('\n');
  const text = `# ${node.file}:${center}\n${body}`;
  return text.length > budget ? text.slice(0, Math.max(0, budget - 1)) + '…' : text;
}

/**
 * Compact (<4k chars) context for one edge: the edge, its trimmed endpoint
 * nodes, ±12 lines of each endpoint's source file when present, and the
 * instruction/safety footer.
 */
export function buildBundle(graph: Graph, edgeKey: string, projectDir: string): string {
  const edge = graph.edges.find((e) => edgeKeyOf(e) === edgeKey);
  if (!edge) throw new Error(`no edge with key ${edgeKey}`);
  const nodes = nodeById(graph);
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);

  const head = [
    `edge under verification (edgeKey: ${edgeKey})`,
    JSON.stringify({ ...edge }),
    `from node: ${trimNode(from, edge.from)}`,
    `to node: ${trimNode(to, edge.to)}`,
  ].join('\n');

  let budget = BUNDLE_LIMIT - head.length - BUNDLE_FOOTER.length - 20;
  const excerpts: string[] = [];
  for (const node of [from, to]) {
    if (budget <= 80) break;
    const ex = codeExcerpt(projectDir, node, Math.min(1400, budget));
    if (ex) {
      excerpts.push(ex);
      budget -= ex.length + 1;
    }
  }

  const bundle = [head, ...excerpts, BUNDLE_FOOTER].join('\n');
  return bundle.length <= BUNDLE_LIMIT ? bundle : bundle.slice(0, BUNDLE_LIMIT);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/** The slice of Services the queue needs (structural; fakes in tests). */
export interface SubmitServices {
  loadGraph(path: string): Promise<Graph>;
  saveGraph(path: string, graph: Graph): Promise<void>;
  runProbe(plan: ProbePlan, baseUrl: string): Promise<Evidence>;
  validatePlan(plan: unknown): ProbePlan;
  checkEvidence?(plan: ProbePlan, evidence: Evidence): Verdict;
}

export interface SubmitProbeResult {
  task: VerifyTask;
  verdict?: Verdict;
  evidence?: Evidence;
  /** 'executed' when a probe ran; 'stored' when no baseUrl is configured. */
  mode: 'executed' | 'stored';
  recipePath: string;
  graphUpdated: boolean;
}

function saveRecipe(projectDir: string, taskId: string, recipe: unknown): string {
  const dir = recipesDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify(recipe, null, 2) + '\n');
  return file;
}

async function updateEdge(
  projectDir: string,
  services: Pick<SubmitServices, 'loadGraph' | 'saveGraph'>,
  edgeKey: string,
  mutate: (edge: GraphEdge) => void,
): Promise<boolean> {
  const gPath = graphPathOf(projectDir);
  let graph: Graph;
  try {
    graph = await services.loadGraph(gPath);
  } catch {
    return false; // graph not built / store not wired yet: task result still recorded
  }
  const edge = graph.edges.find((e) => edgeKeyOf(e) === edgeKey);
  if (!edge) return false;
  mutate(edge);
  await services.saveGraph(gPath, graph);
  return true;
}

function loadActionableTask(projectDir: string, taskId: string): VerifyTask {
  const task = readTask(projectDir, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  if (task.status === 'done') throw new Error(`task ${taskId} is already done`);
  return task;
}

/**
 * Agent reply for a verify_edge task. The plan is untrusted: validatePlan
 * (schema + safety) gates everything. With a configured baseUrl the probe is
 * executed and judged (verdict -> graph edge verified/contradicted); without
 * one the plan is stored as a recipe and the verdict stays undefined.
 */
export async function submitProbe(
  projectDir: string,
  taskId: string,
  rawPlan: unknown,
  services: SubmitServices,
): Promise<SubmitProbeResult> {
  const task = loadActionableTask(projectDir, taskId);
  if (task.type !== 'verify_edge') {
    throw new Error(
      `task ${taskId} is a ${task.type} task (edge touches an unsafe action); use submit_review`,
    );
  }
  const plan = services.validatePlan(rawPlan);
  if (plan.edgeKey !== task.edgeKey) {
    throw new Error(`plan edgeKey (${plan.edgeKey}) does not match task edge (${task.edgeKey})`);
  }

  const { baseUrl } = readConfig(projectDir);
  if (!baseUrl) {
    const done: VerifyTask = { ...task, status: 'done' };
    delete done.leaseUntil;
    writeTask(projectDir, done);
    const recipePath = saveRecipe(projectDir, taskId, {
      taskId,
      edgeKey: task.edgeKey,
      plan,
      note: 'no baseUrl configured; plan stored as recipe, not executed',
    });
    return { task: done, mode: 'stored', recipePath, graphUpdated: false };
  }

  const evidence = await services.runProbe(plan, baseUrl);
  const judge = services.checkEvidence ?? defaultCheckEvidence;
  const verdict = judge(plan, evidence);
  const done: VerifyTask = { ...task, status: 'done', verdict };
  delete done.leaseUntil;
  writeTask(projectDir, done);
  const recipePath = saveRecipe(projectDir, taskId, {
    taskId,
    edgeKey: task.edgeKey,
    plan,
    evidence,
    verdict,
  });

  let graphUpdated = false;
  if (verdict === 'verified' || verdict === 'contradicted') {
    graphUpdated = await updateEdge(projectDir, services, task.edgeKey, (edge) => {
      edge.confidence = verdict;
      edge.source = 'both';
      edge.evidence = `probe ${verdict} at ${evidence.ranAt} (final url ${evidence.finalUrl})`;
    });
  }
  return { task: done, verdict, evidence, mode: 'executed', recipePath, graphUpdated };
}

export interface SubmitReviewResult {
  task: VerifyTask;
  /** Confidence the edge ended at, when the graph was reachable. */
  confidence?: Confidence;
  recipePath: string;
  graphUpdated: boolean;
}

/**
 * Agent reply for a review_edge task: a read-the-code judgment. AI judgment
 * alone caps at 'ai_reviewed' — it is a hint, never truth, never 'verified'.
 * Only weaker claims (ambiguous) are lifted; stronger facts are left alone,
 * and a runtime 'contradicted' is never overturned by an opinion.
 */
export async function submitReview(
  projectDir: string,
  taskId: string,
  review: { likely: boolean; reasoning: string },
  services: Pick<SubmitServices, 'loadGraph' | 'saveGraph'>,
): Promise<SubmitReviewResult> {
  const task = loadActionableTask(projectDir, taskId);
  const reasoning = review.reasoning.slice(0, 2000);
  const done: VerifyTask = { ...task, status: 'done' };
  delete done.leaseUntil;
  writeTask(projectDir, done);
  const recipePath = saveRecipe(projectDir, taskId, {
    taskId,
    edgeKey: task.edgeKey,
    review: { likely: review.likely, reasoning },
  });

  let confidence: Confidence | undefined;
  const graphUpdated = await updateEdge(projectDir, services, task.edgeKey, (edge) => {
    if (review.likely && edge.confidence === 'ambiguous') {
      edge.confidence = 'ai_reviewed'; // the cap: never higher via review
      edge.source = 'ai';
    }
    edge.evidence = `ai review (likely=${review.likely}): ${reasoning.slice(0, 200)}`;
    confidence = edge.confidence;
  });
  return { task: done, confidence, recipePath, graphUpdated };
}
