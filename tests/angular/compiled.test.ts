/**
 * Compiled Angular bundles. Without a source map the extractor recovers only
 * what the bundle states literally. With sourcesContent it rebuilds the
 * original files and runs the normal source pass.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { angularAdapter } from '../../src/adapters/angular';
import type { ComponentNode, ElementNode, RouteNode } from '../../src/types';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'uigraph-bundle-'));
  dirs.push(dir);
  return dir;
}

const BUNDLE = `
(function(){
  var routes = [
    {path:"login",component:LoginComponent},
    {path:"users/:id",component:UserDetailComponent}
  ];
  var LoginComponent = {selector:"app-login",formControlName:"email"};
})();
`;

describe('angular compiled bundles', () => {
  it('without a source map recovers route paths, selectors, and formControlName', async () => {
    const dir = tempProject();
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'main.js'), BUNDLE);
    const graph = await angularAdapter.extract(dir, {
      bundles: ['dist/main.js'],
      sourceMaps: false,
    });
    const routes = graph.nodes.filter((n): n is RouteNode => n.kind === 'route').map((r) => r.fullPath);
    expect(routes.sort()).toEqual(['/login', '/users/:id']);
    const login = graph.nodes.find(
      (n): n is ComponentNode => n.kind === 'component' && n.selector === 'app-login',
    );
    expect(login).toBeDefined();
    expect(login?.confidence).toBe('inferred');
    const email = graph.nodes.find(
      (n): n is ElementNode => n.kind === 'element' && n.attrs?.formcontrolname === 'email',
    );
    expect(email?.locator).toEqual({ strategy: 'attr', attr: { name: 'formcontrolname', value: 'email' } });
    expect(graph.nodes.every((n) => n.source === 'static')).toBe(true);
  });

  it('with sourcesContent runs the source extractor on the restored files', async () => {
    const dir = tempProject();
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    const sources = [
      'src/app/app.routes.ts',
      'src/app/login/login.component.ts',
    ];
    const sourcesContent = [
      `import { Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
export const routes: Routes = [{ path: 'login', component: LoginComponent }];
`,
      `import { Component } from '@angular/core';
@Component({
  selector: 'app-login',
  standalone: true,
  template: \`<button type="submit">Sign in</button>\`,
})
export class LoginComponent {}
`,
    ];
    const map = { version: 3, sources, sourcesContent, mappings: '' };
    writeFileSync(path.join(dir, 'dist', 'main.js'), `/* compiled */\n//# sourceMappingURL=main.js.map\n`);
    writeFileSync(path.join(dir, 'dist', 'main.js.map'), JSON.stringify(map));
    const graph = await angularAdapter.extract(dir, {
      bundles: ['dist/main.js'],
      sourceMaps: true,
    });
    const routes = graph.nodes.filter((n): n is RouteNode => n.kind === 'route');
    expect(routes.map((r) => r.fullPath)).toContain('/login');
    expect(routes.find((r) => r.fullPath === '/login')?.confidence).toBe('extracted');
    const button = graph.nodes.find((n) => n.kind === 'element' && 'name' in n && n.name === 'Sign in');
    expect(button).toBeDefined();
  });
});
