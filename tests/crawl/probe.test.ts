/**
 * Probe runner tests: plan validation (untrusted agent output), execution
 * against the fixture site, and evidence judging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSite } from '../../fixtures/site/serve';
import { checkEvidence, runProbe, validatePlan } from '../../src/crawl/probe';
import type { ProbePlan } from '../../src/types';

let site: Awaited<ReturnType<typeof startSite>>;

beforeAll(async () => {
  site = await startSite();
});

afterAll(async () => {
  await site.close();
});

const openDialogSteps: ProbePlan['steps'] = [
  { action: 'goto', url: '/users.html' },
  { action: 'click', locator: { strategy: 'role', role: 'button', name: 'New user' } },
];

describe('validatePlan', () => {
  it('rejects a click on a destructive locator', () => {
    const plan = {
      edgeKey: 'a|TRIGGERS|b',
      steps: [
        { action: 'click', locator: { strategy: 'role', role: 'button', name: 'Delete user' } },
      ],
      expect: [{ type: 'url', urlPattern: '.' }],
    };
    expect(() => validatePlan(plan, site.url)).toThrow(/destructive/i);
  });

  it('rejects a destructive filterText too', () => {
    const plan = {
      edgeKey: 'a|TRIGGERS|b',
      steps: [
        {
          action: 'click',
          locator: { strategy: 'role', role: 'button', name: 'OK', filterText: 'remove' },
        },
      ],
      expect: [{ type: 'url', urlPattern: '.' }],
    };
    expect(() => validatePlan(plan, site.url)).toThrow(/destructive/i);
  });

  it('rejects an off-origin goto', () => {
    const plan = {
      edgeKey: 'a|NAVIGATES_TO|b',
      steps: [{ action: 'goto', url: 'https://evil.example/pwn' }],
      expect: [{ type: 'url', urlPattern: '.' }],
    };
    expect(() => validatePlan(plan, site.url)).toThrow(/origin/i);
  });

  it('rejects malformed and oversized plans via the schema', () => {
    expect(() => validatePlan({ nope: true })).toThrow();
    const oversized = {
      edgeKey: 'a|OPENS|b',
      steps: Array.from({ length: 26 }, () => ({
        action: 'waitFor',
        locator: { strategy: 'role', role: 'heading' },
      })),
      expect: [{ type: 'url', urlPattern: '.' }],
    };
    expect(() => validatePlan(oversized, site.url)).toThrow();
  });

  it('accepts a well-formed safe plan and returns it typed', () => {
    const plan = validatePlan(
      {
        edgeKey: 'a|OPENS|b',
        steps: openDialogSteps,
        expect: [{ type: 'element', locator: { strategy: 'role', role: 'dialog' } }],
      },
      site.url,
    );
    expect(plan.steps).toHaveLength(2);
  });
});

describe('runProbe + checkEvidence', () => {
  it('verifies a plan that opens the Create user dialog', async () => {
    const plan: ProbePlan = {
      edgeKey: 'a|OPENS|b',
      steps: openDialogSteps,
      expect: [
        {
          type: 'element',
          locator: {
            strategy: 'role',
            role: 'heading',
            name: 'Create user',
            scope: [{ strategy: 'role', role: 'dialog' }],
          },
        },
        { type: 'url', urlPattern: '/users\\.html' },
      ],
    };
    const evidence = await runProbe(plan, site.url);
    expect(evidence.stepResults.every((r) => r.ok)).toBe(true);
    expect(evidence.matched).toEqual([true, true]);
    expect(checkEvidence(plan, evidence)).toBe('verified');
  });

  it('verifies a request expectation (Load more -> GET /api/users)', async () => {
    const plan: ProbePlan = {
      edgeKey: 'a|CALLS|b',
      steps: [
        { action: 'goto', url: '/users.html' },
        { action: 'click', locator: { strategy: 'role', role: 'button', name: 'Load more' } },
        {
          action: 'waitFor',
          locator: { strategy: 'text', name: 'Loaded user' },
        },
      ],
      expect: [{ type: 'request', method: 'GET', urlPattern: '/api/users$' }],
    };
    const evidence = await runProbe(plan, site.url);
    expect(checkEvidence(plan, evidence)).toBe('verified');
  });

  it('contradicts a plan whose expected element never appears', async () => {
    const plan: ProbePlan = {
      edgeKey: 'a|OPENS|b',
      steps: openDialogSteps,
      expect: [
        {
          type: 'element',
          locator: { strategy: 'role', role: 'heading', name: 'Nonexistent heading' },
        },
      ],
    };
    const evidence = await runProbe(plan, site.url);
    expect(evidence.stepResults.every((r) => r.ok)).toBe(true);
    expect(evidence.matched).toEqual([false]);
    expect(checkEvidence(plan, evidence)).toBe('contradicted');
  });

  it('reports unreached when a step fails before expectations can be judged', async () => {
    const plan: ProbePlan = {
      edgeKey: 'a|OPENS|b',
      steps: [
        { action: 'goto', url: '/users.html' },
        { action: 'click', locator: { strategy: 'role', role: 'button', name: 'No such button' } },
      ],
      expect: [{ type: 'element', locator: { strategy: 'role', role: 'dialog' } }],
    };
    const evidence = await runProbe(plan, site.url);
    expect(evidence.stepResults.at(-1)?.ok).toBe(false);
    expect(checkEvidence(plan, evidence)).toBe('unreached');
  }, 30_000);

  it('refuses to run a destructive plan outright', async () => {
    const plan: ProbePlan = {
      edgeKey: 'a|TRIGGERS|b',
      steps: [
        { action: 'goto', url: '/user.html' },
        { action: 'click', locator: { strategy: 'role', role: 'button', name: 'Delete user' } },
      ],
      expect: [{ type: 'request', method: 'DELETE', urlPattern: '/api/users/1$' }],
    };
    await expect(runProbe(plan, site.url)).rejects.toThrow(/destructive/i);
    expect(site.log.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });
});
