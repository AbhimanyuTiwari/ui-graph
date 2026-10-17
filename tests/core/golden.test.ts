/**
 * Golden eval: exact answers for the query API over the fixture graph,
 * pinned in evals/core-queries.json.
 *
 * Regenerate (after an intentional behavior change) with:
 *   UPDATE_GOLDEN=1 npx vitest run tests/core/golden.test.ts
 * then review the diff by hand before committing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeQueryApi } from '../../src/core/query';
import { estimateTokens } from '../../src/core/tokens';
import { buildFixtureGraph, ids, USERS_FILE } from './fixture';

const goldenPath = fileURLToPath(new URL('../../evals/core-queries.json', import.meta.url));

function computeCases(): Record<string, unknown> {
  const api = makeQueryApi(buildFixtureGraph());
  return {
    'getScreen /login default': api.getScreen('/login'),
    'getScreen /users default': api.getScreen('/users'),
    'getScreen /users modal:filters': api.getScreen('/users', 'modal:filters'),
    'getScreen /users/:id default': api.getScreen('/users/:id'),
    'pathTo /users/:id': api.pathTo('/users/:id'),
    'pathTo /users#modal:filters': api.pathTo('/users#modal:filters'),
    'pathTo /users#modal:confirmDelete': api.pathTo('/users#modal:confirmDelete'),
    'pathTo /users/:id from /users': api.pathTo('/users/:id', '/users'),
    'locatorsFor alice': api.locatorsFor('alice'),
    'locatorsFor edit': api.locatorsFor('edit'),
    'actionsOf Delete user': api.actionsOf('Delete user'),
    'explain /users': api.explain('/users'),
    'explain Delete user': api.explain('Delete user'),
    [`staleCheck ${USERS_FILE}`]: api.staleCheck([USERS_FILE]),
  };
}

describe('golden core queries (evals/core-queries.json)', () => {
  const actual = computeCases();
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, unknown>;

  it('covers the same cases', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });

  for (const key of Object.keys(golden)) {
    it(`answers exactly: ${key}`, () => {
      // Round-trip through JSON so optional undefined fields compare like the file.
      expect(JSON.parse(JSON.stringify(actual[key] ?? null))).toEqual(golden[key]);
    });
  }

  it('keeps every golden answer under the 1k-token budget', () => {
    for (const [key, value] of Object.entries(actual)) {
      expect(estimateTokens(JSON.stringify(value)), key).toBeLessThan(1000);
    }
  });

  it('proves pathTo never routes through the destructive delete action', () => {
    // The confirm-delete modal exists in the graph with an OPENS edge from the
    // destructive action, yet no path may use it.
    expect(golden['pathTo /users#modal:confirmDelete']).toBeNull();
    expect(actual['pathTo /users#modal:confirmDelete']).toBeNull();
    const g = buildFixtureGraph();
    expect(g.edges.some((e) => e.from === ids.aDelete && e.type === 'OPENS')).toBe(true);
    // And no golden path anywhere clicks the delete button.
    const text = JSON.stringify(golden);
    expect(text.includes('Delete user')).toBe(true); // present as data...
    for (const k of Object.keys(golden)) {
      if (!k.startsWith('pathTo')) continue;
      const steps = (golden[k] as { steps?: Array<{ rendered?: string }> } | null)?.steps ?? [];
      for (const s of steps) {
        expect(s.rendered ?? '').not.toContain('Delete user');
      }
    }
  });
});
