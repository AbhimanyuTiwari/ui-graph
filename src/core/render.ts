/**
 * Render structured LocatorDescriptors to Playwright code strings.
 * Locators are stored as data and rendered at the edge — never stored as code.
 */
import type { LocatorDescriptor } from '../types.js';

/** Quote a string as a single-quoted JS literal, escaping \ and '. */
function jsStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Emit a regex literal from a stored regex source, escaping bare slashes. */
function regexLit(source: string): string {
  return `/${source.replace(/(?<!\\)\//g, '\\/')}/`;
}

/** The name/text argument: regex literal when nameRegex is set, else a string. */
function nameArg(loc: LocatorDescriptor): string | undefined {
  if (loc.nameRegex !== undefined) return regexLit(loc.nameRegex);
  if (loc.name !== undefined) return jsStr(loc.name);
  return undefined;
}

/** Render one descriptor as a call chained onto `receiver` (no scope recursion). */
function renderOne(loc: LocatorDescriptor, receiver: string): string {
  let code: string;
  switch (loc.strategy) {
    case 'role': {
      const n = nameArg(loc);
      code = `${receiver}.getByRole(${jsStr(loc.role ?? '')}${n ? `, { name: ${n} }` : ''})`;
      break;
    }
    case 'label':
      code = `${receiver}.getByLabel(${nameArg(loc) ?? jsStr('')})`;
      break;
    case 'placeholder':
      code = `${receiver}.getByPlaceholder(${nameArg(loc) ?? jsStr('')})`;
      break;
    case 'text':
      code = `${receiver}.getByText(${nameArg(loc) ?? jsStr('')})`;
      break;
    case 'attr': {
      const name = loc.attr?.name ?? '';
      // Escape for the CSS string context ("..."); jsStr then escapes for JS.
      const value = (loc.attr?.value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      code = `${receiver}.locator(${jsStr(`[${name}="${value}"]`)})`;
      break;
    }
    case 'css':
      code = `${receiver}.locator(${jsStr(loc.css ?? '')})`;
      break;
  }
  if (loc.filterText !== undefined) {
    code += `.filter({ hasText: ${jsStr(loc.filterText)} })`;
  }
  return code;
}

/**
 * Render a descriptor to Playwright code. The scope chain (outermost first)
 * wraps the target: page.getByRole('dialog', …).getByRole('button', …).
 */
export function renderPlaywright(loc: LocatorDescriptor): string {
  let receiver = 'page';
  for (const scope of loc.scope ?? []) {
    receiver = renderOne(scope, receiver);
  }
  return renderOne(loc, receiver);
}

const LADDER: ReadonlyArray<LocatorDescriptor['strategy']> = [
  'role',
  'label',
  'placeholder',
  'attr',
  'text',
  'css',
];

function hasDataFor(loc: LocatorDescriptor, strategy: LocatorDescriptor['strategy']): boolean {
  switch (strategy) {
    case 'role':
      return loc.role !== undefined;
    case 'label':
    case 'placeholder':
    case 'text':
      return loc.strategy === strategy && (loc.name !== undefined || loc.nameRegex !== undefined);
    case 'attr':
      return loc.attr !== undefined;
    case 'css':
      return loc.css !== undefined;
  }
}

/**
 * Every selector the descriptor's data supports, rendered in ladder order
 * (role > label > placeholder > attr > text > css) — the order a consumer
 * should try them in.
 */
export function renderSelectorList(loc: LocatorDescriptor): string[] {
  const out: string[] = [];
  for (const strategy of LADDER) {
    if (!hasDataFor(loc, strategy)) continue;
    out.push(renderPlaywright({ ...loc, strategy }));
  }
  return out.length > 0 ? out : [renderPlaywright(loc)];
}
