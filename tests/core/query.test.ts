import { describe, expect, it } from 'vitest';
import { stableId } from '../../src/core/ids';
import { makeQueryApi } from '../../src/core/query';
import { SCHEMA_VERSION } from '../../src/types';
import type { ActionNode, Graph, GraphEdge, GraphNode } from '../../src/types';
import { buildFixtureGraph, ids, USERS_FILE } from './fixture';

const api = () => makeQueryApi(buildFixtureGraph());

describe('getScreen', () => {
  it('returns null for unknown routes and states', () => {
    expect(api().getScreen('/nope')).toBeNull();
    expect(api().getScreen('/users', 'no-such-state')).toBeNull();
  });

  it('matches a param route by its literal fullPath', () => {
    const a = api().getScreen('/users/:id');
    expect(a).not.toBeNull();
    expect(a!.screen).toEqual({ route: '/users/:id', state: 'default' });
    expect(a!.preconditions).toEqual(['AuthGuard']);
  });

  it('lists elements with rendered Playwright code and action summaries', () => {
    const a = api().getScreen('/users');
    expect(a).not.toBeNull();
    expect(a!.preconditions).toEqual(['AuthGuard']);
    expect(a!.truncated).toBeUndefined();
    const names = a!.elements.map((e) => e.name).sort();
    expect(names).toEqual(['Alice', 'Delete user', 'Edit', 'Filters']);
    const alice = a!.elements.find((e) => e.name === 'Alice')!;
    expect(alice.rendered).toBe(
      "page.getByRole('listitem').filter({ hasText: 'Alice' }).getByRole('link', { name: 'Alice' })",
    );
    expect(alice.actions).toEqual(['/users/:id']);
    const del = a!.elements.find((e) => e.name === 'Delete user')!;
    expect(del.actions).toEqual(['ConfirmDeleteDialog']);
  });

  it('reaches modal screens by state', () => {
    const a = api().getScreen('/users', 'modal:filters');
    expect(a!.elements.map((e) => e.name)).toEqual(['Apply']);
  });

  it('caps elements at 40 and sets truncated', () => {
    const g = buildFixtureGraph();
    for (let i = 0; i < 45; i++) {
      const id = stableId('element', '/users', `extra-${i}`);
      g.nodes.push({
        id,
        kind: 'element',
        locator: { strategy: 'role', role: 'button', name: `Extra ${i}` },
        name: `Extra ${i}`,
        confidence: 'observed',
        source: 'runtime',
      });
      g.edges.push({ from: ids.sUsers, to: id, type: 'CONTAINS', confidence: 'observed', source: 'runtime' });
    }
    const a = makeQueryApi(g).getScreen('/users');
    expect(a!.elements).toHaveLength(40);
    expect(a!.truncated).toBe(true);
  });
});

describe('locatorsFor', () => {
  it('matches name, text, attrs values and i18nKey case-insensitively', () => {
    const g = buildFixtureGraph();
    const byAttr = stableId('element', '/users', 'attr-match');
    g.nodes.push({
      id: byAttr,
      kind: 'element',
      locator: { strategy: 'attr', attr: { name: 'formcontrolname', value: 'searchTerm' } },
      attrs: { formcontrolname: 'searchTerm' },
      confidence: 'extracted',
      source: 'static',
    });
    const q = makeQueryApi(g);
    expect(q.locatorsFor('ALICE').map((e) => e.id)).toEqual([ids.eAlice]);
    expect(q.locatorsFor('searchterm').map((e) => e.id)).toEqual([byAttr]);
    expect(q.locatorsFor('zzz-none')).toEqual([]);
  });

  it('ranks verified first, then exact name matches, then substrings', () => {
    const g = buildFixtureGraph();
    const mk = (idPart: string, name: string, confidence: GraphNode['confidence']): string => {
      const id = stableId('element', 'rank', idPart);
      g.nodes.push({
        id,
        kind: 'element',
        locator: { strategy: 'role', role: 'button', name },
        name,
        confidence,
        source: 'static',
      });
      return id;
    };
    const exactUnverified = mk('a', 'Save', 'extracted');
    const substrVerified = mk('b', 'Save draft', 'verified');
    const substrUnverified = mk('c', 'Autosave toggle', 'inferred');
    const got = makeQueryApi(g).locatorsFor('save').map((e) => e.id);
    expect(got).toEqual([substrVerified, exactUnverified, substrUnverified]);
  });
});

describe('pathTo', () => {
  it('starts from an entry route (no inbound NAVIGATES_TO) with a goto first step', () => {
    const p = api().pathTo('/users/:id');
    expect(p).not.toBeNull();
    expect(p!.target).toEqual({ route: '/users/:id', state: 'default' });
    expect(p!.steps.map((s) => s.do)).toEqual(['goto', 'click', 'click']);
    expect(p!.steps[0]).toEqual({ do: 'goto', url: '/login' });
    expect(p!.steps[1]!.rendered).toBe("page.getByRole('button', { name: 'Log in' })");
    expect(p!.steps[2]!.rendered).toBe(
      "page.getByRole('listitem').filter({ hasText: 'Alice' }).getByRole('link', { name: 'Alice' })",
    );
    expect(p!.preconditions).toEqual(['AuthGuard']);
  });

  it('reaches a modal screen through a safe OPENS action (multi-hop)', () => {
    const p = api().pathTo('/users#modal:filters');
    expect(p).not.toBeNull();
    expect(p!.target).toEqual({ route: '/users', state: 'modal:filters' });
    expect(p!.steps.map((s) => s.do)).toEqual(['goto', 'click', 'click']);
    expect(p!.steps[2]!.rendered).toBe("page.getByRole('button', { name: 'Filters' })");
  });

  it('never routes through a non-safe action', () => {
    // The confirm-delete modal is only reachable via a destructive action.
    expect(api().pathTo('/users#modal:confirmDelete')).toBeNull();
  });

  it('routes through the same edge once its action is safe (proves the skip is safety-driven)', () => {
    const g = buildFixtureGraph();
    const del = g.nodes.find((n) => n.id === ids.aDelete) as ActionNode;
    del.safety = 'safe';
    const p = makeQueryApi(g).pathTo('/users#modal:confirmDelete');
    expect(p).not.toBeNull();
    expect(p!.steps[2]!.rendered).toBe("page.getByRole('button', { name: 'Delete user' })");
  });

  it('honors an explicit from and still leads with goto', () => {
    const p = api().pathTo('/users/:id', '/users');
    expect(p!.steps).toHaveLength(2);
    expect(p!.steps[0]).toEqual({ do: 'goto', url: '/users' });
    expect(p!.steps[1]!.do).toBe('click');
  });

  it('resolves a screen title as target', () => {
    const p = api().pathTo('User detail');
    expect(p!.target).toEqual({ route: '/users/:id', state: 'default' });
  });

  it('falls back to the shortest path from any route when every route has inbound navigation', () => {
    // Two routes that navigate to each other: no entry route exists.
    const rA = stableId('route', '/a');
    const rB = stableId('route', '/b');
    const sA = stableId('screen', '/a', 'default');
    const sB = stableId('screen', '/b', 'default');
    const eGo = stableId('element', '/a', 'go');
    const eBack = stableId('element', '/b', 'back');
    const aGo = stableId('action', 'go');
    const aBack = stableId('action', 'back');
    const nodes: GraphNode[] = [
      { id: rA, kind: 'route', path: 'a', fullPath: '/a', paramNames: [], guards: [], confidence: 'extracted', source: 'static' },
      { id: rB, kind: 'route', path: 'b', fullPath: '/b', paramNames: [], guards: [], confidence: 'extracted', source: 'static' },
      { id: sA, kind: 'screen', routeId: rA, state: 'default', confidence: 'observed', source: 'runtime' },
      { id: sB, kind: 'screen', routeId: rB, state: 'default', confidence: 'observed', source: 'runtime' },
      { id: eGo, kind: 'element', locator: { strategy: 'role', role: 'link', name: 'Go' }, name: 'Go', confidence: 'observed', source: 'runtime' },
      { id: eBack, kind: 'element', locator: { strategy: 'role', role: 'link', name: 'Back' }, name: 'Back', confidence: 'observed', source: 'runtime' },
      { id: aGo, kind: 'action', type: 'navigate', safety: 'safe', confidence: 'observed', source: 'runtime' },
      { id: aBack, kind: 'action', type: 'navigate', safety: 'safe', confidence: 'observed', source: 'runtime' },
    ];
    const edges: GraphEdge[] = [
      { from: rA, to: sA, type: 'HAS_SCREEN', confidence: 'observed', source: 'runtime' },
      { from: rB, to: sB, type: 'HAS_SCREEN', confidence: 'observed', source: 'runtime' },
      { from: sA, to: eGo, type: 'CONTAINS', confidence: 'observed', source: 'runtime' },
      { from: sB, to: eBack, type: 'CONTAINS', confidence: 'observed', source: 'runtime' },
      { from: eGo, to: aGo, type: 'TRIGGERS', confidence: 'observed', source: 'runtime' },
      { from: eBack, to: aBack, type: 'TRIGGERS', confidence: 'observed', source: 'runtime' },
      { from: aGo, to: rB, type: 'NAVIGATES_TO', confidence: 'observed', source: 'runtime' },
      { from: aBack, to: rA, type: 'NAVIGATES_TO', confidence: 'observed', source: 'runtime' },
    ];
    const g: Graph = {
      schemaVersion: SCHEMA_VERSION,
      generator: { name: 'uigraph', version: '0.1.0' },
      app: { name: 'cycle', framework: 'angular' },
      builtAt: '2026-10-17T00:00:00.000Z',
      fileHashes: {},
      nodes,
      edges,
    };
    const p = makeQueryApi(g).pathTo('/b');
    expect(p!.steps).toEqual([{ do: 'goto', url: '/b' }]);
  });

  it('returns null for unresolvable targets', () => {
    expect(api().pathTo('/nowhere')).toBeNull();
  });
});

describe('actionsOf', () => {
  it('resolves by id or by name', () => {
    const expected = [{ type: 'dialog', safety: 'destructive', detail: 'ConfirmDeleteDialog' }];
    expect(api().actionsOf(ids.eDelete)).toEqual(expected);
    expect(api().actionsOf('delete user')).toEqual(expected);
    expect(api().actionsOf('no such element')).toEqual([]);
  });
});

describe('staleCheck', () => {
  it('flags nodes by file and maps them to owning routes', () => {
    const a = api().staleCheck([USERS_FILE]);
    expect(a.staleRoutes).toEqual(['/users']);
    expect(a.staleNodeIds).toContain(ids.rUsers);
    expect(a.staleNodeIds).toContain(ids.eAlice);
    expect(a.staleNodeIds).toContain(ids.aDelete);
    expect(a.staleNodeIds).not.toContain(ids.rLogin);
    expect(a.summary).toContain('stale');
  });

  it('ignores files the graph does not know', () => {
    const a = api().staleCheck(['src/app/unrelated.ts']);
    expect(a.staleNodeIds).toEqual([]);
    expect(a.staleRoutes).toEqual([]);
  });
});

describe('explain', () => {
  it('returns null for unknown names', () => {
    expect(api().explain('does-not-exist')).toBeNull();
  });

  it('describes kind, definition site, confidence and connections', () => {
    const text = api().explain('/users');
    expect(text).not.toBeNull();
    expect(text).toContain('route');
    expect(text).toContain(USERS_FILE);
    expect(text).toContain('extracted');
    expect(text).toContain('HAS_SCREEN');
    expect(text).toContain('REQUIRES');
    expect(text).toContain('NAVIGATES_TO');
  });

  it('resolves elements by name too', () => {
    const text = api().explain('Delete user');
    expect(text).toContain('element');
    expect(text).toContain('TRIGGERS');
  });
});
