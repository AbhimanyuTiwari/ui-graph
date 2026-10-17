import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stableId } from '../../src/core/ids.js';
import {
  createTasks,
  enqueueTasks,
  graphPathOf,
  nextTask,
  queueDir,
  queueSummary,
  readTask,
  recipesDir,
  submitProbe,
  submitReview,
  writeConfig,
  LEASE_MS,
} from '../../src/verify/queue.js';
import { edgeKey as edgeKeyOf } from '../../src/types.js';
import type { VerifyTask } from '../../src/types.js';
import {
  makeEvidence,
  makeFixture,
  makeFakeServices,
  makePlan,
  rmDir,
  tmpProject,
} from '../helpers/fakes.js';

let dir: string;
beforeEach(() => {
  dir = tmpProject();
});
afterEach(() => rmDir(dir));

describe('createTasks', () => {
  it('creates one task per inferred/ambiguous edge with stable ids', () => {
    const { graph, keys } = makeFixture();
    const tasks = createTasks(graph);
    expect(tasks).toHaveLength(4);
    const byKey = new Map(tasks.map((t) => [t.edgeKey, t]));
    expect(byKey.get(keys.addTriggers)?.id).toBe(stableId('task', keys.addTriggers));
    expect(tasks.every((t) => t.status === 'open')).toBe(true);
  });

  it('turns edges touching mutate/destructive/unknown actions into review_edge tasks', () => {
    const { graph, keys } = makeFixture();
    const tasks = createTasks(graph);
    const types = new Map(tasks.map((t) => [t.edgeKey, t.type]));
    expect(types.get(keys.deleteTriggers)).toBe('review_edge'); // destructive action
    expect(types.get(keys.addTriggers)).toBe('verify_edge');
    expect(types.get(keys.addNavigates)).toBe('verify_edge');
    expect(types.get(keys.backNavigates)).toBe('verify_edge');
  });

  it('respects a custom confidences filter and dedupes edges', () => {
    const { graph } = makeFixture();
    const onlyAmbiguous = createTasks(graph, { confidences: ['ambiguous'] });
    expect(onlyAmbiguous).toHaveLength(1);
    const duped = { ...graph, edges: [...graph.edges, ...graph.edges] };
    expect(createTasks(duped)).toHaveLength(4);
  });
});

describe('queue lifecycle', () => {
  it('create -> next leases -> expire reopens -> submit verified updates the edge', async () => {
    const { graph, keys } = makeFixture();
    const { services, store } = makeFakeServices({ graph });
    store.graphs.set(graphPathOf(dir), graph);
    writeConfig(dir, { baseUrl: 'http://localhost:4200' });

    const tasks = createTasks(graph).filter((t) => t.type === 'verify_edge');
    expect(enqueueTasks(dir, tasks)).toEqual({ created: 3, skipped: 0 });
    expect(enqueueTasks(dir, tasks)).toEqual({ created: 0, skipped: 3 });

    // Lease: task leaves the open pool, lease is persisted ~10 min out.
    const first = nextTask(dir);
    expect(first).not.toBeNull();
    expect(first!.status).toBe('leased');
    const persisted = readTask(dir, first!.id)!;
    expect(persisted.status).toBe('leased');
    const remaining = Date.parse(persisted.leaseUntil!) - Date.now();
    expect(remaining).toBeGreaterThan(LEASE_MS - 5000);
    expect(remaining).toBeLessThanOrEqual(LEASE_MS + 1000);

    const second = nextTask(dir);
    const third = nextTask(dir);
    expect(new Set([first!.id, second!.id, third!.id]).size).toBe(3);
    expect(nextTask(dir)).toBeNull(); // everything leased

    // Expire the first lease on disk: it must come back.
    const file = path.join(queueDir(dir), `${first!.id}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8')) as VerifyTask;
    task.leaseUntil = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(task));
    const reclaimed = nextTask(dir);
    expect(reclaimed!.id).toBe(first!.id);

    // Submit a probe plan: validated, executed, judged -> edge verified.
    const verifyTask = tasks.find((t) => t.edgeKey === keys.addNavigates)!;
    const result = await submitProbe(dir, verifyTask.id, makePlan(keys.addNavigates), services);
    expect(result.mode).toBe('executed');
    expect(result.verdict).toBe('verified');
    expect(result.graphUpdated).toBe(true);
    expect(readTask(dir, verifyTask.id)).toMatchObject({ status: 'done', verdict: 'verified' });

    const saved = store.graphs.get(graphPathOf(dir))!;
    const edge = saved.edges.find((e) => edgeKeyOf(e) === keys.addNavigates)!;
    expect(edge.confidence).toBe('verified');
    expect(edge.source).toBe('both');
    expect(edge.evidence).toContain('probe verified');

    expect(fs.existsSync(path.join(recipesDir(dir), `${verifyTask.id}.json`))).toBe(true);
    expect(queueSummary(dir).done).toBe(1);
  });

  it('a failed expectation marks the edge contradicted; a failed step leaves it alone', async () => {
    const { graph, keys } = makeFixture();
    const contradicting = makeFakeServices({
      graph,
      evidence: makeEvidence({ matched: [false] }),
    });
    contradicting.store.graphs.set(graphPathOf(dir), graph);
    writeConfig(dir, { baseUrl: 'http://localhost:4200' });
    const tasks = createTasks(graph);
    enqueueTasks(dir, tasks);
    const t = tasks.find((x) => x.edgeKey === keys.addNavigates)!;
    const res = await submitProbe(dir, t.id, makePlan(keys.addNavigates), contradicting.services);
    expect(res.verdict).toBe('contradicted');
    const saved = contradicting.store.graphs.get(graphPathOf(dir))!;
    expect(saved.edges.find((e) => edgeKeyOf(e) === keys.addNavigates)!.confidence).toBe(
      'contradicted',
    );

    // unreached: step failed -> verdict unreached, edge untouched
    const dir2 = tmpProject();
    try {
      const unreached = makeFakeServices({
        graph,
        evidence: makeEvidence({ stepResults: [{ ok: false, note: 'timeout' }], matched: [] }),
      });
      unreached.store.graphs.set(graphPathOf(dir2), graph);
      writeConfig(dir2, { baseUrl: 'http://localhost:4200' });
      enqueueTasks(dir2, tasks);
      const res2 = await submitProbe(dir2, t.id, makePlan(keys.addNavigates), unreached.services);
      expect(res2.verdict).toBe('unreached');
      expect(res2.graphUpdated).toBe(false);
      const g2 = unreached.store.graphs.get(graphPathOf(dir2))!;
      expect(g2.edges.find((e) => edgeKeyOf(e) === keys.addNavigates)!.confidence).toBe('inferred');
    } finally {
      rmDir(dir2);
    }
  });

  it('without a configured baseUrl the plan is stored as a recipe, not executed', async () => {
    const { graph, keys } = makeFixture();
    const { services, probeCalls } = makeFakeServices({ graph });
    const tasks = createTasks(graph);
    enqueueTasks(dir, tasks);
    const t = tasks.find((x) => x.edgeKey === keys.addTriggers)!;
    const res = await submitProbe(dir, t.id, makePlan(keys.addTriggers), services);
    expect(res.mode).toBe('stored');
    expect(res.verdict).toBeUndefined();
    expect(probeCalls).toHaveLength(0);
    expect(readTask(dir, t.id)).toMatchObject({ status: 'done' });
    expect(readTask(dir, t.id)!.verdict).toBeUndefined();
    const recipe = JSON.parse(fs.readFileSync(res.recipePath, 'utf8'));
    expect(recipe.plan.edgeKey).toBe(keys.addTriggers);
    expect(recipe.note).toContain('no baseUrl');
  });

  it('rejects bad submissions: unknown task, wrong edgeKey, probe on review_edge, invalid plan', async () => {
    const { graph, keys } = makeFixture();
    const { services } = makeFakeServices({ graph });
    const tasks = createTasks(graph);
    enqueueTasks(dir, tasks);
    const verify = tasks.find((t) => t.edgeKey === keys.addTriggers)!;
    const review = tasks.find((t) => t.type === 'review_edge')!;

    await expect(submitProbe(dir, 'task_nope', makePlan(keys.addTriggers), services)).rejects.toThrow(
      /no such task/,
    );
    await expect(
      submitProbe(dir, verify.id, makePlan(keys.backNavigates), services),
    ).rejects.toThrow(/does not match/);
    await expect(
      submitProbe(dir, review.id, makePlan(keys.deleteTriggers), services),
    ).rejects.toThrow(/review/);
    await expect(submitProbe(dir, verify.id, { nope: true }, services)).rejects.toThrow(
      /invalid probe plan/,
    );
    // destructive click in the plan
    await expect(
      submitProbe(
        dir,
        verify.id,
        makePlan(keys.addTriggers, {
          steps: [
            { action: 'goto', url: '/users' },
            { action: 'click', locator: { strategy: 'role', role: 'button', name: 'Delete user' } },
          ],
        }),
        services,
      ),
    ).rejects.toThrow(/destructive/);
    // off-origin goto
    await expect(
      submitProbe(
        dir,
        verify.id,
        makePlan(keys.addTriggers, { steps: [{ action: 'goto', url: 'https://evil.example/x' }] }),
        services,
      ),
    ).rejects.toThrow(/off-origin/);
    // nothing above may have completed the task
    expect(readTask(dir, verify.id)!.status).not.toBe('done');
  });
});

describe('submitReview', () => {
  it('caps at ai_reviewed: lifts ambiguous, never produces verified', async () => {
    const { graph, keys } = makeFixture();
    const { services, store } = makeFakeServices({ graph });
    store.graphs.set(graphPathOf(dir), graph);
    const tasks = createTasks(graph);
    enqueueTasks(dir, tasks);
    const review = tasks.find((t) => t.type === 'review_edge')!; // ambiguous edge

    const res = await submitReview(
      dir,
      review.id,
      { likely: true, reasoning: 'onDelete() calls the API then routes back to /users' },
      services,
    );
    expect(res.confidence).toBe('ai_reviewed');
    expect(res.confidence).not.toBe('verified');
    const saved = store.graphs.get(graphPathOf(dir))!;
    const edge = saved.edges.find((e) => edgeKeyOf(e) === keys.deleteTriggers)!;
    expect(edge.confidence).toBe('ai_reviewed');
    expect(edge.source).toBe('ai');
    expect(edge.evidence).toContain('ai review (likely=true)');
    expect(readTask(dir, review.id)).toMatchObject({ status: 'done' });
    const recipe = JSON.parse(fs.readFileSync(res.recipePath, 'utf8'));
    expect(recipe.review.reasoning).toContain('onDelete');
  });

  it('never downgrades a stronger claim and records likely=false without promotion', async () => {
    const { graph, keys } = makeFixture();
    const { services, store } = makeFakeServices({ graph });
    store.graphs.set(graphPathOf(dir), graph);
    const tasks = createTasks(graph);
    enqueueTasks(dir, tasks);
    const verify = tasks.find((t) => t.edgeKey === keys.addTriggers)!; // inferred edge

    const res = await submitReview(dir, verify.id, { likely: true, reasoning: 'looks right' }, services);
    expect(res.confidence).toBe('inferred'); // stronger than ai_reviewed: untouched

    const review = tasks.find((t) => t.type === 'review_edge')!;
    const res2 = await submitReview(dir, review.id, { likely: false, reasoning: 'cannot tell' }, services);
    expect(res2.confidence).toBe('ambiguous'); // not promoted on likely=false
  });
});
