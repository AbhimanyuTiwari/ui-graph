/**
 * Reduced extraction from a compiled bundle that has no source map.
 * Only literal route paths, component selectors, and formControlName values
 * are recovered. Facts are inferred: the bundle no longer states the template.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contentHash } from '../../core/ids.js';
import { stableId } from '../../core/ids.js';
import { SCHEMA_VERSION, type Graph, type GraphNode } from '../../types.js';
import { paramNamesOf } from './model.js';

function collect(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined && !out.includes(value)) out.push(value);
  }
  return out;
}

export function extractBundle(projectDir: string, bundles: string[], version: string): Graph {
  const nodes: GraphNode[] = [];
  const fileHashes: Record<string, string> = {};
  for (const relPath of [...bundles].sort()) {
    const abs = path.resolve(projectDir, relPath);
    const text = readFileSync(abs, 'utf8');
    fileHashes[relPath.split(path.sep).join('/')] = contentHash(text);

    for (const routePath of collect(text, /path\s*:\s*["']([^"']*)["']/g)) {
      if (routePath.includes(' ') || routePath.includes('://')) continue;
      const fullPath = routePath === '' ? '/' : routePath.startsWith('/') ? routePath : `/${routePath}`;
      nodes.push({
        id: stableId('route', fullPath),
        kind: 'route',
        path: routePath,
        fullPath,
        paramNames: paramNamesOf(fullPath),
        guards: [],
        file: relPath.split(path.sep).join('/'),
        confidence: 'inferred',
        source: 'static',
      });
    }
    for (const selector of collect(text, /selector\s*:\s*["']([^"']+)["']/g)) {
      nodes.push({
        id: stableId('component', selector),
        kind: 'component',
        name: selector,
        selector,
        file: relPath.split(path.sep).join('/'),
        confidence: 'inferred',
        source: 'static',
      });
    }
    for (const control of collect(text, /formControlName\s*:\s*["']([^"']+)["']/g)) {
      nodes.push({
        id: stableId('element', 'formcontrolname', control),
        kind: 'element',
        locator: { strategy: 'attr', attr: { name: 'formcontrolname', value: control } },
        attrs: { formcontrolname: control },
        file: relPath.split(path.sep).join('/'),
        confidence: 'inferred',
        source: 'static',
      });
    }
  }

  let name = 'bundle';
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) name = pkg.name;
  } catch {
    /* bundle-only directory */
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'uigraph', version },
    app: { name, framework: 'angular' },
    builtAt: new Date().toISOString(),
    fileHashes,
    nodes: nodes.sort((a, b) => `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`)),
    edges: [],
  };
}
