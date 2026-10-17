import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { angularAdapter } from '../src/adapters/angular/index.js';
import { makeQueryApi } from '../src/core/query.js';
import { estimateTokens } from '../src/core/tokens.js';

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

const graph = await angularAdapter.extract('fixtures/angular-app');
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
const parts = answers.map((answer) => estimateTokens(JSON.stringify(answer)));
const withGraph = parts.reduce((sum, n) => sum + n, 0);
const withoutGraph = sourceTokens('fixtures/angular-app/src');
console.log(JSON.stringify({ parts, withGraph, withoutGraph, nodes: graph.nodes.length }));
