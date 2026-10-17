/** Actions: navigation, API calls through services, dialogs, safety classes. */
import { describe, expect, it } from 'vitest';
import {
  actionsByHandler,
  apisOf,
  edges,
  elementsOf,
  getGraph,
  golden,
  routeByFullPath,
  screensOf,
} from './helpers';

describe('angular adapter: actions and safety', () => {
  it('classifies the delete action as destructive and links its API endpoint', async () => {
    const g = await getGraph();
    const api = actionsByHandler(g, golden.deleteAction.handler).find((a) => a.type === 'api');
    expect(api?.safety).toBe(golden.deleteAction.safety);
    const endpoint = apisOf(g).find(
      (e) => e.method === golden.deleteAction.api.method && e.urlPattern === golden.deleteAction.api.urlPattern,
    );
    expect(endpoint).toBeDefined();
    expect(edges(g, 'CALLS').some((e) => e.from === api?.id && e.to === endpoint?.id)).toBe(true);
  });

  it('classifies the save PUT as mutate', async () => {
    const g = await getGraph();
    const api = actionsByHandler(g, golden.saveAction.handler).find((a) => a.type === 'api');
    expect(api?.safety).toBe(golden.saveAction.safety);
    expect(api?.detail).toBe(`${golden.saveAction.api.method} ${golden.saveAction.api.urlPattern}`);
  });

  it('resolves GET /api/users through the injected service hop with extracted confidence', async () => {
    const g = await getGraph();
    const api = actionsByHandler(g, golden.serviceHop.handler).find((a) => a.type === 'api');
    expect(api?.detail).toBe(`${golden.serviceHop.api.method} ${golden.serviceHop.api.urlPattern}`);
    expect(api?.safety).toBe('safe');
    const endpoint = apisOf(g).find(
      (e) => e.method === golden.serviceHop.api.method && e.urlPattern === golden.serviceHop.api.urlPattern,
    );
    const call = edges(g, 'CALLS').find((e) => e.from === api?.id && e.to === endpoint?.id);
    expect(call?.confidence).toBe(golden.serviceHop.confidence);
  });

  it('follows the login submit through the auth service and back to navigation', async () => {
    const g = await getGraph();
    const actions = actionsByHandler(g, golden.loginFlow.handler);
    const api = actions.find((a) => a.type === 'api');
    expect(api?.detail).toBe(`${golden.loginFlow.api.method} ${golden.loginFlow.api.urlPattern}`);
    const nav = actions.find((a) => a.type === 'navigate');
    expect(nav?.detail).toBe(golden.loginFlow.navigateTo);
    const target = routeByFullPath(g, golden.loginFlow.navigateTo);
    expect(edges(g, 'NAVIGATES_TO').some((e) => e.from === nav?.id && e.to === target?.id)).toBe(true);
  });

  it('resolves router.navigate with a dynamic segment to a :param route', async () => {
    const g = await getGraph();
    const nav = actionsByHandler(g, 'UserListComponent.openEdit').find((a) => a.type === 'navigate');
    expect(nav?.detail).toBe('/users/:id');
    const target = routeByFullPath(g, '/users/:id');
    expect(edges(g, 'NAVIGATES_TO').some((e) => e.from === nav?.id && e.to === target?.id)).toBe(true);
  });

  it('models dialog.open as an OPENS edge to a modal screen state', async () => {
    const g = await getGraph();
    const dialog = actionsByHandler(g, 'UserListComponent.openCreate').find((a) => a.type === 'dialog');
    expect(dialog?.safety).toBe('safe');
    const route = routeByFullPath(g, golden.modal.route);
    const modal = screensOf(g).find((s) => s.routeId === route?.id && s.state === golden.modal.state);
    expect(modal).toBeDefined();
    expect(edges(g, 'OPENS').some((e) => e.from === dialog?.id && e.to === modal?.id)).toBe(true);
  });

  it('models window.open as an external action', async () => {
    const g = await getGraph();
    const ext = actionsByHandler(g, golden.externalAction.handler).find(
      (a) => a.type === golden.externalAction.type,
    );
    expect(ext).toBeDefined();
  });

  it('TRIGGERS edges connect elements to their actions', async () => {
    const g = await getGraph();
    const del = elementsOf(g).find((e) => e.name === 'Delete');
    const action = actionsByHandler(g, golden.deleteAction.handler).find((a) => a.type === 'api');
    expect(edges(g, 'TRIGGERS').some((e) => e.from === del?.id && e.to === action?.id)).toBe(true);
  });
});
