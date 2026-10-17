import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { angularAdapter } from '../../src/adapters/angular';
import { MATERIAL, NG_BOOTSTRAP, profileForDialog } from '../../src/adapters/angular/profiles';
import type { ActionNode, ElementNode, ScreenNode } from '../../src/types';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/angular-profiles');

describe('component library profiles', () => {
  it('names Material and ng-bootstrap dialog APIs', () => {
    expect(profileForDialog('MatDialog', 'dialog')?.name).toBe(MATERIAL.name);
    expect(profileForDialog('NgbModal', 'modal')?.name).toBe(NG_BOOTSTRAP.name);
    expect(profileForDialog('HttpClient', 'http')).toBeUndefined();
  });

  it('models MatDialog.open and NgbModal.open as modal screens', async () => {
    const graph = await angularAdapter.extract(FIXTURE);
    const states = graph.nodes
      .filter((n): n is ScreenNode => n.kind === 'screen')
      .map((s) => s.state)
      .sort();
    expect(states).toContain('modal:EditUserDialog');
    expect(states).toContain('modal:ConfirmModal');
    const edit = graph.nodes.find(
      (n): n is ActionNode => n.kind === 'action' && n.handler === 'InboxComponent.edit',
    );
    expect(edit?.type).toBe('dialog');
    expect(edit?.safety).toBe('safe');
  });

  it('scopes elements inside mat-dialog-content to a dialog', async () => {
    const graph = await angularAdapter.extract(FIXTURE);
    const save = graph.nodes.find((n): n is ElementNode => n.kind === 'element' && n.name === 'Save');
    expect(save?.locator.scope?.some((s) => s.role === 'dialog')).toBe(true);
  });
});
