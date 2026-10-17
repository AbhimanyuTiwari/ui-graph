/**
 * Token comparison: answering from the graph versus reading the fixture
 * source an agent would otherwise have to pull into context.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { angularAdapter } from '../../src/adapters/angular';
import { makeQueryApi } from '../../src/core/query';
import { estimateTokens } from '../../src/core/tokens';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/angular-app');

function sourceTokens(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const abs = path.join(current, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.(ts|html)$/.test(name)) total += estimateTokens(readFileSync(abs, 'utf8'));
    }
  };
  walk(dir);
  return total;
}

describe('with-graph versus without-graph tokens', () => {
  it('answers the angular fixture from the graph in fewer tokens than reading its source', async () => {
    const graph = await angularAdapter.extract(FIXTURE);
    const api = makeQueryApi(graph);
    const answers = [
      api.getScreen('/users'),
      api.getScreen('/users/:id'),
      api.getScreen('/login'),
      api.pathTo('/users/:id'),
      api.pathTo('/users#modal:CreateUserDialog'),
      api.explain('Sign in'),
      api.locatorsFor('email'),
    ];
    const withGraph = answers.reduce((sum, answer) => sum + estimateTokens(JSON.stringify(answer)), 0);
    const withoutGraph = sourceTokens(path.join(FIXTURE, 'src'));
    expect(withoutGraph).toBeGreaterThan(withGraph);
    expect(withGraph).toBeGreaterThan(0);
    // Locked after the first measurement so a later change that blows the
    // budget fails here instead of silently.
    expect(withGraph).toBeLessThan(1500);
    const biggest = Math.max(...answers.map((answer) => estimateTokens(JSON.stringify(answer))));
    expect(biggest).toBeLessThan(withoutGraph);
  });
});
