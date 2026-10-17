/**
 * Zod schemas for everything that crosses a trust boundary:
 * probe plans and reviews submitted by coding agents, and task files on disk.
 * Agent output is untrusted input — validate before anything runs.
 */
import { z } from 'zod';

export const LocatorDescriptorSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      strategy: z.enum(['role', 'label', 'placeholder', 'text', 'attr', 'css']),
      role: z.string().max(50).optional(),
      name: z.string().max(300).optional(),
      nameRegex: z.string().max(300).optional(),
      attr: z.object({ name: z.string().max(50), value: z.string().max(300) }).optional(),
      css: z.string().max(300).optional(),
      scope: z.array(LocatorDescriptorSchema).max(4).optional(),
      filterText: z.string().max(300).optional(),
      unique: z.boolean().optional(),
    })
    .strict(),
);

export const ProbeStepSchema = z
  .object({
    action: z.enum(['goto', 'click', 'fill', 'press', 'waitFor']),
    url: z.string().max(2000).optional(),
    locator: LocatorDescriptorSchema.optional(),
    value: z.string().max(1000).optional(),
  })
  .strict();

export const ProbeExpectationSchema = z
  .object({
    type: z.enum(['element', 'url', 'request']),
    locator: LocatorDescriptorSchema.optional(),
    urlPattern: z.string().max(500).optional(),
    method: z.string().max(10).optional(),
  })
  .strict();

export const ProbePlanSchema = z
  .object({
    edgeKey: z.string().max(300),
    steps: z.array(ProbeStepSchema).min(1).max(25),
    expect: z.array(ProbeExpectationSchema).min(1).max(10),
  })
  .strict();

export const VerifyTaskSchema = z
  .object({
    id: z.string().max(100),
    type: z.enum(['verify_edge', 'review_edge']),
    edgeKey: z.string().max(300),
    status: z.enum(['open', 'leased', 'done', 'failed']),
    leaseUntil: z.string().optional(),
    bundle: z.string().max(20000).optional(),
    verdict: z.enum(['verified', 'contradicted', 'unreached']).optional(),
  })
  .strict();

/** Denylist applied to anything a probe or crawl would click or submit. */
export const DESTRUCTIVE_TEXT = /\b(delete|remove|destroy|pay|purchase|buy|send|publish|logout|log out|sign out|cancel account|deactivate)\b/i;
