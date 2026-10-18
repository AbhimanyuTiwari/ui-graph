/**
 * Probe runner: validates untrusted agent-authored probe plans, executes them
 * in a fresh browser context, and judges the collected evidence.
 *
 * Plans come from coding agents and are UNTRUSTED. validatePlan is the gate:
 * schema parse first (shape, step/expectation caps), then safety checks —
 * no destructive locator text anywhere in a click/fill/press step, no goto
 * leaving the given origin. runProbe re-validates as defense in depth and
 * additionally pins the browser context to the baseUrl origin via a network
 * route guard, so even a bug cannot leak a request off-origin.
 */
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type {
  Evidence,
  Graph,
  LocatorDescriptor,
  ProbeExpectation,
  ProbePlan,
  ProbeStep,
  Verdict,
} from '../types.js';
import { DESTRUCTIVE_TEXT, ProbePlanSchema } from '../schemas.js';
import { buildLocator } from './locate.js';

const STEP_TIMEOUT_MS = 5_000;
const EXPECT_TIMEOUT_MS = 2_000;

function destructiveTextIn(desc: LocatorDescriptor): string | undefined {
  for (const value of [desc.name, desc.nameRegex, desc.filterText]) {
    if (value !== undefined && DESTRUCTIVE_TEXT.test(value)) return value;
  }
  for (const scope of desc.scope ?? []) {
    const hit = destructiveTextIn(scope);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Parse and safety-check an untrusted plan. Throws with a reason on:
 * schema violations (including >25 steps), destructive locator text on any
 * click/fill/press step, and any goto that leaves `origin` (when given).
 * When a `graph` is given, the plan's edgeKey must name an edge in it.
 */
export function validatePlan(plan: unknown, origin?: string, graph?: Graph): ProbePlan {
  const parsed = ProbePlanSchema.parse(plan) as ProbePlan;

  for (const step of parsed.steps) {
    if (
      (step.action === 'click' || step.action === 'fill' || step.action === 'press') &&
      step.locator !== undefined
    ) {
      const hit = destructiveTextIn(step.locator);
      if (hit !== undefined) {
        throw new Error(
          `probe plan rejected: ${step.action} step targets destructive text "${hit}"`,
        );
      }
    }
    if (step.action === 'goto' && step.url !== undefined && origin !== undefined) {
      const allowed = new URL(origin).origin;
      let resolved: URL;
      try {
        resolved = new URL(step.url, allowed);
      } catch {
        throw new Error(`probe plan rejected: unparseable goto url "${step.url}"`);
      }
      if (resolved.origin !== allowed) {
        throw new Error(
          `probe plan rejected: goto leaves the allowed origin (${resolved.origin} != ${allowed})`,
        );
      }
    }
  }

  if (graph !== undefined) {
    const known = graph.edges.some((e) => `${e.from}|${e.type}|${e.to}` === parsed.edgeKey);
    if (!known) {
      throw new Error(`probe plan rejected: edgeKey "${parsed.edgeKey}" not found in graph`);
    }
  }

  return parsed;
}

async function runStep(page: Page, step: ProbeStep, baseUrl: string): Promise<void> {
  switch (step.action) {
    case 'goto': {
      if (step.url === undefined) throw new Error('goto step needs a url');
      const target = new URL(step.url, baseUrl).toString();
      await page.goto(target, { timeout: STEP_TIMEOUT_MS, waitUntil: 'load' });
      return;
    }
    case 'click': {
      if (step.locator === undefined) throw new Error('click step needs a locator');
      await buildLocator(page, step.locator).click({ timeout: STEP_TIMEOUT_MS });
      return;
    }
    case 'fill': {
      if (step.locator === undefined || step.value === undefined) {
        throw new Error('fill step needs a locator and a value');
      }
      await buildLocator(page, step.locator).fill(step.value, { timeout: STEP_TIMEOUT_MS });
      return;
    }
    case 'press': {
      if (step.locator === undefined || step.value === undefined) {
        throw new Error('press step needs a locator and a key value');
      }
      await buildLocator(page, step.locator).press(step.value, { timeout: STEP_TIMEOUT_MS });
      return;
    }
    case 'waitFor': {
      if (step.locator === undefined) throw new Error('waitFor step needs a locator');
      await buildLocator(page, step.locator).waitFor({
        state: 'visible',
        timeout: STEP_TIMEOUT_MS,
      });
      return;
    }
  }
}

async function checkExpectation(
  page: Page,
  exp: ProbeExpectation,
  requests: Array<{ method: string; url: string }>,
  finalUrl: string,
): Promise<boolean> {
  switch (exp.type) {
    case 'element': {
      if (exp.locator === undefined) return false;
      try {
        await buildLocator(page, exp.locator).waitFor({
          state: 'visible',
          timeout: EXPECT_TIMEOUT_MS,
        });
        return true;
      } catch {
        return false;
      }
    }
    case 'url': {
      if (exp.urlPattern === undefined) return false;
      return new RegExp(exp.urlPattern).test(finalUrl);
    }
    case 'request': {
      if (exp.urlPattern === undefined) return false;
      const pattern = new RegExp(exp.urlPattern);
      const method = exp.method?.toUpperCase();
      return requests.some(
        (r) => (method === undefined || r.method.toUpperCase() === method) && pattern.test(r.url),
      );
    }
  }
}

/**
 * Execute a validated plan in a fresh browser context against baseUrl.
 * Each step gets a 5s timeout; the first failing step stops execution
 * (recorded as ok:false) and all expectations are marked unmatched.
 */
export async function runProbe(plan: ProbePlan, baseUrl: string): Promise<Evidence> {
  const origin = new URL(baseUrl).origin;
  // Defense in depth: re-validate even if the caller already did.
  validatePlan(plan, origin);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      try {
        if (new URL(route.request().url()).origin === origin) return route.continue();
      } catch {
        // fall through to abort
      }
      return route.abort();
    });
    const page = await context.newPage();

    const requests: Array<{ method: string; url: string }> = [];
    page.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));

    const stepResults: Evidence['stepResults'] = [];
    let failed = false;
    for (const step of plan.steps) {
      try {
        await runStep(page, step, baseUrl);
        stepResults.push({ ok: true });
      } catch (err) {
        const note = err instanceof Error ? err.message.split('\n')[0] : String(err);
        stepResults.push({ ok: false, note: `${step.action} failed: ${note ?? 'unknown'}` });
        failed = true;
        break;
      }
    }

    // Let a just-fired fetch settle before judging request expectations.
    if (!failed) {
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
    }

    const finalUrl = page.url();
    const matched: boolean[] = [];
    for (const exp of plan.expect) {
      if (failed) {
        matched.push(false);
        continue;
      }
      matched.push(await checkExpectation(page, exp, requests, finalUrl));
    }

    return {
      ranAt: new Date().toISOString(),
      finalUrl,
      stepResults,
      requests,
      matched,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Judge evidence against the plan:
 *  - any step failed -> the expectations could never be evaluated: 'unreached'
 *  - all steps ran and every expectation matched -> 'verified'
 *  - steps ran but an expectation positively failed -> 'contradicted'
 */
export function checkEvidence(plan: ProbePlan, evidence: Evidence): Verdict {
  if (evidence.stepResults.length < plan.steps.length || evidence.stepResults.some((r) => !r.ok)) {
    return 'unreached';
  }
  if (evidence.matched.length === plan.expect.length && evidence.matched.every(Boolean)) {
    return 'verified';
  }
  return 'contradicted';
}
