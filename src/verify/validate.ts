/**
 * Validation of untrusted agent output (probe plans) plus the local, fully
 * deterministic evidence judgment. Agent output crosses a trust boundary:
 * everything is schema-checked and safety-checked before anything runs.
 */
import { DESTRUCTIVE_TEXT, ProbePlanSchema } from '../schemas.js';
import type { Evidence, LocatorDescriptor, ProbePlan, Verdict } from '../types.js';

export class PlanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRejectedError';
  }
}

/** Every human-readable string a locator could use to pick an element. */
function locatorTexts(loc: LocatorDescriptor | undefined): string[] {
  if (!loc) return [];
  const own = [loc.name, loc.nameRegex, loc.filterText, loc.css, loc.attr?.value].filter(
    (s): s is string => typeof s === 'string',
  );
  return own.concat(...(loc.scope ?? []).map(locatorTexts));
}

function isOnOrigin(url: string, baseUrl: string | undefined): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true; // relative path
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) return true; // 'users/5'
  if (!baseUrl) return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Build the plan validator. Rules enforced on top of the zod schema:
 *  - no click/press on anything whose locator text matches DESTRUCTIVE_TEXT;
 *  - goto only to relative paths or URLs on the configured base origin;
 *  - the plan must target the task's edge (checked again by the queue).
 */
export function makeValidatePlan(baseUrl?: string): (plan: unknown) => ProbePlan {
  return (raw: unknown): ProbePlan => {
    const parsed = ProbePlanSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new PlanRejectedError(
        `invalid probe plan: ${first ? `${first.path.join('.')}: ${first.message}` : 'schema error'}`,
      );
    }
    const plan = parsed.data as unknown as ProbePlan;
    for (const [i, step] of plan.steps.entries()) {
      if ((step.action === 'click' || step.action === 'press') && step.locator) {
        const hit = locatorTexts(step.locator).find((t) => DESTRUCTIVE_TEXT.test(t));
        if (hit) {
          throw new PlanRejectedError(
            `rejected: step ${i} would ${step.action} a destructive/mutating control ("${hit}")`,
          );
        }
      }
      if (step.action === 'goto') {
        if (!step.url) throw new PlanRejectedError(`rejected: step ${i} goto without url`);
        if (!isOnOrigin(step.url, baseUrl)) {
          throw new PlanRejectedError(
            `rejected: step ${i} goto is off-origin ("${step.url}"); probes may only visit the configured base origin`,
          );
        }
      }
    }
    return plan;
  };
}

/**
 * Deterministic verdict from evidence. Used as the default when the crawl
 * module's own evidence checker is not wired in.
 *  - any failed step -> 'unreached' (we never got to test the claim);
 *  - all expectations matched -> 'verified';
 *  - otherwise -> 'contradicted'.
 */
export function checkEvidence(plan: ProbePlan, evidence: Evidence): Verdict {
  if (evidence.stepResults.some((r) => !r.ok)) return 'unreached';
  if (evidence.matched.length < plan.expect.length) return 'unreached';
  return evidence.matched.every(Boolean) ? 'verified' : 'contradicted';
}
