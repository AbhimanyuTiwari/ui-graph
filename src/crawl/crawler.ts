/**
 * Playwright crawler: observes screens, elements, and click outcomes on a
 * running app and emits a deterministic Graph (confidence 'observed',
 * source 'runtime').
 *
 * CLICK POLICY (the decision this module ships):
 *  - Links (role=link): clicked only when the resolved href stays on the
 *    baseUrl origin (or an allowlisted host). Off-origin links are recorded
 *    as elements but never followed; a context-level route guard additionally
 *    aborts any off-origin request as defense in depth.
 *  - Buttons: clicked only when ALL of
 *      (a) they have an accessible name (unnamed buttons cannot be safely
 *          re-identified, so they are recorded with `unnamed: true` and a CSS
 *          fallback locator but never clicked),
 *      (b) the name does not match DESTRUCTIVE_TEXT (e.g. "Delete user" is
 *          never clicked — asserted against the fixture server log), and
 *      (c) the locator is unique (ambiguous locators would strict-mode throw
 *          and could hit the wrong instance; ambiguous elements are recorded
 *          once with a collection filter hint and never clicked).
 *    "Requests so far show them safe" can only be judged after the first
 *    click: a button whose name passes the denylist (fixture: "Save") IS
 *    clicked exactly once; if a non-GET request fires, the action is marked
 *    safety 'mutate', the report note 'unexpected mutation on click' is
 *    attached to the edge evidence, the element enters a deny set, and it is
 *    never clicked again for the rest of the crawl.
 *  - Isolation: every page path gets a fresh browser context, and the page is
 *    re-navigated (reset) before each individual click, so no clicked state
 *    leaks between interactions or between pages.
 *  - Determinism: nodes/edges are sorted before return, ids come from
 *    core/ids (semantic parts only), and evidence strings carry no timestamps.
 */
import { chromium, type Browser, type Page } from 'playwright';
import type {
  ActionNode,
  ApiEndpointNode,
  ElementNode,
  Graph,
  GraphEdge,
  GraphNode,
  LocatorDescriptor,
  RouteNode,
  ScreenNode,
} from '../types.js';
import { SCHEMA_VERSION, edgeKey } from '../types.js';
import { DESTRUCTIVE_TEXT } from '../schemas.js';
import { contentHash, stableId } from '../core/ids.js';
import { buildLocator } from './locate.js';

export interface CrawlOptions {
  baseUrl: string;
  /** Paths to visit, e.g. ['/index.html', '/users.html']. */
  paths: string[];
  /** Extra hosts navigation/requests may touch besides the baseUrl host. */
  allowHosts?: string[];
  /** Safety valve: at most this many click experiments per page. */
  maxClicksPerPage?: number;
}

const ROLES = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox'] as const;

interface CapturedRequest {
  method: string;
  url: string;
  resourceType: string;
}

interface EnumeratedElement {
  id: string;
  role: string;
  name?: string;
  desc: LocatorDescriptor;
  ambiguous: boolean;
  unnamed: boolean;
  href?: string;
}

/** Parse "- button \"New user\"" (first line of an element aria snapshot). */
function parseAriaLine(snapshot: string): { role?: string; name?: string } {
  const first = snapshot.split('\n')[0] ?? '';
  const m = first.match(/^-\s*([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
  if (!m) return {};
  const raw = m[2];
  const name = raw === undefined || raw === '' ? undefined : raw.replace(/\\(.)/g, '$1');
  return { role: m[1], name };
}

/** Structural aria hash: roles and nesting only, all text stripped. */
function structuralAriaHash(snapshot: string): string {
  const structural = snapshot
    .split('\n')
    .map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/:\s.+$/, ':'))
    .filter((line) => line.trim() !== '' && !/-\s*text\b/.test(line) && !/\/url/.test(line))
    .join('\n');
  return contentHash(structural);
}

function sameOrigin(url: string, allowedHosts: Set<string>): boolean {
  try {
    return allowedHosts.has(new URL(url).host);
  } catch {
    return false;
  }
}

export async function crawl(opts: CrawlOptions): Promise<Graph> {
  const base = new URL(opts.baseUrl);
  const allowedHosts = new Set<string>([base.host, ...(opts.allowHosts ?? [])]);
  const maxClicks = opts.maxClicksPerPage ?? 15;

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  /** Elements observed to mutate — never clicked again anywhere in the crawl. */
  const mutationDenySet = new Set<string>();

  const putNode = (n: GraphNode): void => {
    nodes.set(n.id, n);
  };
  const putNodeIfAbsent = (n: GraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const putEdge = (e: GraphEdge): void => {
    edges.set(edgeKey(e), e);
  };

  const browser = await chromium.launch();
  try {
    for (const path of opts.paths) {
      await crawlPath(browser, base, path, allowedHosts, maxClicks, {
        putNode,
        putNodeIfAbsent,
        putEdge,
        mutationDenySet,
      });
    }
  } finally {
    await browser.close();
  }

  const sortedNodes = [...nodes.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sortedEdges = [...edges.values()].sort((a, b) => {
    const ka = edgeKey(a);
    const kb = edgeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'uigraph', version: '0.1.0' },
    app: { name: base.host, framework: 'runtime' },
    builtAt: new Date().toISOString(),
    fileHashes: {},
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

interface Sink {
  putNode(n: GraphNode): void;
  putNodeIfAbsent(n: GraphNode): void;
  putEdge(e: GraphEdge): void;
  mutationDenySet: Set<string>;
}

function screenIdFor(pathname: string, state: string): string {
  return stableId('screen', pathname, state);
}

function stubScreen(pathname: string): ScreenNode {
  return {
    id: screenIdFor(pathname, 'default'),
    kind: 'screen',
    routeId: stableId('route', pathname),
    state: 'default',
    confidence: 'observed',
    source: 'runtime',
  };
}

async function crawlPath(
  browser: Browser,
  base: URL,
  path: string,
  allowedHosts: Set<string>,
  maxClicks: number,
  sink: Sink,
): Promise<void> {
  // Fresh context per page: clicked state never leaks across pages.
  const context = await browser.newContext();
  const captured: CapturedRequest[] = [];
  try {
    // Host allowlist enforced at the network layer: anything off-origin
    // (and not allowlisted) is aborted before it leaves the browser.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (sameOrigin(url, allowedHosts)) return route.continue();
      return route.abort();
    });

    const page = await context.newPage();
    page.on('request', (r) => {
      captured.push({ method: r.method(), url: r.url(), resourceType: r.resourceType() });
    });

    const pageUrl = new URL(path, base).toString();
    const pathname = new URL(pageUrl).pathname;
    await page.goto(pageUrl, { waitUntil: 'load' });

    const route: RouteNode = {
      id: stableId('route', pathname),
      kind: 'route',
      path: pathname,
      fullPath: pathname,
      paramNames: [],
      guards: [],
      confidence: 'observed',
      source: 'runtime',
    };
    sink.putNode(route);

    const snapshot = await page.locator('body').ariaSnapshot();
    const screen: ScreenNode = {
      id: screenIdFor(pathname, 'default'),
      kind: 'screen',
      routeId: route.id,
      state: 'default',
      ariaHash: structuralAriaHash(snapshot),
      title: await page.title(),
      confidence: 'observed',
      source: 'runtime',
    };
    sink.putNode(screen);
    sink.putEdge({
      from: route.id,
      to: screen.id,
      type: 'HAS_SCREEN',
      confidence: 'observed',
      source: 'runtime',
      evidence: `crawled ${pathname}`,
    });

    const enumerated = await enumerateElements(page, pathname, undefined);
    for (const el of enumerated) {
      recordElement(sink, screen.id, pathname, el);
    }

    // --- click phase -------------------------------------------------------
    const clickables = enumerated
      .filter((el) => isClickable(el, base, allowedHosts, sink.mutationDenySet))
      .slice(0, maxClicks);

    for (const el of clickables) {
      // Reset page state before every click so experiments stay independent.
      await page.goto(pageUrl, { waitUntil: 'load' });
      const mark = captured.length;
      try {
        await buildLocator(page, el.desc).click({ timeout: 2500 });
      } catch {
        continue; // not clickable right now; no fact to record
      }
      await page.waitForLoadState('load').catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);

      const apiRequests = captured
        .slice(mark)
        .filter((r) => r.resourceType === 'fetch' || r.resourceType === 'xhr');
      const afterUrl = new URL(page.url());
      const navigated = afterUrl.pathname !== pathname;
      const dialogOpen = await page
        .getByRole('dialog')
        .isVisible()
        .catch(() => false);

      await recordClickOutcome(sink, page, {
        el,
        pathname,
        apiRequests,
        navigated,
        afterPathname: afterUrl.pathname,
        dialogOpen,
        routeId: route.id,
      });
    }
  } finally {
    await context.close();
  }
}

function isClickable(
  el: EnumeratedElement,
  base: URL,
  allowedHosts: Set<string>,
  denySet: Set<string>,
): boolean {
  if (denySet.has(el.id)) return false;
  if (el.role === 'link') {
    if (el.ambiguous || el.href === undefined) return false;
    try {
      return allowedHosts.has(new URL(el.href, base).host);
    } catch {
      return false;
    }
  }
  if (el.role === 'button') {
    if (el.unnamed || el.ambiguous) return false;
    if (el.name !== undefined && DESTRUCTIVE_TEXT.test(el.name)) return false;
    return true;
  }
  return false;
}

async function enumerateElements(
  page: Page,
  pathname: string,
  dialogScope: { heading: string } | undefined,
): Promise<EnumeratedElement[]> {
  const root = dialogScope === undefined ? page : page.getByRole('dialog');
  const scopeDescs: LocatorDescriptor[] | undefined =
    dialogScope === undefined
      ? undefined
      : [{ strategy: 'role', role: 'dialog', name: dialogScope.heading }];
  const idScope = dialogScope === undefined ? 'page' : `modal:${dialogScope.heading}`;

  const out: EnumeratedElement[] = [];
  const seen = new Set<string>();

  for (const role of ROLES) {
    const matches = await root.getByRole(role).all();
    for (const el of matches) {
      const parsed = parseAriaLine(await el.ariaSnapshot());
      const name = parsed.name;
      const attrs = await el.evaluate((node: Element) => ({
        tag: node.tagName.toLowerCase(),
        id: node.getAttribute('id'),
        className: node.getAttribute('class'),
        nameAttr: node.getAttribute('name'),
        href: node.getAttribute('href'),
        placeholder: node.getAttribute('placeholder'),
      }));

      let desc: LocatorDescriptor;
      let idPart: string;
      let ambiguous = false;
      let unnamed = false;

      if (name !== undefined) {
        // Ladder rung 1: role + accessible name (covers label-derived names).
        desc = { strategy: 'role', role, name, scope: scopeDescs };
        idPart = name;
      } else if (attrs.placeholder !== null && attrs.placeholder !== '') {
        unnamed = role === 'button';
        desc = { strategy: 'placeholder', name: attrs.placeholder, scope: scopeDescs };
        idPart = `placeholder:${attrs.placeholder}`;
      } else if (attrs.nameAttr !== null && attrs.nameAttr !== '') {
        unnamed = true;
        desc = {
          strategy: 'attr',
          attr: { name: 'name', value: attrs.nameAttr },
          scope: scopeDescs,
        };
        idPart = `attr:name=${attrs.nameAttr}`;
      } else if (attrs.href !== null && attrs.href !== '') {
        unnamed = true;
        desc = { strategy: 'attr', attr: { name: 'href', value: attrs.href }, scope: scopeDescs };
        idPart = `attr:href=${attrs.href}`;
      } else {
        // Last resort: css. Flagged low-confidence by construction.
        unnamed = true;
        const css =
          attrs.id !== null && attrs.id !== ''
            ? `${attrs.tag}#${attrs.id}`
            : attrs.className !== null && attrs.className !== ''
              ? `${attrs.tag}.${attrs.className.trim().split(/\s+/).join('.')}`
              : attrs.tag;
        desc = { strategy: 'css', css, scope: scopeDescs };
        idPart = `css:${css}`;
      }

      const id = stableId('element', pathname, idScope, role, idPart);
      if (seen.has(id)) continue;
      seen.add(id);

      const count = await buildLocator(page, desc).count();
      desc.unique = count === 1;
      if (count > 1) {
        ambiguous = true;
        // Collection-style filter hint: the descriptor stays recorded once;
        // a consumer must scope it by the containing list item's text.
        desc.scope = [
          ...(scopeDescs ?? []),
          { strategy: 'role', role: 'listitem', filterText: '<distinguishing item text>' },
        ];
      }

      out.push({
        id,
        role,
        name,
        desc,
        ambiguous,
        unnamed,
        href: attrs.href ?? undefined,
      });
    }
  }
  return out;
}

function recordElement(sink: Sink, containerId: string, pathname: string, el: EnumeratedElement): void {
  const node: ElementNode = {
    id: el.id,
    kind: 'element',
    locator: el.desc,
    role: el.role,
    name: el.name,
    confidence: el.ambiguous ? 'ambiguous' : 'observed',
    source: 'runtime',
    ...(el.unnamed ? { unnamed: true } : {}),
    ...(el.ambiguous ? { collection: { keyHint: 'containing list item text' } } : {}),
  };
  sink.putNode(node);
  sink.putEdge({
    from: containerId,
    to: el.id,
    type: 'CONTAINS',
    confidence: 'observed',
    source: 'runtime',
    evidence: `enumerated ${el.role}${el.name !== undefined ? ` "${el.name}"` : ''} on ${pathname}`,
  });
}

interface ClickOutcome {
  el: EnumeratedElement;
  pathname: string;
  apiRequests: CapturedRequest[];
  navigated: boolean;
  afterPathname: string;
  dialogOpen: boolean;
  routeId: string;
}

async function recordClickOutcome(sink: Sink, page: Page, o: ClickOutcome): Promise<void> {
  const label = o.el.name ?? o.el.id;
  const mutation = o.apiRequests.find((r) => r.method.toUpperCase() !== 'GET');

  let action: ActionNode | undefined;
  const link = (a: ActionNode, note?: string): void => {
    sink.putNode(a);
    sink.putEdge({
      from: o.el.id,
      to: a.id,
      type: 'TRIGGERS',
      confidence: 'observed',
      source: 'runtime',
      evidence: `click "${label}" on ${o.pathname} observed${note !== undefined ? `; ${note}` : ''}`,
    });
  };

  if (mutation !== undefined) {
    // Report note: the click unexpectedly mutated state. Deny further clicks.
    sink.mutationDenySet.add(o.el.id);
    const apiPath = new URL(mutation.url).pathname;
    const detail = `${mutation.method.toUpperCase()} ${apiPath}`;
    action = {
      id: stableId('action', o.pathname, label, 'api', detail),
      kind: 'action',
      type: 'api',
      safety: 'mutate',
      detail,
      confidence: 'observed',
      source: 'runtime',
    };
    const note = `unexpected mutation on click: ${detail}`;
    link(action, note);
    const api: ApiEndpointNode = {
      id: stableId('api', mutation.method.toUpperCase(), apiPath),
      kind: 'api',
      method: mutation.method.toUpperCase(),
      urlPattern: apiPath,
      confidence: 'observed',
      source: 'runtime',
    };
    sink.putNode(api);
    sink.putEdge({
      from: action.id,
      to: api.id,
      type: 'CALLS',
      confidence: 'observed',
      source: 'runtime',
      evidence: `${note} (click "${label}" on ${o.pathname})`,
    });
    return;
  }

  if (o.navigated) {
    const target = stubScreen(o.afterPathname);
    sink.putNodeIfAbsent(target);
    action = {
      id: stableId('action', o.pathname, label, 'navigate', o.afterPathname),
      kind: 'action',
      type: 'navigate',
      safety: 'safe',
      detail: o.afterPathname,
      confidence: 'observed',
      source: 'runtime',
    };
    link(action);
    sink.putEdge({
      from: action.id,
      to: target.id,
      type: 'NAVIGATES_TO',
      confidence: 'observed',
      source: 'runtime',
      evidence: `click "${label}" on ${o.pathname} navigated to ${o.afterPathname}`,
    });
    return;
  }

  if (o.dialogOpen) {
    const heading = (await page.getByRole('dialog').getByRole('heading').innerText()).trim();
    const state = `modal:${heading}`;
    const modal: ScreenNode = {
      id: screenIdFor(o.pathname, state),
      kind: 'screen',
      routeId: o.routeId,
      state,
      title: heading,
      confidence: 'observed',
      source: 'runtime',
    };
    sink.putNode(modal);
    action = {
      id: stableId('action', o.pathname, label, 'dialog', heading),
      kind: 'action',
      type: 'dialog',
      safety: 'safe',
      detail: heading,
      confidence: 'observed',
      source: 'runtime',
    };
    link(action);
    sink.putEdge({
      from: action.id,
      to: modal.id,
      type: 'OPENS',
      confidence: 'observed',
      source: 'runtime',
      evidence: `click "${label}" on ${o.pathname} opened dialog "${heading}"`,
    });
    // Enumerate the dialog's own elements, scoped to the dialog.
    const dialogElements = await enumerateElements(page, o.pathname, { heading });
    for (const el of dialogElements) {
      recordElement(sink, modal.id, o.pathname, el);
    }
    return;
  }

  const getCall = o.apiRequests.find((r) => r.method.toUpperCase() === 'GET');
  if (getCall !== undefined) {
    const apiPath = new URL(getCall.url).pathname;
    const detail = `GET ${apiPath}`;
    action = {
      id: stableId('action', o.pathname, label, 'api', detail),
      kind: 'action',
      type: 'api',
      safety: 'safe',
      detail,
      confidence: 'observed',
      source: 'runtime',
    };
    link(action);
    const api: ApiEndpointNode = {
      id: stableId('api', 'GET', apiPath),
      kind: 'api',
      method: 'GET',
      urlPattern: apiPath,
      confidence: 'observed',
      source: 'runtime',
    };
    sink.putNode(api);
    sink.putEdge({
      from: action.id,
      to: api.id,
      type: 'CALLS',
      confidence: 'observed',
      source: 'runtime',
      evidence: `click "${label}" on ${o.pathname} fired GET ${apiPath}`,
    });
  }
  // No observable outcome: record nothing (the element node already exists).
}
