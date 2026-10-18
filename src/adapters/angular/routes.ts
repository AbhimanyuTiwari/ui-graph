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

type RouteArrayKind = 'root' | 'child';

interface RouteArrayCandidate {
  file: SourceFile;
  array: ArrayLiteralExpression;
  /** child = registered via forChild (reached through its parent); root = entry point. */
  kind: RouteArrayKind;
}

const ROUTER_REGISTRATIONS: Record<string, RouteArrayKind> = {
  'RouterModule.forRoot': 'root',
  'RouterModule.forChild': 'child',
  provideRouter: 'root',
};

/** `const xs = [...]` declared in this file, by name. */
function arrayDeclaredAs(name: string, file: SourceFile | undefined): ArrayLiteralExpression | undefined {
  const init = file?.getVariableDeclaration(name)?.getInitializer();
  return init && Node.isArrayLiteralExpression(init) ? init : undefined;
}

/**
 * Every route array in a file: arrays handed to forRoot/forChild/provideRouter
 * (inline or by variable name) plus `Routes`-typed consts. A forChild
 * registration wins over the `Routes` type, so a feature module's own array is
 * never mistaken for an entry point.
 */
function routeArraysIn(file: SourceFile): RouteArrayCandidate[] {
  const found = new Map<string, RouteArrayCandidate>();
  const add = (array: ArrayLiteralExpression, kind: RouteArrayKind): void => {
    const owner = array.getSourceFile();
    const key = `${owner.getFilePath()}:${array.getPos()}`;
    const prev = found.get(key);
    if (!prev || kind === 'child') found.set(key, { file: owner, array, kind });
  };

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const kind = ROUTER_REGISTRATIONS[call.getExpression().getText()];
    const arg = call.getArguments()[0];
    if (!kind || !arg) continue;
    if (Node.isArrayLiteralExpression(arg)) add(arg, kind);
    else if (Node.isIdentifier(arg)) {
      // A same-file const, or one imported from a sibling `*.routes.ts` file.
      const name = arg.getText();
      const declared = arrayDeclaredAs(name, file) ?? arrayDeclaredAs(name, importedFileOf(file, name));
      if (declared) add(declared, kind);
    }
  }
  for (const decl of file.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (decl.getTypeNode()?.getText() === 'Routes' && init && Node.isArrayLiteralExpression(init)) {
      add(init, 'root');
    }
  }
  return [...found.values()].sort((x, y) => x.array.getPos() - y.array.getPos());
}

/** All array literals that look like route declarations, project-wide. */
function findRouteArrays(ctx: Ctx): RouteArrayCandidate[] {
  // The same array can be seen from two files (declared in one, registered in
  // another); a forChild registration anywhere makes it a child everywhere.
  const byArray = new Map<string, RouteArrayCandidate>();
  for (const candidate of sortedFiles(ctx).flatMap(routeArraysIn)) {
    const key = `${candidate.file.getFilePath()}:${candidate.array.getPos()}`;
    if (byArray.get(key)?.kind !== 'child') byArray.set(key, candidate);
  }
  return [...byArray.values()];
}

function sortedFiles(ctx: Ctx): SourceFile[] {
  return ctx.project.getSourceFiles().sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
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

const MAX_MODULE_IMPORT_DEPTH = 3;

/** Identifiers listed in the `imports: [...]` of the @NgModule classes in a file. */
function ngModuleImports(file: SourceFile, exportName: string | undefined): string[] {
  const names: string[] = [];
  for (const cls of file.getClasses()) {
    if (exportName && cls.getName() !== exportName) continue;
    const arg = cls.getDecorator('NgModule')?.getArguments()[0];
    if (!arg || !Node.isObjectLiteralExpression(arg)) continue;
    const imports = arg.getProperty('imports');
    const init = imports && Node.isPropertyAssignment(imports) ? imports.getInitializer() : undefined;
    if (!init || !Node.isArrayLiteralExpression(init)) continue;
    for (const el of init.getElements()) if (Node.isIdentifier(el)) names.push(el.getText());
  }
  return names;
}

/** File that a relative named import of `name` points at, if it is in the project. */
function importedFileOf(file: SourceFile, name: string): SourceFile | undefined {
  for (const decl of file.getImportDeclarations()) {
    if (!decl.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name)) continue;
    const resolved = resolveImport(file, decl.getModuleSpecifierValue());
    return resolved ? file.getProject().getSourceFile(resolved) : undefined;
  }
  return undefined;
}

/**
 * Route arrays a lazy-loaded NgModule contributes: those in its own file plus
 * the forChild arrays of the routing modules it imports (the usual
 * `FooModule` imports `FooRoutingModule` split).
 */
function lazyRouteArrays(
  ctx: Ctx,
  file: SourceFile,
  exportName: string | undefined,
  depth = 0,
  seen = new Set<string>(),
): ArrayLiteralExpression[] {
  if (seen.has(file.getFilePath())) return [];
  seen.add(file.getFilePath());
  const own = routeArraysIn(file).filter((c) => depth === 0 || c.kind === 'child');
  if (own.length > 0) ctx.parsedFiles.add(file.getFilePath());
  const arrays = own.map((c) => c.array);
  if (depth >= MAX_MODULE_IMPORT_DEPTH) return arrays;
  for (const name of ngModuleImports(file, depth === 0 ? exportName : undefined)) {
    const imported = importedFileOf(file, name);
    if (imported) arrays.push(...lazyRouteArrays(ctx, imported, undefined, depth + 1, seen));
  }
  return arrays;
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
      const arrays = lazyRouteArrays(ctx, lazyFile, thenExportName(text));
      if (arrays.length === 0) {
        ctx.warn(`lazy route "${fullPath}" -> ${rel(ctx, lazyFile.getFilePath())} declares no route array`);
      }
      for (const array of arrays) extractRouteArray(ctx, array, fullPath, 'inferred');
    } else {
      ctx.warn(
        `lazy route "${fullPath}" in ${route.file}: could not resolve ${spec ? `'${spec}'` : 'its loadChildren target'} (path alias or non-relative import?)`,
      );
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
  const candidates = findRouteArrays(ctx);
  const roots = candidates.filter((c) => c.kind === 'root' && !lazyFiles.has(c.file.getFilePath()));
  for (const candidate of roots) {
    ctx.parsedFiles.add(candidate.file.getFilePath());
    extractRouteArray(ctx, candidate.array, '', 'extracted');
  }
  if (roots.length === 0 && candidates.length > 0) {
    const files = [...new Set(candidates.map((c) => rel(ctx, c.file.getFilePath())))].sort();
    ctx.warn(
      `found route arrays but no root (RouterModule.forRoot / provideRouter / top-level Routes): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}`,
    );
  }
}
