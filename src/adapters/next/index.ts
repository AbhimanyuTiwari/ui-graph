/**
 * Next.js adapter. App Router (`app/.../page.tsx`) and Pages Router
 * (`pages/...tsx`) routes, plus links, inputs, and buttons in those files.
 * Syntax only, via ts-morph. No network and no AI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind, type JsxOpeningLikeElement } from 'ts-morph';
import { contentHash, stableId } from '../../core/ids.js';
import { DESTRUCTIVE_TEXT } from '../../schemas.js';
import {
  SCHEMA_VERSION,
  edgeKey,
  type ElementNode,
  type FrameworkAdapter,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type RouteNode,
} from '../../types.js';

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson(file: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function uigraphVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readJson(path.resolve(here, '../../../package.json'))?.version ?? '0.1.0';
}

function listFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) listFiles(abs, acc);
    else if (name.endsWith('.tsx') || name.endsWith('.jsx')) acc.push(abs);
  }
  return acc;
}

function routeFromRel(relPath: string): { fullPath: string; paramNames: string[] } | null {
  const norm = relPath.split(path.sep).join('/');
  let body: string | null = null;
  if (norm.startsWith('app/') && (norm.endsWith('/page.tsx') || norm.endsWith('/page.jsx') || norm === 'app/page.tsx')) {
    body = norm.replace(/^app\//, '').replace(/\/page\.tsx$/, '').replace(/^page\.tsx$/, '');
  } else if (norm.startsWith('pages/') && !norm.includes('/_') && !norm.startsWith('pages/_') && !norm.endsWith('/api/')) {
    if (norm.includes('/api/')) return null;
    body = norm.replace(/^pages\//, '').replace(/\.tsx$/, '').replace(/\/index$/, '').replace(/^index$/, '');
  }
  if (body === null) return null;
  const parts = body.split('/').filter((part) => part.length > 0 && !/^\(.*\)$/.test(part));
  const segs = parts.map((part) => {
    const match = /^\[\.\.\.(.+)\]$/.exec(part) ?? /^\[(.+)\]$/.exec(part);
    return match?.[1] ? `:${match[1]}` : part;
  });
  const fullPath = `/${segs.join('/')}` === '/' ? '/' : `/${segs.join('/')}`.replace(/\/$/, '');
  return {
    fullPath: fullPath === '' ? '/' : fullPath,
    paramNames: segs.filter((seg) => seg.startsWith(':')).map((seg) => seg.slice(1)),
  };
}

function attr(el: JsxOpeningLikeElement, name: string): string | undefined {
  const found = el.getAttribute(name);
  if (!found || !Node.isJsxAttribute(found)) return undefined;
  const init = found.getInitializer();
  if (init && Node.isStringLiteral(init)) return init.getLiteralText();
  return undefined;
}

function visibleText(el: Node): string {
  const chunks: string[] = [];
  if (Node.isJsxElement(el)) {
    for (const child of el.getJsxChildren()) {
      if (Node.isJsxText(child)) chunks.push(child.getText());
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export const nextAdapter: FrameworkAdapter = {
  name: 'next',

  async detect(projectDir: string): Promise<boolean> {
    const pkg = readJson(path.join(projectDir, 'package.json'));
    if (!pkg) return false;
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    return typeof deps.next === 'string';
  },

  async extract(projectDir: string): Promise<Graph> {
    const root = path.resolve(projectDir);
    const files = [...listFiles(path.join(root, 'app')), ...listFiles(path.join(root, 'pages'))].sort();
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { strict: false, jsx: 4 },
    });
    for (const file of files) project.addSourceFileAtPath(file);

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fileHashes: Record<string, string> = {};

    const add = (node: GraphNode): void => {
      nodes.push(node);
    };
    const link = (edge: GraphEdge): void => {
      edges.push(edge);
    };

    for (const file of files) {
      const relPath = path.relative(root, file).split(path.sep).join('/');
      fileHashes[relPath] = contentHash(readFileSync(file, 'utf8'));
      const routeInfo = routeFromRel(relPath);
      if (!routeInfo) continue;
      const source = project.getSourceFile(file);
      if (!source) continue;

      const route: RouteNode = {
        id: stableId('route', routeInfo.fullPath),
        kind: 'route',
        path: routeInfo.fullPath.replace(/^\//, ''),
        fullPath: routeInfo.fullPath,
        paramNames: routeInfo.paramNames,
        guards: [],
        file: relPath,
        confidence: 'extracted',
        source: 'static',
      };
      add(route);
      const screenId = stableId('screen', route.id, 'default');
      add({
        id: screenId,
        kind: 'screen',
        routeId: route.id,
        state: 'default',
        file: relPath,
        confidence: 'extracted',
        source: 'static',
      });
      link({
        from: route.id,
        to: screenId,
        type: 'HAS_SCREEN',
        confidence: 'extracted',
        source: 'static',
      });

      const labels = new Map<string, string>();
      for (const jsx of source.getDescendantsOfKind(SyntaxKind.JsxElement)) {
        const open = jsx.getOpeningElement();
        if (open.getTagNameNode().getText() !== 'label') continue;
        const htmlFor = attr(open, 'htmlFor');
        const text = visibleText(jsx);
        if (htmlFor && text) labels.set(htmlFor, text);
      }

      const openings: JsxOpeningLikeElement[] = [
        ...source.getDescendantsOfKind(SyntaxKind.JsxElement).map((el) => el.getOpeningElement()),
        ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ];
      for (const open of openings) {
        const tag = open.getTagNameNode().getText();
        const parent = open.getParent();
        if (!parent) continue;
        const href = attr(open, 'href');
        const inputId = attr(open, 'id');
        const inputName = attr(open, 'name');
        const text = Node.isJsxElement(parent) ? visibleText(parent) : '';
        const labelled = inputId ? labels.get(inputId) : undefined;
        const interactive = tag === 'button' || tag === 'a' || tag === 'Link' || tag === 'input';
        if (!interactive) continue;
        const role = tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : 'link';
        const name = labelled ?? (text.length > 0 ? text : undefined);
        const element: ElementNode = {
          id: stableId('element', routeInfo.fullPath, tag, name, href, inputName),
          kind: 'element',
          locator: labelled
            ? { strategy: 'label', name: labelled }
            : name
              ? { strategy: 'role', role, name }
              : { strategy: 'role', role },
          role,
          ...(name !== undefined ? { name } : {}),
          ...(href || inputName
            ? { attrs: { ...(href ? { href } : {}), ...(inputName ? { name: inputName } : {}) } }
            : {}),
          file: relPath,
          line: open.getStartLineNumber(),
          confidence: 'extracted',
          source: 'static',
        };
        add(element);
        link({
          from: screenId,
          to: element.id,
          type: 'CONTAINS',
          confidence: 'extracted',
          source: 'static',
        });
        if (tag === 'button' && name && DESTRUCTIVE_TEXT.test(name)) {
          const actionId = stableId('action', routeInfo.fullPath, name);
          add({
            id: actionId,
            kind: 'action',
            type: 'unknown',
            safety: 'destructive',
            handler: name,
            file: relPath,
            confidence: 'inferred',
            source: 'static',
          });
          link({
            from: element.id,
            to: actionId,
            type: 'TRIGGERS',
            confidence: 'inferred',
            source: 'static',
          });
        }
      }
    }

    const pkg = readJson(path.join(root, 'package.json'));
    return {
      schemaVersion: SCHEMA_VERSION,
      generator: { name: 'uigraph', version: uigraphVersion() },
      app: { name: pkg?.name ?? 'app', framework: 'next' },
      builtAt: new Date().toISOString(),
      fileHashes,
      nodes: nodes.sort((a, b) => `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`)),
      edges: edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    };
  },
};
