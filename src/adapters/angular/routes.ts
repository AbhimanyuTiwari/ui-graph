/**
 * Route extraction. Finds Routes arrays (exported `Routes` consts and
 * RouterModule.forRoot/forChild registrations), resolves nesting, guards,
 * redirects and lazy loading (loadChildren -> NgModule forChild routes,
 * loadComponent -> component class name), and emits RouteNode,
 * PreconditionNode, ComponentNode, ROUTE_RENDERS and REQUIRES.
 *
 * Everything is syntax-driven (no type checker): lazy import('...') specifiers
 * are resolved relative to the importing file.
 */
import path from 'node:path';
import {
  type ArrayLiteralExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { Confidence, PreconditionNode, RouteNode } from '../../types.js';
import { stableId } from '../../core/ids.js';
import { type Ctx, addEdge, addNode, joinRoutePath, paramNamesOf, rel } from './model.js';

interface RouteArrayCandidate {
  file: SourceFile;
  array: ArrayLiteralExpression;
  viaForChild: boolean;
}

/** All array literals that look like route declarations, project-wide. */
function findRouteArrays(ctx: Ctx): RouteArrayCandidate[] {
  const out: RouteArrayCandidate[] = [];
  for (const file of sortedFiles(ctx)) {
    // `const xs: Routes = [...]` (exported or local).
    for (const decl of file.getVariableDeclarations()) {
      const typeText = decl.getTypeNode()?.getText();
      const init = decl.getInitializer();
      if (typeText === 'Routes' && init && Node.isArrayLiteralExpression(init)) {
        out.push({ file, array: init, viaForChild: isRegisteredViaForChild(decl.getName(), file) });
      }
    }
  }
  return out;
}

function sortedFiles(ctx: Ctx): SourceFile[] {
  return ctx.project.getSourceFiles().sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
}

/** Is this variable passed to RouterModule.forChild(...) in the same file? */
function isRegisteredViaForChild(varName: string, file: SourceFile): boolean {
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const expr = call.getExpression().getText();
    if (expr !== 'RouterModule.forChild') return false;
    return call.getArguments().some((a) => a.getText() === varName);
  });
}

/** Files that are targets of a loadChildren/loadComponent dynamic import. */
function lazyTargetFiles(ctx: Ctx): Set<string> {
  const targets = new Set<string>();
  for (const file of sortedFiles(ctx)) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const arg = call.getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) {
        const resolved = resolveImport(file, arg.getLiteralText());
        if (resolved) targets.add(resolved);
      }
    }
  }
  return targets;
}

/** Resolve a relative import specifier to an absolute .ts path in the project. */
function resolveImport(from: SourceFile, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from.getFilePath()), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (from.getProject().getSourceFile(candidate)) return candidate;
  }
  return undefined;
}

/** `import('./x').then((m) => m.Thing)` -> 'Thing'. Text-based on purpose. */
function thenExportName(initializerText: string): string | undefined {
  const m = /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(\w+)/.exec(initializerText);
  return m?.[2];
}

function stringProp(obj: ObjectLiteralExpression, name: string): string | undefined {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const init = prop.getInitializer();
  return init && Node.isStringLiteral(init) ? init.getLiteralText() : undefined;
}

/** Ensure a ComponentNode exists for a class name (routed or dialog-opened). */
export function ensureComponentNode(ctx: Ctx, className: string): string {
  const info = ctx.components.get(className);
  const id = stableId('component', className);
  addNode(ctx, {
    id,
    kind: 'component',
    name: className,
    selector: info?.selector,
    standalone: info?.standalone,
    file: info?.file,
    line: info?.cls.getStartLineNumber(),
    confidence: info ? 'extracted' : 'inferred',
    source: 'static',
  });
  return id;
}

/** Walk one route object literal, emitting nodes/edges and recursing. */
function extractRoute(
  ctx: Ctx,
  obj: ObjectLiteralExpression,
  prefix: string,
  confidence: Confidence,
): void {
  const file = obj.getSourceFile();
  const pathSeg = stringProp(obj, 'path') ?? '';
  const fullPath = joinRoutePath(prefix, pathSeg);
  const redirectTo = stringProp(obj, 'redirectTo');

  // component: X  (identifier reference to a class)
  let componentName: string | undefined;
  const componentProp = obj.getProperty('component');
  if (componentProp && Node.isPropertyAssignment(componentProp)) {
    const init = componentProp.getInitializer();
    if (init && Node.isIdentifier(init)) componentName = init.getText();
  }

  // canActivate: [guardA, guardB]
  const guards: string[] = [];
  const guardProp = obj.getProperty('canActivate');
  if (guardProp && Node.isPropertyAssignment(guardProp)) {
    const init = guardProp.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      for (const el of init.getElements()) guards.push(el.getText());
    }
  }

  const loadChildrenProp = obj.getProperty('loadChildren');
  const loadComponentProp = obj.getProperty('loadComponent');
  const lazy = Boolean(loadChildrenProp || loadComponentProp);

  // loadComponent: () => import('./x').then(m => m.X)  -> component name.
  if (loadComponentProp && Node.isPropertyAssignment(loadComponentProp)) {
    componentName ??= thenExportName(loadComponentProp.getInitializer()?.getText() ?? '');
  }

  const route: RouteNode = {
    id: stableId('route', fullPath, componentName, redirectTo),
    kind: 'route',
    path: pathSeg,
    fullPath,
    paramNames: paramNamesOf(fullPath),
    guards,
    ...(lazy ? { lazy: true } : {}),
    ...(redirectTo !== undefined ? { redirectTo } : {}),
    ...(componentName !== undefined ? { componentName } : {}),
    file: rel(ctx, file.getFilePath()),
    line: obj.getStartLineNumber(),
    // The lazy route itself is literal; routes merged FROM a lazy file are
    // inferred (passed in via `confidence`), because resolution crossed files.
    confidence,
    source: 'static',
  };
  addNode(ctx, route);
  ctx.routes.push(route);

  // Guards -> auth precondition + REQUIRES.
  for (const guard of guards) {
    const pre: PreconditionNode = {
      id: stableId('precondition', 'auth', guard),
      kind: 'precondition',
      type: 'auth',
      detail: guard,
      confidence: 'extracted',
      source: 'static',
    };
    addNode(ctx, pre);
    addEdge(ctx, {
      from: route.id,
      to: pre.id,
      type: 'REQUIRES',
      confidence: 'extracted',
      source: 'static',
      evidence: `canActivate: [${guard}] in ${route.file}`,
    });
  }

  // Component binding -> ROUTE_RENDERS.
  if (componentName) {
    const componentId = ensureComponentNode(ctx, componentName);
    addEdge(ctx, {
      from: route.id,
      to: componentId,
      type: 'ROUTE_RENDERS',
      confidence: loadComponentProp ? 'inferred' : confidence,
      source: 'static',
    });
  }

  // children: [...] -> recurse under this prefix.
  const childrenProp = obj.getProperty('children');
  if (childrenProp && Node.isPropertyAssignment(childrenProp)) {
    const init = childrenProp.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      extractRouteArray(ctx, init, fullPath, confidence);
    }
  }

  // loadChildren -> follow the import to the lazy file's own route arrays and
  // merge them under this route's prefix, at 'inferred' confidence.
  if (loadChildrenProp && Node.isPropertyAssignment(loadChildrenProp)) {
    const text = loadChildrenProp.getInitializer()?.getText() ?? '';
    const spec = /import\(\s*['"]([^'"]+)['"]\s*\)/.exec(text)?.[1];
    const resolved = spec ? resolveImport(file, spec) : undefined;
    const lazyFile = resolved ? ctx.project.getSourceFile(resolved) : undefined;
    if (lazyFile) {
      ctx.parsedFiles.add(lazyFile.getFilePath());
      for (const decl of lazyFile.getVariableDeclarations()) {
        const init = decl.getInitializer();
        if (decl.getTypeNode()?.getText() === 'Routes' && init && Node.isArrayLiteralExpression(init)) {
          extractRouteArray(ctx, init, fullPath, 'inferred');
        }
      }
    }
  }
}

function extractRouteArray(
  ctx: Ctx,
  array: ArrayLiteralExpression,
  prefix: string,
  confidence: Confidence,
): void {
  for (const el of array.getElements()) {
    if (Node.isObjectLiteralExpression(el)) extractRoute(ctx, el, prefix, confidence);
  }
}

/**
 * Entry point: extract every root-level Routes array. Arrays registered via
 * RouterModule.forChild or living in loadChildren targets are reached through
 * traversal only, so their paths pick up the parent prefix exactly once.
 */
export function extractRoutes(ctx: Ctx): void {
  const lazyFiles = lazyTargetFiles(ctx);
  for (const candidate of findRouteArrays(ctx)) {
    if (candidate.viaForChild) continue;
    if (lazyFiles.has(candidate.file.getFilePath())) continue;
    ctx.parsedFiles.add(candidate.file.getFilePath());
    extractRouteArray(ctx, candidate.array, '', 'extracted');
  }
}
