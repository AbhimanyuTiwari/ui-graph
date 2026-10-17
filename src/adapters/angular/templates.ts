/**
 * Template extraction. For every routed component, parse its template with
 * @angular/compiler's parseTemplate and emit:
 *   - a 'default' ScreenNode plus one state candidate per top-level branch
 *     that swaps major content (@if/@else, *ngIf; @switch cases),
 *   - ElementNodes for interactive elements, with accessible names resolved
 *     through the static name ladder and LocatorDescriptors built per ladder,
 *   - FormNodes from reactive fb.group(...) declarations in the class,
 *   - HAS_SCREEN and CONTAINS edges,
 * and register element -> handler references for the actions phase.
 *
 * Supports both modern control flow (@if/@else/@for/@switch) and the old
 * *ngIf/*ngFor microsyntax (parsed as TmplAstTemplate with templateAttrs).
 */
import {
  ASTWithSource,
  type TmplAstBoundAttribute,
  TmplAstBoundText,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstIfBlock,
  type TmplAstNode,
  TmplAstSwitchBlock,
  TmplAstTemplate,
  TmplAstText,
  TmplAstTextAttribute,
  parseTemplate,
} from '@angular/compiler';
import { Node, SyntaxKind } from 'ts-morph';
import type {
  ElementNode,
  FormNode,
  LocatorDescriptor,
  RouteNode,
  ScreenNode,
} from '../../types.js';
import { stableId } from '../../core/ids.js';
import { type ComponentInfo, type Ctx, addEdge, addNode, squash } from './model.js';
import { hostScope } from './profiles.js';

// -- small AST helpers --------------------------------------------------------

/** Source text of an Angular expression AST, when available. */
const exprSource = (expr: unknown): string | undefined =>
  expr instanceof ASTWithSource ? (expr.source ?? undefined) : undefined;

const staticAttr = (el: TmplAstElement, name: string): string | undefined =>
  el.attributes.find((a) => a.name === name)?.value;

const templateAttr = (
  tpl: TmplAstTemplate,
  name: string,
): TmplAstTextAttribute | TmplAstBoundAttribute | undefined =>
  tpl.templateAttrs.find((a) => a.name === name);

/** Static visible text of a node subtree (interpolations are skipped). */
function staticText(nodes: TmplAstNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n instanceof TmplAstText) out += ` ${n.value}`;
    else if (n instanceof TmplAstElement) out += ` ${staticText(n.children)}`;
    else if (n instanceof TmplAstTemplate) out += ` ${staticText(n.children)}`;
  }
  return squash(out);
}

/** First interpolation source in a subtree ('{{ user.name }}' -> 'user.name'). */
function firstInterpolation(nodes: TmplAstNode[]): string | undefined {
  for (const n of nodes) {
    if (n instanceof TmplAstBoundText) {
      const src = exprSource(n.value);
      const inner = src?.replace(/^\{\{\s*|\s*\}\}$/g, '');
      if (inner) return inner;
    }
    const children =
      n instanceof TmplAstElement || n instanceof TmplAstTemplate ? n.children : undefined;
    if (children) {
      const found = firstInterpolation(children);
      if (found) return found;
    }
  }
  return undefined;
}

// -- name ladder and role inference -------------------------------------------

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
const HANDLER_EVENTS = /^(click|submit|ngSubmit|keydown(\..+)?)$/;

const INPUT_ROLE: Record<string, string> = {
  text: 'textbox',
  password: 'textbox',
  email: 'textbox',
  search: 'searchbox',
  checkbox: 'checkbox',
  radio: 'radio',
  number: 'spinbutton',
};

function inferRole(el: TmplAstElement): string | undefined {
  switch (el.name) {
    case 'button':
      return 'button';
    case 'a':
      return staticAttr(el, 'href') !== undefined ||
        staticAttr(el, 'routerLink') !== undefined ||
        el.inputs.some((i) => i.name === 'routerLink')
        ? 'link'
        : undefined;
    case 'input':
      return INPUT_ROLE[staticAttr(el, 'type') ?? 'text'] ?? 'textbox';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    default:
      return undefined;
  }
}

type NameSource = 'aria-label' | 'label' | 'text' | 'placeholder' | 'title';

/** Static accessible-name ladder: aria-label > label[for] > text > placeholder > title. */
function accessibleName(
  el: TmplAstElement,
  labels: Map<string, string>,
): { name?: string; via?: NameSource } {
  const aria = staticAttr(el, 'aria-label');
  if (aria) return { name: aria, via: 'aria-label' };
  const id = staticAttr(el, 'id');
  const labelled = id !== undefined ? labels.get(id) : undefined;
  if (labelled) return { name: labelled, via: 'label' };
  const text = staticText(el.children);
  // Single punctuation glyphs ('x', '×') are not meaningful accessible names.
  if (text && !/^[^\w]$/.test(text) && text.toLowerCase() !== 'x') {
    return { name: text, via: 'text' };
  }
  const placeholder = staticAttr(el, 'placeholder');
  if (placeholder) return { name: placeholder, via: 'placeholder' };
  const title = staticAttr(el, 'title');
  if (title) return { name: title, via: 'title' };
  return {};
}

/** Pre-pass: <label for="x">Text</label> -> x: 'Text'. */
function collectLabels(nodes: TmplAstNode[], labels: Map<string, string>): void {
  for (const n of nodes) {
    if (n instanceof TmplAstElement) {
      if (n.name === 'label') {
        const forId = staticAttr(n, 'for');
        const text = staticText(n.children);
        if (forId && text) labels.set(forId, text);
      }
      collectLabels(n.children, labels);
    } else if (n instanceof TmplAstTemplate) {
      collectLabels(n.children, labels);
    } else if (n instanceof TmplAstIfBlock) {
      for (const b of n.branches) collectLabels(b.children, labels);
    } else if (n instanceof TmplAstForLoopBlock) {
      collectLabels(n.children, labels);
    } else if (n instanceof TmplAstSwitchBlock) {
      for (const group of n.groups) collectLabels(group.children, labels);
    }
  }
}

// -- locator construction ------------------------------------------------------

interface WalkCtx {
  conditions: string[];
  /** State label the current branch maps to, when inside a state branch. */
  stateLabel?: string;
  collection?: { keyHint?: string; rowTag?: string; rowFilter?: string };
  overlays?: LocatorDescriptor[];
}

/** Build the best LocatorDescriptor per the ladder, scoped to the component. */
function buildLocator(
  el: TmplAstElement,
  role: string | undefined,
  name: string | undefined,
  via: NameSource | undefined,
  attrs: Record<string, string>,
  selector: string | undefined,
  walk: WalkCtx,
): LocatorDescriptor {
  const scope: LocatorDescriptor[] = [];
  if (selector) scope.push({ strategy: 'css', css: selector });
  for (const overlay of walk.overlays ?? []) scope.push(overlay);
  if (walk.collection?.rowTag) {
    // Collection item scope: "the <rowTag> whose text contains <filter>".
    // rowFilter is the row's binding expression — a pattern the caller fills in.
    scope.push({
      strategy: 'css',
      css: walk.collection.rowTag,
      ...(walk.collection.rowFilter ? { filterText: walk.collection.rowFilter } : {}),
    });
  }
  const scoped = (loc: LocatorDescriptor): LocatorDescriptor =>
    scope.length > 0 ? { ...loc, scope } : loc;

  if (name !== undefined) {
    // Label-derived names render best as getByLabel; everything else as role+name.
    if (via === 'label') return scoped({ strategy: 'label', name });
    if (via === 'placeholder') return scoped({ strategy: 'placeholder', name });
    if (role) return scoped({ strategy: 'role', role, name });
    return scoped({ strategy: 'text', name });
  }
  const fcn = attrs['formcontrolname'];
  if (fcn) return scoped({ strategy: 'attr', attr: { name: 'formcontrolname', value: fcn } });
  if (role) return scoped({ strategy: 'role', role });
  // Last resort: the bare tag, scoped to the component host.
  return scoped({ strategy: 'css', css: el.name });
}

// -- state labelling ------------------------------------------------------------

/** Label a top-level branch: 'empty'/'error' heuristics, else the condition text. */
function stateLabelFor(condition: string, branchText: string): string {
  if (/\.length\s*===?\s*0/.test(condition) || /\b(no |none|nothing|empty)/i.test(branchText)) {
    return 'empty';
  }
  if (/\berror\b/i.test(condition)) return 'error';
  return squash(condition);
}

// -- per-component template extraction -----------------------------------------

interface TemplateResult {
  defaultScreenId: string;
}

/** Walk the template of one routed component, under one route. */
function extractComponentTemplate(
  ctx: Ctx,
  route: RouteNode,
  info: ComponentInfo,
): TemplateResult {
  const parsed = parseTemplate(info.template ?? '', info.templateFile ?? info.file, {
    preserveWhitespaces: false,
  });

  const labels = new Map<string, string>();
  collectLabels(parsed.nodes, labels);

  // Screens: 'default' always; one per top-level content-swapping branch.
  const mkScreen = (state: string): ScreenNode => {
    const screen: ScreenNode = {
      id: stableId('screen', route.id, state),
      kind: 'screen',
      routeId: route.id,
      state,
      file: info.templateFile,
      confidence: 'extracted',
      source: 'static',
    };
    addNode(ctx, screen);
    addEdge(ctx, {
      from: route.id,
      to: screen.id,
      type: 'HAS_SCREEN',
      confidence: 'extracted',
      source: 'static',
    });
    return screen;
  };
  const defaultScreen = mkScreen('default');
  const stateScreens = new Map<string, ScreenNode>();
  const ensureState = (label: string): ScreenNode => {
    let s = stateScreens.get(label);
    if (!s && label !== 'default') {
      s = mkScreen(label);
      stateScreens.set(label, s);
    }
    return s ?? defaultScreen;
  };

  // Top-level state candidates (branches that swap major content).
  for (const node of parsed.nodes) {
    if (node instanceof TmplAstIfBlock) {
      for (const branch of node.branches) {
        const cond = exprSource(branch.expression);
        if (cond) ensureState(stateLabelFor(cond, staticText(branch.children)));
      }
    } else if (node instanceof TmplAstTemplate) {
      const ngIf = templateAttr(node, 'ngIf');
      const cond = ngIf && 'value' in ngIf ? (exprSource(ngIf.value) ?? ngIf.value) : undefined;
      if (typeof cond === 'string' && cond) {
        ensureState(stateLabelFor(cond, staticText(node.children)));
      }
    } else if (node instanceof TmplAstSwitchBlock) {
      for (const group of node.groups) {
        for (const c of group.cases) {
          const cond = exprSource(c.expression);
          ensureState(cond ? `case:${squash(cond)}` : 'case:default');
        }
      }
    }
  }

  // Elements.
  const emitElement = (el: TmplAstElement, walk: WalkCtx, formSubmitMethods: string[]): void => {
    const handlerSources = el.outputs
      .filter((o) => HANDLER_EVENTS.test(o.name))
      .map((o) => exprSource(o.handler) ?? '')
      .filter((s) => s.length > 0);
    const isForm = el.name === 'form';
    const interactive = INTERACTIVE_TAGS.has(el.name) || handlerSources.length > 0;
    if (!interactive || isForm) return;

    const role = inferRole(el);
    const { name, via } = accessibleName(el, labels);
    const text = staticText(el.children) || undefined;

    // Stable attributes worth recording (DOM-lowercased keys).
    const attrs: Record<string, string> = {};
    const fcn = staticAttr(el, 'formControlName');
    if (fcn) attrs['formcontrolname'] = fcn;
    const nameAttr = staticAttr(el, 'name');
    if (nameAttr) attrs['name'] = nameAttr;
    const routerLink =
      staticAttr(el, 'routerLink') ??
      exprSource(el.inputs.find((i) => i.name === 'routerLink')?.value);
    if (routerLink) attrs['routerlink'] = routerLink;
    const href = staticAttr(el, 'href');
    if (href) attrs['href'] = href;

    // Method names this element invokes ('openEdit(user)' -> 'openEdit').
    const methods = handlerSources
      .map((s) => /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(s)?.[1])
      .filter((m): m is string => Boolean(m));
    // A submit button inside a form with (ngSubmit) fires the form's handler.
    const type = staticAttr(el, 'type');
    if (el.name === 'button' && (type === 'submit' || type === undefined)) {
      methods.push(...formSubmitMethods.filter((m) => !methods.includes(m)));
    }

    const unnamed = name === undefined;
    const element: ElementNode = {
      id: stableId(
        'element',
        info.className,
        el.name,
        role,
        name,
        attrs['formcontrolname'],
        handlerSources.join('|'),
        attrs['routerlink'] ?? attrs['href'],
      ),
      kind: 'element',
      locator: buildLocator(el, role, name, via, attrs, info.selector, walk),
      ...(role !== undefined ? { role } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined && text !== name ? { text } : {}),
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(walk.collection ? { collection: { keyHint: walk.collection.keyHint } } : {}),
      ...(walk.conditions.length > 0 ? { conditions: [...walk.conditions] } : {}),
      ...(unnamed ? { unnamed: true } : {}),
      file: info.templateFile,
      line: el.sourceSpan.start.line + 1,
      confidence: 'extracted',
      source: 'static',
    };
    addNode(ctx, element);

    // CONTAINS from the default screen always, plus the state screen when the
    // element lives inside a state branch.
    addEdge(ctx, {
      from: defaultScreen.id,
      to: element.id,
      type: 'CONTAINS',
      confidence: 'extracted',
      source: 'static',
    });
    const stateScreen = walk.stateLabel ? stateScreens.get(walk.stateLabel) : undefined;
    if (stateScreen) {
      addEdge(ctx, {
        from: stateScreen.id,
        to: element.id,
        type: 'CONTAINS',
        confidence: 'extracted',
        source: 'static',
      });
    }

    // Hand the element to the actions phase.
    if (methods.length > 0 || routerLink || /^https?:\/\//.test(href ?? '')) {
      ctx.handlers.push({
        sourceId: element.id,
        componentName: info.className,
        routeId: route.id,
        methods,
        elementText: name ?? text,
        ...(routerLink ? { routerLink } : {}),
        ...(href && /^https?:\/\//.test(href) ? { externalHref: href } : {}),
      });
    }
  };

  const visit = (nodes: TmplAstNode[], walk: WalkCtx, formSubmitMethods: string[]): void => {
    for (const node of nodes) {
      if (node instanceof TmplAstElement) {
        // Forms don't become elements; their ngSubmit flows to submit buttons.
        let submit = formSubmitMethods;
        if (node.name === 'form') {
          const own = node.outputs
            .filter((o) => o.name === 'ngSubmit' || o.name === 'submit')
            .map((o) => /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(exprSource(o.handler) ?? '')?.[1])
            .filter((m): m is string => Boolean(m));
          submit = [...formSubmitMethods, ...own];
        } else {
          emitElement(node, walk, formSubmitMethods);
        }
        const host = hostScope(node.name);
        const nextWalk = host ? { ...walk, overlays: [...(walk.overlays ?? []), host] } : walk;
        visit(node.children, nextWalk, submit);
      } else if (node instanceof TmplAstTemplate) {
        // *ngIf / *ngFor desugared templates.
        const ngIf = templateAttr(node, 'ngIf');
        const ngForOf = templateAttr(node, 'ngForOf');
        let next = walk;
        if (ngIf && 'value' in ngIf) {
          const cond = exprSource(ngIf.value) ?? String(ngIf.value);
          next = {
            ...next,
            conditions: [...next.conditions, `*ngIf ${squash(cond)}`],
            stateLabel: stateLabelFor(cond, staticText(node.children)),
          };
        }
        if (ngForOf) {
          const trackBy = templateAttr(node, 'ngForTrackBy');
          next = {
            ...next,
            collection: {
              keyHint: trackBy && 'value' in trackBy ? exprSource(trackBy.value) : undefined,
              rowTag: node.children.find((c): c is TmplAstElement => c instanceof TmplAstElement)
                ?.name,
              rowFilter: firstInterpolation(node.children),
            },
          };
        }
        visit(node.children, next, formSubmitMethods);
      } else if (node instanceof TmplAstIfBlock) {
        for (const branch of node.branches) {
          const cond = exprSource(branch.expression);
          const label = cond ? stateLabelFor(cond, staticText(branch.children)) : undefined;
          visit(
            branch.children,
            {
              ...walk,
              conditions: cond ? [...walk.conditions, `@if ${squash(cond)}`] : walk.conditions,
              stateLabel: label ?? walk.stateLabel,
            },
            formSubmitMethods,
          );
        }
      } else if (node instanceof TmplAstForLoopBlock) {
        const rowTag = node.children.find(
          (c): c is TmplAstElement => c instanceof TmplAstElement,
        )?.name;
        visit(
          node.children,
          {
            ...walk,
            collection: {
              keyHint: exprSource(node.trackBy),
              rowTag,
              rowFilter: firstInterpolation(node.children),
            },
          },
          formSubmitMethods,
        );
        if (node.empty) {
          visit(node.empty.children, { ...walk, stateLabel: 'empty' }, formSubmitMethods);
        }
      } else if (node instanceof TmplAstSwitchBlock) {
        for (const group of node.groups) {
          const labels = group.cases.map((c) => exprSource(c.expression) ?? 'default');
          const cond = labels.join(' | ');
          visit(
            group.children,
            {
              ...walk,
              conditions: [...walk.conditions, `@switch case ${cond}`],
              stateLabel: labels.some((l) => l !== 'default')
                ? `case:${squash(labels.filter((l) => l !== 'default').join(' | '))}`
                : 'case:default',
            },
            formSubmitMethods,
          );
        }
      }
    }
  };
  visit(parsed.nodes, { conditions: [] }, []);

  // Lifecycle load work (ngOnInit) is triggered by the default screen itself.
  if (info.cls.getMethod('ngOnInit')) {
    ctx.handlers.push({
      sourceId: defaultScreen.id,
      componentName: info.className,
      routeId: route.id,
      methods: ['ngOnInit'],
    });
  }

  extractReactiveForm(ctx, info, defaultScreen.id);
  return { defaultScreenId: defaultScreen.id };
}

// -- reactive forms --------------------------------------------------------------

/** `form = this.fb.group({ email: ['', [Validators.required]] })` -> FormNode. */
function extractReactiveForm(ctx: Ctx, info: ComponentInfo, screenId: string): void {
  for (const prop of info.cls.getProperties()) {
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'group') continue;
    const arg = init.getArguments()[0];
    if (!arg || !Node.isObjectLiteralExpression(arg)) continue;

    const fields: FormNode['fields'] = [];
    for (const p of arg.getProperties()) {
      if (!Node.isPropertyAssignment(p)) continue;
      const control = p.getName();
      const validators: string[] = [];
      // Validators appear as Validators.X identifiers anywhere in the value.
      for (const access of p.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getExpression().getText() === 'Validators') {
          validators.push(access.getName());
        }
      }
      // Reuse the template element's locator for this control, when extracted.
      const el = [...ctx.nodes.values()].find(
        (n) =>
          n.kind === 'element' &&
          'attrs' in n &&
          n.attrs?.['formcontrolname'] === control &&
          n.file === info.templateFile,
      );
      fields.push({
        control,
        ...(el && 'locator' in el ? { locator: el.locator } : {}),
        ...(validators.length > 0 ? { validators } : {}),
      });
    }

    const form: FormNode = {
      id: stableId('form', info.className, prop.getName()),
      kind: 'form',
      name: info.className,
      fields,
      file: info.file,
      line: prop.getStartLineNumber(),
      confidence: 'extracted',
      source: 'static',
    };
    addNode(ctx, form);
    addEdge(ctx, {
      from: screenId,
      to: form.id,
      type: 'CONTAINS',
      confidence: 'extracted',
      source: 'static',
    });
  }
}

// -- phase entry point ------------------------------------------------------------

/** Extract screens/elements/forms for every route that renders a known component. */
export function extractTemplates(ctx: Ctx): void {
  for (const route of ctx.routes) {
    if (!route.componentName) continue;
    const info = ctx.components.get(route.componentName);
    if (!info || info.template === undefined) continue;
    extractComponentTemplate(ctx, route, info);
  }
}
