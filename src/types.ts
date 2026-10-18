/**
 * uigraph — frozen type contracts (v0.1).
 *
 * Every module builds against this file. Do not change shapes without updating
 * every consumer: core (store/merge/query), adapters, crawler, CLI, MCP.
 *
 * Design rules these types encode:
 *  - The graph is built deterministically. No AI writes a fact.
 *  - Every fact carries a Confidence; only 'verified' locators are handed to
 *    test generators. 'Unknown' is a valid answer and must stay representable.
 *  - Locators are structured descriptors, rendered to Playwright (or other
 *    runners) at the edge — never stored as code strings.
 *  - Actions carry a safety class; nothing 'mutate'/'destructive'/'unknown'
 *    is ever clicked by the crawler or a probe.
 */

export const SCHEMA_VERSION = '0.1.0';

/** How sure we are about a fact, and where that certainty comes from. */
export type Confidence =
  | 'extracted' // explicit in source code
  | 'inferred' // derived by resolution (call graph, defaults)
  | 'observed' // seen in the live app by the crawler
  | 'verified' // static and runtime agree (or a probe confirmed it)
  | 'ambiguous' // several candidates; must not be used without a human/probe
  | 'ai_reviewed' // an AI read code only; a hint, never truth
  | 'contradicted'; // runtime disproved the static claim

/** Strongest first — merge keeps the strongest claim for the same fact. */
export const CONFIDENCE_ORDER: Confidence[] = [
  'verified',
  'observed',
  'extracted',
  'inferred',
  'ai_reviewed',
  'ambiguous',
  'contradicted',
];

export type FactSource = 'static' | 'runtime' | 'both' | 'ai';

/** What an action does to the world. Crawler/probes may only trigger 'safe'. */
export type Safety = 'safe' | 'mutate' | 'destructive' | 'unknown';

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * A structured, runner-agnostic locator. Strategies are ordered by the ladder:
 * role+name > label > placeholder > attr (framework-native stable attribute,
 * e.g. formcontrolname / name / href) > scoped text > css (last resort).
 */
export interface LocatorDescriptor {
  strategy: 'role' | 'label' | 'placeholder' | 'text' | 'attr' | 'css';
  /** ARIA role for strategy 'role'. */
  role?: string;
  /** Accessible name / label / placeholder / text. Literal match. */
  name?: string;
  /** Regex source (no flags) when the name/text is dynamic ("3 items left"). */
  nameRegex?: string;
  /** For strategy 'attr': a stable DOM attribute that survives builds. */
  attr?: { name: string; value: string };
  /** For strategy 'css' only. Flagged low-confidence by construction. */
  css?: string;
  /** Scope chain, outermost first (dialog, landmark, component host, list item). */
  scope?: LocatorDescriptor[];
  /** Narrow a collection item: "the row whose text contains X". */
  filterText?: string;
  /** Proven unique on the live page (set by crawler). Absent = unknown. */
  unique?: boolean;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'route'
  | 'screen'
  | 'component'
  | 'element'
  | 'action'
  | 'api'
  | 'form'
  | 'precondition';

export interface BaseNode {
  id: string; // stable hash (see core/ids.ts) — never positional
  kind: NodeKind;
  /** Source file (repo-relative) and line, when known. */
  file?: string;
  line?: number;
  confidence: Confidence;
  source: FactSource;
}

export interface RouteNode extends BaseNode {
  kind: 'route';
  /** Path segment as written ('users/:id'). */
  path: string;
  /** Resolved full path from the root ('/admin/users/:id'). */
  fullPath: string;
  paramNames: string[];
  guards: string[];
  lazy?: boolean;
  redirectTo?: string;
  /** Component class name rendered by the route, when known. */
  componentName?: string;
}

/** A screen = route + state + role + viewport (the agreed state model). */
export interface ScreenNode extends BaseNode {
  kind: 'screen';
  routeId: string;
  /** 'default' | 'empty' | 'error' | 'modal:<name>' | branch label from code. */
  state: string;
  roleProfile?: string; // auth role the crawl used
  viewport?: 'desktop' | 'mobile';
  /** Hash of the text-free accessibility tree (crawler). */
  ariaHash?: string;
  title?: string;
}

export interface ComponentNode extends BaseNode {
  kind: 'component';
  name: string;
  selector?: string;
  standalone?: boolean;
}

export interface ElementNode extends BaseNode {
  kind: 'element';
  /** Best known descriptor, per the locator ladder. */
  locator: LocatorDescriptor;
  role?: string;
  /** Accessible name (computed at runtime when available, else static). */
  name?: string;
  /** Visible text when distinct from the accessible name. */
  text?: string;
  /** i18n key when the label is translated. */
  i18nKey?: string;
  /** Stable attributes seen on the element (formcontrolname, name, href...). */
  attrs?: Record<string, string>;
  /** Set when this element is one item template of a collection. */
  collection?: { keyHint?: string };
  /** Template conditions guarding visibility ('@if isAdmin', flag names). */
  conditions?: string[];
  /** Accessibility finding: interactive but has no accessible name. */
  unnamed?: boolean;
}

export interface ActionNode extends BaseNode {
  kind: 'action';
  type: 'navigate' | 'api' | 'state' | 'dialog' | 'download' | 'external' | 'unknown';
  safety: Safety;
  /** navigate: target path. api: 'METHOD /url'. dialog: component/name. */
  detail?: string;
  handler?: string; // 'UserListComponent.onDelete'
}

export interface ApiEndpointNode extends BaseNode {
  kind: 'api';
  method: string;
  urlPattern: string;
}

export interface FormNode extends BaseNode {
  kind: 'form';
  name?: string;
  fields: Array<{
    control: string; // formcontrolname / name
    locator?: LocatorDescriptor;
    validators?: string[];
  }>;
}

export interface PreconditionNode extends BaseNode {
  kind: 'precondition';
  type: 'auth' | 'role' | 'flag' | 'data';
  detail: string; // guard name, flag name, seed description
}

export type GraphNode =
  | RouteNode
  | ScreenNode
  | ComponentNode
  | ElementNode
  | ActionNode
  | ApiEndpointNode
  | FormNode
  | PreconditionNode;

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export type EdgeType =
  | 'ROUTE_RENDERS' // route -> component
  | 'HAS_SCREEN' // route -> screen
  | 'CONTAINS' // component|screen -> element|component|form
  | 'TRIGGERS' // element -> action
  | 'NAVIGATES_TO' // action -> screen|route
  | 'CALLS' // action -> api
  | 'OPENS' // action -> screen (modal/overlay)
  | 'REQUIRES' // route|screen|element -> precondition
  | 'COVERED_BY'; // element|screen -> test file (string detail)

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence: Confidence;
  source: FactSource;
  /** One line a human can audit ('click observed 2026-10-17, POST /api/x'). */
  evidence?: string;
  detail?: string;
}

/** Edge identity for merging: from + type + to. */
export const edgeKey = (e: Pick<GraphEdge, 'from' | 'to' | 'type'>): string =>
  `${e.from}|${e.type}|${e.to}`;

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export interface Graph {
  schemaVersion: string;
  generator: { name: 'uigraph'; version: string };
  app: { name: string; framework: string };
  builtAt: string; // ISO
  /** file -> content hash at build time; drives stale_check. */
  fileHashes: Record<string, string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Adapter contract (the plugin API)
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Repo-relative dir to scan ('.' default). */
  dir?: string;
  /** Compiled mode inputs. */
  bundles?: string[];
  sourceMaps?: boolean;
  /**
   * Source globs or directories (relative to the project dir) to scan. When
   * omitted the adapter tries its conventional roots (src/, then app/).
   */
  src?: string[];
  /** Receives non-fatal findings (unresolved lazy routes, skipped inputs). */
  onWarning?: (message: string) => void;
}

export interface FrameworkAdapter {
  name: string; // 'angular'
  /** Cheap check: is this project ours? Never throws. */
  detect(projectDir: string): Promise<boolean>;
  /** Deterministic static pass. Must not touch the network or any AI. */
  extract(projectDir: string, options?: ExtractOptions): Promise<Graph>;
}

// ---------------------------------------------------------------------------
// Query API (what the CLI and MCP server expose; answers stay <~1k tokens)
// ---------------------------------------------------------------------------

export interface ScreenAnswer {
  screen: { route: string; state: string };
  preconditions: string[];
  elements: Array<{
    id: string;
    role?: string;
    name?: string;
    locator: LocatorDescriptor;
    rendered: string; // Playwright code for convenience
    confidence: Confidence;
    actions?: string[]; // ActionNode.detail summaries
  }>;
  truncated?: boolean;
}

export interface PathStep {
  do: 'goto' | 'click';
  url?: string;
  locator?: LocatorDescriptor;
  rendered?: string;
  note?: string;
}

export interface PathAnswer {
  target: { route: string; state: string };
  steps: PathStep[];
  preconditions: string[];
}

export interface StaleAnswer {
  staleNodeIds: string[];
  staleRoutes: string[];
  summary: string;
}

export interface QueryApi {
  getScreen(route: string, state?: string): ScreenAnswer | null;
  locatorsFor(query: string): ScreenAnswer['elements'];
  pathTo(target: string, from?: string): PathAnswer | null;
  actionsOf(elementIdOrName: string): Array<{ type: string; safety: Safety; detail?: string }>;
  staleCheck(files: string[]): StaleAnswer;
  explain(nameOrId: string): string | null;
}

// ---------------------------------------------------------------------------
// Probes, evidence, verification tasks (AI never executes; uigraph does)
// ---------------------------------------------------------------------------

export interface ProbeStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'waitFor';
  url?: string;
  locator?: LocatorDescriptor;
  value?: string; // fill text / key name
}

export interface ProbeExpectation {
  type: 'element' | 'url' | 'request';
  locator?: LocatorDescriptor;
  urlPattern?: string; // regex source
  method?: string;
}

export interface ProbePlan {
  edgeKey: string; // the edge under verification
  steps: ProbeStep[];
  expect: ProbeExpectation[];
}

export interface Evidence {
  ranAt: string;
  finalUrl: string;
  stepResults: Array<{ ok: boolean; note?: string }>;
  requests: Array<{ method: string; url: string }>;
  matched: boolean[]; // one per expectation
}

export type Verdict = 'verified' | 'contradicted' | 'unreached';

export interface VerifyTask {
  id: string;
  type: 'verify_edge' | 'review_edge';
  edgeKey: string;
  status: 'open' | 'leased' | 'done' | 'failed';
  leaseUntil?: string;
  /** Compact context handed to the coding agent (graph slice + code lines). */
  bundle?: string;
  verdict?: Verdict;
}
