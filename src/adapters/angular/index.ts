/**
 * Angular adapter. Static extraction only: ts-morph for classes and routes,
 * @angular/compiler for templates. No network and no AI.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind, type ObjectLiteralExpression } from 'ts-morph';
import { contentHash } from '../../core/ids.js';
import { SCHEMA_VERSION, edgeKey, type ExtractOptions, type FrameworkAdapter, type Graph } from '../../types.js';
import { extractActions } from './actions.js';
import { extractBundle } from './bundle.js';
import { type ComponentInfo, type Ctx, rel } from './model.js';
import { extractRoutes } from './routes.js';
import { extractTemplates } from './templates.js';

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

function propInit(obj: ObjectLiteralExpression, name: string): string | undefined {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const init = prop.getInitializer();
  if (!init) return undefined;
  if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) return init.getLiteralText();
  if (Node.isTemplateExpression(init)) {
    let text = init.getHead().getLiteralText();
    for (const span of init.getTemplateSpans()) {
      text += span.getExpression().getText() + span.getLiteral().getLiteralText();
    }
    return text;
  }
  return undefined;
}

function propBool(obj: ObjectLiteralExpression, name: string): boolean | undefined {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const init = prop.getInitializer();
  if (!init) return undefined;
  if (init.getKind() === SyntaxKind.TrueKeyword) return true;
  if (init.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function loadComponents(ctx: Ctx): void {
  const files = ctx.project.getSourceFiles().sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  for (const file of files) {
    for (const cls of file.getClasses()) {
      const dec = cls.getDecorator('Component');
      const arg = dec?.getArguments()[0];
      if (!dec || !arg || !Node.isObjectLiteralExpression(arg)) continue;
      const className = cls.getName();
      if (!className) continue;
      const templateInline = propInit(arg, 'template');
      const templateUrl = propInit(arg, 'templateUrl');
      let template = templateInline;
      let templateFile = rel(ctx, file.getFilePath());
      ctx.parsedFiles.add(file.getFilePath());
      if (templateUrl) {
        const abs = path.resolve(path.dirname(file.getFilePath()), templateUrl);
        if (existsSync(abs)) {
          template = readFileSync(abs, 'utf8');
          templateFile = rel(ctx, abs);
          ctx.parsedFiles.add(abs);
        }
      }
      const info: ComponentInfo = {
        className,
        cls,
        selector: propInit(arg, 'selector'),
        standalone: propBool(arg, 'standalone') ?? false,
        file: rel(ctx, file.getFilePath()),
        ...(template !== undefined ? { template, templateFile } : {}),
      };
      ctx.components.set(className, info);
    }
  }
}

function uigraphVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readJson(path.resolve(here, '../../../package.json'))?.version ?? '0.1.0';
}

function safeSourcePath(source: string): string | null {
  let relPath = source.replace(/^webpack:\/+/, '').replace(/^\.\//, '');
  while (relPath.startsWith('../')) relPath = relPath.slice(3);
  if (relPath.length === 0 || relPath.includes('..') || path.isAbsolute(relPath)) return null;
  return relPath.split('\\').join('/');
}

/** Restore sourcesContent next to the bundle into a temp project. Undefined when no map carries sources. */
function restoreFromSourceMaps(projectDir: string, bundles: string[]): string | undefined {
  const root = mkdtempSync(path.join(tmpdir(), 'uigraph-sourcemap-'));
  let wrote = false;
  for (const relBundle of bundles) {
    const abs = path.resolve(projectDir, relBundle);
    const text = readFileSync(abs, 'utf8');
    const url = /sourceMappingURL=(\S+)/.exec(text)?.[1];
    if (!url || url.startsWith('data:')) continue;
    const mapAbs = path.resolve(path.dirname(abs), url);
    if (!existsSync(mapAbs)) continue;
    const map = JSON.parse(readFileSync(mapAbs, 'utf8')) as {
      sources?: string[];
      sourcesContent?: Array<string | null>;
    };
    const sources = map.sources ?? [];
    const contents = map.sourcesContent ?? [];
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const content = contents[i];
      if (!source || content == null) continue;
      const relSource = safeSourcePath(source);
      if (!relSource) continue;
      const dest = path.join(root, relSource);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      wrote = true;
    }
  }
  if (!wrote) {
    rmSync(root, { recursive: true, force: true });
    return undefined;
  }
  return root;
}

/** Conventional source roots, tried in order when the caller gives none. */
const DEFAULT_SOURCE_ROOTS = ['src', 'app'];
const SOURCE_EXCLUDES = ['!**/*.spec.ts', '!**/*.d.ts', '!**/node_modules/**'];

/** A bare directory means "every .ts under it"; anything else is already a glob. */
function toGlob(root: string, entry: string): string {
  const abs = path.resolve(root, entry);
  const isDir = existsSync(abs) && statSync(abs).isDirectory();
  return isDir ? path.join(abs, '**/*.ts') : abs;
}

function addSources(project: Project, root: string, src: string[] | undefined, warn: (m: string) => void): void {
  const attempts = (src && src.length > 0 ? [src] : DEFAULT_SOURCE_ROOTS.map((r) => [r])).map((entries) =>
    entries.map((e) => toGlob(root, e)),
  );
  for (const globs of attempts) {
    const added = project.addSourceFilesAtPaths([...globs, ...SOURCE_EXCLUDES.map((e) => path.join(root, e))]);
    if (added.length > 0) return;
  }
  const tried = attempts.flat().map((g) => path.relative(root, g) || g);
  warn(`no TypeScript sources matched (tried: ${tried.join(', ')}); pass --src <dir-or-glob>`);
}

function extractSource(projectDir: string, options?: ExtractOptions): Graph {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { strict: false, skipLibCheck: true },
  });
  const root = path.resolve(projectDir);
  const warn = options?.onWarning ?? (() => {});
  addSources(project, root, options?.src, warn);

  const ctx: Ctx = {
    projectDir: root,
    project,
    nodes: new Map(),
    edges: new Map(),
    parsedFiles: new Set(),
    components: new Map(),
    routes: [],
    handlers: [],
    warn,
  };

  loadComponents(ctx);
  extractRoutes(ctx);
  extractTemplates(ctx);
  extractActions(ctx);

  const pkg = readJson(path.join(root, 'package.json'));
  const fileHashes: Record<string, string> = {};
  for (const abs of [...ctx.parsedFiles].sort()) {
    if (!existsSync(abs)) continue;
    fileHashes[rel(ctx, abs)] = contentHash(readFileSync(abs, 'utf8'));
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'uigraph', version: uigraphVersion() },
    app: { name: pkg?.name ?? 'app', framework: 'angular' },
    builtAt: new Date().toISOString(),
    fileHashes,
    nodes: [...ctx.nodes.values()].sort((a, b) => `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`)),
    edges: [...ctx.edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

export const angularAdapter: FrameworkAdapter = {
  name: 'angular',

  async detect(projectDir: string): Promise<boolean> {
    const pkg = readJson(path.join(projectDir, 'package.json'));
    if (!pkg) return false;
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    return typeof deps['@angular/core'] === 'string';
  },

  async extract(projectDir: string, options?: ExtractOptions): Promise<Graph> {
    const bundles = options?.bundles ?? [];
    if (bundles.length > 0 && options?.sourceMaps !== false) {
      const restored = restoreFromSourceMaps(projectDir, bundles);
      if (restored) {
        try {
          return extractSource(restored, options);
        } finally {
          rmSync(restored, { recursive: true, force: true });
        }
      }
    }
    if (bundles.length > 0) return extractBundle(projectDir, bundles, uigraphVersion());
    return extractSource(projectDir, options);
  },
};

