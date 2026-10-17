/**
 * Shared fixture graph for core tests and the golden eval:
 *   /login  --(Log in)-->  /users  --(Alice link)-->  /users/:id
 * /users also has: a safe Filters modal (OPENS), a destructive delete
 * confirm modal (OPENS, must never be routed through), an ambiguous
 * Edit button, and an AuthGuard precondition on /users and /users/:id.
 */
import { contentHash, stableId } from '../../src/core/ids';
import { SCHEMA_VERSION } from '../../src/types';
import type { Graph, GraphEdge, GraphNode } from '../../src/types';

export const LOGIN_FILE = 'src/app/login.component.ts';
export const USERS_FILE = 'src/app/users.component.ts';
export const DETAIL_FILE = 'src/app/user-detail.component.ts';

export const ids = {
  rLogin: stableId('route', '/login'),
  sLogin: stableId('screen', '/login', 'default'),
  eEmail: stableId('element', '/login', 'label:Email'),
  eLoginBtn: stableId('element', '/login', 'role:button', 'Log in'),
  aLogin: stableId('action', 'LoginComponent.submit'),

  rUsers: stableId('route', '/users'),
  sUsers: stableId('screen', '/users', 'default'),
  sFilters: stableId('screen', '/users', 'modal:filters'),
  sConfirm: stableId('screen', '/users', 'modal:confirmDelete'),
  eAlice: stableId('element', '/users', 'role:link', 'Alice'),
  eDelete: stableId('element', '/users', 'role:button', 'Delete user'),
  eFilters: stableId('element', '/users', 'role:button', 'Filters'),
  eEdit: stableId('element', '/users', 'role:button', 'Edit'),
  eApply: stableId('element', '/users', 'modal:filters', 'role:button', 'Apply'),
  aOpenUser: stableId('action', 'UserListComponent.open'),
  aDelete: stableId('action', 'UserListComponent.confirmDelete'),
  aOpenFilters: stableId('action', 'UserListComponent.openFilters'),
  aApply: stableId('action', 'FiltersComponent.apply'),
  pAuth: stableId('precondition', 'auth', 'AuthGuard'),

  rDetail: stableId('route', '/users/:id'),
  sDetail: stableId('screen', '/users/:id', 'default'),
} as const;

export function buildFixtureGraph(): Graph {
  const nodes: GraphNode[] = [
    {
      id: ids.rLogin, kind: 'route', path: 'login', fullPath: '/login',
      paramNames: [], guards: [], componentName: 'LoginComponent',
      file: LOGIN_FILE, line: 12, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.sLogin, kind: 'screen', routeId: ids.rLogin, state: 'default',
      title: 'Login', confidence: 'observed', source: 'runtime',
    },
    {
      id: ids.eEmail, kind: 'element',
      locator: { strategy: 'label', name: 'Email', unique: true },
      role: 'textbox', name: 'Email',
      file: LOGIN_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.eLoginBtn, kind: 'element',
      locator: { strategy: 'role', role: 'button', name: 'Log in', unique: true },
      role: 'button', name: 'Log in',
      file: LOGIN_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.aLogin, kind: 'action', type: 'navigate', safety: 'safe',
      detail: '/users', handler: 'LoginComponent.submit',
      file: LOGIN_FILE, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.rUsers, kind: 'route', path: 'users', fullPath: '/users',
      paramNames: [], guards: ['AuthGuard'], componentName: 'UserListComponent',
      file: USERS_FILE, line: 8, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.sUsers, kind: 'screen', routeId: ids.rUsers, state: 'default',
      title: 'Users', confidence: 'observed', source: 'runtime',
    },
    {
      id: ids.sFilters, kind: 'screen', routeId: ids.rUsers, state: 'modal:filters',
      title: 'Filters', confidence: 'observed', source: 'runtime',
    },
    {
      id: ids.sConfirm, kind: 'screen', routeId: ids.rUsers, state: 'modal:confirmDelete',
      title: 'Confirm delete', confidence: 'extracted', source: 'static',
    },
    {
      id: ids.eAlice, kind: 'element',
      locator: {
        strategy: 'role', role: 'link', name: 'Alice', unique: true,
        scope: [{ strategy: 'role', role: 'listitem', filterText: 'Alice' }],
      },
      role: 'link', name: 'Alice', collection: { keyHint: 'name' },
      file: USERS_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.eDelete, kind: 'element',
      locator: { strategy: 'role', role: 'button', name: 'Delete user', unique: true },
      role: 'button', name: 'Delete user',
      file: USERS_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.eFilters, kind: 'element',
      locator: { strategy: 'role', role: 'button', name: 'Filters', unique: true },
      role: 'button', name: 'Filters',
      file: USERS_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.eEdit, kind: 'element',
      locator: { strategy: 'role', role: 'button', name: 'Edit', unique: false },
      role: 'button', name: 'Edit', collection: {},
      file: USERS_FILE, confidence: 'ambiguous', source: 'both',
    },
    {
      id: ids.eApply, kind: 'element',
      locator: { strategy: 'role', role: 'button', name: 'Apply', unique: true },
      role: 'button', name: 'Apply',
      file: USERS_FILE, confidence: 'verified', source: 'both',
    },
    {
      id: ids.aOpenUser, kind: 'action', type: 'navigate', safety: 'safe',
      detail: '/users/:id', handler: 'UserListComponent.open',
      file: USERS_FILE, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.aDelete, kind: 'action', type: 'dialog', safety: 'destructive',
      detail: 'ConfirmDeleteDialog', handler: 'UserListComponent.confirmDelete',
      file: USERS_FILE, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.aOpenFilters, kind: 'action', type: 'dialog', safety: 'safe',
      detail: 'FiltersDialog', handler: 'UserListComponent.openFilters',
      file: USERS_FILE, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.aApply, kind: 'action', type: 'state', safety: 'safe',
      detail: 'apply filters', handler: 'FiltersComponent.apply',
      file: USERS_FILE, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.pAuth, kind: 'precondition', type: 'auth', detail: 'AuthGuard',
      confidence: 'extracted', source: 'static',
    },
    {
      id: ids.rDetail, kind: 'route', path: 'users/:id', fullPath: '/users/:id',
      paramNames: ['id'], guards: ['AuthGuard'], componentName: 'UserDetailComponent',
      file: DETAIL_FILE, line: 15, confidence: 'extracted', source: 'static',
    },
    {
      id: ids.sDetail, kind: 'screen', routeId: ids.rDetail, state: 'default',
      title: 'User detail', confidence: 'observed', source: 'runtime',
    },
  ];

  const edges: GraphEdge[] = [
    { from: ids.rLogin, to: ids.sLogin, type: 'HAS_SCREEN', confidence: 'verified', source: 'both' },
    { from: ids.rUsers, to: ids.sUsers, type: 'HAS_SCREEN', confidence: 'verified', source: 'both' },
    { from: ids.rUsers, to: ids.sFilters, type: 'HAS_SCREEN', confidence: 'verified', source: 'both' },
    { from: ids.rUsers, to: ids.sConfirm, type: 'HAS_SCREEN', confidence: 'extracted', source: 'static' },
    { from: ids.rDetail, to: ids.sDetail, type: 'HAS_SCREEN', confidence: 'verified', source: 'both' },

    { from: ids.sLogin, to: ids.eEmail, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sLogin, to: ids.eLoginBtn, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sUsers, to: ids.eAlice, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sUsers, to: ids.eDelete, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sUsers, to: ids.eFilters, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sUsers, to: ids.eEdit, type: 'CONTAINS', confidence: 'verified', source: 'both' },
    { from: ids.sFilters, to: ids.eApply, type: 'CONTAINS', confidence: 'verified', source: 'both' },

    { from: ids.eLoginBtn, to: ids.aLogin, type: 'TRIGGERS', confidence: 'verified', source: 'both' },
    { from: ids.eAlice, to: ids.aOpenUser, type: 'TRIGGERS', confidence: 'verified', source: 'both' },
    { from: ids.eDelete, to: ids.aDelete, type: 'TRIGGERS', confidence: 'extracted', source: 'static' },
    { from: ids.eFilters, to: ids.aOpenFilters, type: 'TRIGGERS', confidence: 'verified', source: 'both' },
    { from: ids.eApply, to: ids.aApply, type: 'TRIGGERS', confidence: 'extracted', source: 'static' },

    { from: ids.aLogin, to: ids.rUsers, type: 'NAVIGATES_TO', confidence: 'verified', source: 'both', evidence: 'click observed 2026-10-17, landed on /users' },
    { from: ids.aOpenUser, to: ids.sDetail, type: 'NAVIGATES_TO', confidence: 'verified', source: 'both' },
    { from: ids.aDelete, to: ids.sConfirm, type: 'OPENS', confidence: 'extracted', source: 'static' },
    { from: ids.aOpenFilters, to: ids.sFilters, type: 'OPENS', confidence: 'verified', source: 'both' },

    { from: ids.rUsers, to: ids.pAuth, type: 'REQUIRES', confidence: 'extracted', source: 'static' },
    { from: ids.rDetail, to: ids.pAuth, type: 'REQUIRES', confidence: 'extracted', source: 'static' },
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'uigraph', version: '0.1.0' },
    app: { name: 'fixture-app', framework: 'angular' },
    builtAt: '2026-10-17T00:00:00.000Z',
    fileHashes: {
      [LOGIN_FILE]: contentHash('login-v1'),
      [USERS_FILE]: contentHash('users-v1'),
      [DETAIL_FILE]: contentHash('detail-v1'),
    },
    nodes,
    edges,
  };
}
