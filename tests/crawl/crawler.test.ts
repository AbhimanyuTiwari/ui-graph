/**
 * Crawler integration tests against the local fixture site.
 * The whole suite does ONE crawl in beforeAll and asserts on the graph
 * plus the fixture server's request log (safety assertions).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSite } from '../../fixtures/site/serve';
import { crawl } from '../../src/crawl/crawler';
import { edgeKey } from '../../src/types';
import type {
  ActionNode,
  ApiEndpointNode,
  ElementNode,
  Graph,
  ScreenNode,
} from '../../src/types';

let site: Awaited<ReturnType<typeof startSite>>;
let graph: Graph;

beforeAll(async () => {
  site = await startSite();
  graph = await crawl({
    baseUrl: site.url,
    paths: ['/index.html', '/users.html', '/user.html'],
  });
}, 120_000);

afterAll(async () => {
  await site.close();
});

const screens = (): ScreenNode[] =>
  graph.nodes.filter((n): n is ScreenNode => n.kind === 'screen');
const elements = (): ElementNode[] =>
  graph.nodes.filter((n): n is ElementNode => n.kind === 'element');
const actions = (): ActionNode[] =>
  graph.nodes.filter((n): n is ActionNode => n.kind === 'action');
const apis = (): ApiEndpointNode[] =>
  graph.nodes.filter((n): n is ApiEndpointNode => n.kind === 'api');

describe('crawl', () => {
  it('finds a default screen per crawled path (3+), observed, with ariaHash and title', () => {
    const defaults = screens().filter((s) => s.state === 'default');
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    for (const s of defaults) {
      expect(s.confidence).toBe('observed');
      expect(s.source).toBe('runtime');
      expect(s.ariaHash).toBeTruthy();
      expect(s.title).toBeTruthy();
    }
  });

  it('marks the repeated Edit link ambiguous, recorded once, with a collection filter hint', () => {
    const edits = elements().filter((e) => e.name === 'Edit');
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    expect(edit.confidence).toBe('ambiguous');
    expect(edit.locator.unique).toBe(false);
    const hasHint =
      edit.locator.scope?.some((s) => s.filterText !== undefined) === true ||
      edit.collection !== undefined;
    expect(hasHint).toBe(true);
  });

  it('records the New user dialog: OPENS edge to modal screen + dialog-scoped elements', () => {
    const modal = screens().find((s) => s.state === 'modal:Create user');
    expect(modal).toBeDefined();
    const opens = graph.edges.find((e) => e.type === 'OPENS' && e.to === modal!.id);
    expect(opens).toBeDefined();
    expect(opens!.confidence).toBe('observed');

    const scoped = elements().filter((el) =>
      el.locator.scope?.some((s) => s.role === 'dialog'),
    );
    expect(scoped.some((el) => el.role === 'textbox' && el.name === 'Name')).toBe(true);
    expect(scoped.some((el) => el.role === 'button' && el.name === 'Cancel')).toBe(true);
  });

  it('observes Load more calling GET /api/users (CALLS edge with timestamp-free evidence)', () => {
    const api = apis().find((a) => a.method === 'GET' && a.urlPattern === '/api/users');
    expect(api).toBeDefined();
    const calls = graph.edges.find((e) => e.type === 'CALLS' && e.to === api!.id);
    expect(calls).toBeDefined();
    expect(calls!.confidence).toBe('observed');
    expect(calls!.source).toBe('runtime');
    expect(calls!.evidence).toMatch(/GET \/api\/users/);
    expect(calls!.evidence).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('clicks Save exactly once, observes the POST, marks it mutate with the report note', () => {
    const mutate = actions().find((a) => a.safety === 'mutate');
    expect(mutate).toBeDefined();
    expect(mutate!.detail).toContain('POST /api/users/1');
    const noted = graph.edges.filter((e) =>
      e.evidence?.includes('unexpected mutation on click'),
    );
    expect(noted.length).toBeGreaterThanOrEqual(1);
    // Policy: Save's name passes the denylist, so it IS clicked once; the POST
    // is detected, the action is marked mutate, and it is never clicked again.
    const posts = site.log.filter((r) => r.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', path: '/api/users/1' }]);
  });

  it('never clicks the Delete user button (denylist), per the server log', () => {
    expect(site.log.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    // The only non-GET the whole crawl produced is the single Save POST.
    expect(site.log.filter((r) => r.method !== 'GET')).toHaveLength(1);
    const del = elements().find((e) => e.name === 'Delete user');
    expect(del).toBeDefined();
    const triggers = graph.edges.filter((e) => e.type === 'TRIGGERS' && e.from === del!.id);
    expect(triggers).toHaveLength(0);
  });

  it('flags the icon-only button as unnamed', () => {
    const unnamed = elements().filter((e) => e.unnamed === true && e.role === 'button');
    expect(unnamed.length).toBeGreaterThanOrEqual(1);
  });

  it('sets uniqueness flags from live locator counts', () => {
    const newUser = elements().find((e) => e.name === 'New user');
    expect(newUser).toBeDefined();
    expect(newUser!.locator.unique).toBe(true);
    const edit = elements().find((e) => e.name === 'Edit');
    expect(edit!.locator.unique).toBe(false);
  });

  it('records observed NAVIGATES_TO edges for same-origin link clicks', () => {
    const nav = graph.edges.filter((e) => e.type === 'NAVIGATES_TO');
    expect(nav.length).toBeGreaterThanOrEqual(1);
    for (const e of nav) {
      expect(e.confidence).toBe('observed');
      expect(e.source).toBe('runtime');
    }
  });

  it('never leaves the allowed origin (off-origin link is not followed)', () => {
    expect(JSON.stringify(graph)).not.toContain('example.com');
  });

  it('is deterministic in shape: sorted nodes/edges, runtime facts, no dates in ids or evidence', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const keys = graph.edges.map((e) => edgeKey(e));
    expect(keys).toEqual([...keys].sort());
    for (const n of graph.nodes) {
      expect(n.source).toBe('runtime');
      expect(n.id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    for (const e of graph.edges) {
      expect(e.evidence ?? '').not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
