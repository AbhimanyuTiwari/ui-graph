/** Screens, elements, locator ladder, forms, accessibility findings. */
import { describe, expect, it } from 'vitest';
import {
  edges,
  elementsOf,
  formsOf,
  getGraph,
  golden,
  routeByFullPath,
  screensOf,
  statesFor,
} from './helpers';

describe('angular adapter: screens and states', () => {
  it('produces a default screen plus declared state candidates per route', async () => {
    const g = await getGraph();
    for (const [fullPath, states] of Object.entries(golden.screenStates)) {
      expect(statesFor(g, fullPath), `states of ${fullPath}`).toEqual(states);
    }
  });

  it('the @if empty branch of the user list produces a second screen state', async () => {
    const g = await getGraph();
    expect(statesFor(g, '/users')).toContain('empty');
  });

  it('the *ngIf error banner on the detail screen produces an error state', async () => {
    const g = await getGraph();
    expect(statesFor(g, '/users/:id')).toContain('error');
  });
});

describe('angular adapter: elements and locators', () => {
  it('login button gets a role+name locator', async () => {
    const g = await getGraph();
    const btn = elementsOf(g).find((e) => e.name === 'Sign in');
    expect(btn?.locator.strategy).toBe(golden.loginButton.locator.strategy);
    expect(btn?.locator.role).toBe(golden.loginButton.locator.role);
    expect(btn?.locator.name).toBe(golden.loginButton.locator.name);
    expect(btn?.role).toBe('button');
  });

  it('login email field has BOTH a label locator and the formcontrolname attr', async () => {
    const g = await getGraph();
    const email = elementsOf(g).find(
      (e) => e.attrs?.formcontrolname === 'email' && e.name === 'Email' && e.file?.includes('login'),
    );
    expect(email).toBeDefined();
    expect(email?.locator.strategy).toBe(golden.emailField.locator.strategy);
    expect(email?.locator.name).toBe(golden.emailField.locator.name);
    expect(email?.attrs).toMatchObject(golden.emailField.attrs);
    expect(email?.role).toBe('textbox');
  });

  it('the Edit button inside @for is a collection element with a keyHint and row scope', async () => {
    const g = await getGraph();
    const edit = elementsOf(g).find((e) => e.name === golden.editButton.name);
    expect(edit?.collection?.keyHint).toBe(golden.editButton.collection.keyHint);
    const rowScope = edit?.locator.scope?.find((s) => s.filterText !== undefined);
    expect(rowScope, 'collection locator must carry a filterText row scope').toBeDefined();
  });

  it('flags the icon-only refresh button as unnamed', async () => {
    const g = await getGraph();
    const unnamed = elementsOf(g).filter((e) => e.unnamed);
    const icon = unnamed.find((e) => e.file?.includes('user-list'));
    expect(icon).toBeDefined();
    expect(icon?.name).toBeUndefined();
    expect(icon?.confidence).toBe('extracted');
  });

  it('records routerLink on anchors and names them from text', async () => {
    const g = await getGraph();
    const back = elementsOf(g).find((e) => e.name === 'Back to users');
    expect(back?.role).toBe('link');
    expect(back?.attrs?.routerlink).toBe('/users');
  });

  it('honors aria-label at the top of the name ladder', async () => {
    const g = await getGraph();
    const close = elementsOf(g).find((e) => e.name === 'Close');
    expect(close?.locator.strategy).toBe('role');
    expect(close?.locator.name).toBe('Close');
  });

  it('CONTAINS edges connect default screens to their elements', async () => {
    const g = await getGraph();
    const usersRoute = routeByFullPath(g, '/users');
    const screen = screensOf(g).find((s) => s.routeId === usersRoute?.id && s.state === 'default');
    const contains = edges(g, 'CONTAINS').filter((e) => e.from === screen?.id);
    expect(contains.length).toBeGreaterThanOrEqual(3);
  });
});

describe('angular adapter: forms', () => {
  it('extracts form controls and validators from fb.group', async () => {
    const g = await getGraph();
    for (const [component, controls] of Object.entries(golden.forms)) {
      const form = formsOf(g).find((f) => f.name === component);
      expect(form, `form of ${component}`).toBeDefined();
      for (const [control, validators] of Object.entries(controls)) {
        const field = form?.fields.find((f) => f.control === control);
        expect(field?.validators, `${component}.${control}`).toEqual(validators);
      }
    }
  });

  it('links form fields to their template locators via formcontrolname', async () => {
    const g = await getGraph();
    const login = formsOf(g).find((f) => f.name === 'LoginComponent');
    const email = login?.fields.find((f) => f.control === 'email');
    expect(email?.locator?.strategy).toBe('label');
    expect(email?.locator?.name).toBe('Email');
  });
});
