/**
 * Actions phase. Handler refs collected by the template walk are resolved
 * through the component method and one injected-service hop, all from syntax
 * (no type checker). Emits action, api, and modal-screen nodes plus
 * TRIGGERS, CALLS, NAVIGATES_TO, and OPENS edges.
 */
import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type SourceFile,
} from 'ts-morph';
import type { ActionNode, ApiEndpointNode, ScreenNode } from '../../types.js';
import { stableId } from '../../core/ids.js';
import { ensureComponentNode } from './routes.js';
import { profileForDialog } from './profiles.js';
import { classify } from './safety.js';
import { type Ctx, type HandlerRef, addEdge, addNode } from './model.js';

interface Effect {
  type: 'api' | 'navigate' | 'dialog' | 'external';
  method?: string;
  url?: string;
  component?: string;
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function classByName(files: SourceFile[], name: string): ClassDeclaration | undefined {
  for (const file of files) {
    const found = file.getClass(name);
    if (found) return found;
  }
  return undefined;
}

function ctorTypes(cls: ClassDeclaration): Map<string, string> {
  const map = new Map<string, string>();
  const ctor = cls.getConstructors()[0];
  if (!ctor) return map;
  for (const param of ctor.getParameters()) {
    const name = param.getName();
    if (!name) continue;
    const text = param.getTypeNode()?.getText() ?? '';
    const simple = text.replace(/<[^>]*>/g, '').split('.').pop() ?? '';
    if (simple) map.set(name, simple);
  }
  return map;
}

function paramFromText(text: string): string {
  const prop = text.split('.').pop() ?? 'param';
  return /^[A-Za-z_$][\w$]*$/.test(prop) ? `:${prop}` : ':param';
}

function urlOf(expr: Node | undefined): string | undefined {
  if (!expr) return undefined;
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return normalizePath(expr.getLiteralText());
  }
  if (Node.isTemplateExpression(expr)) {
    let url = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      url += paramFromText(span.getExpression().getText()) + span.getLiteral().getLiteralText();
    }
    return normalizePath(url);
  }
  if (Node.isArrayLiteralExpression(expr)) {
    const parts: string[] = [];
    for (const el of expr.getElements()) {
      if (Node.isStringLiteral(el)) parts.push(el.getLiteralText());
      else parts.push(paramFromText(el.getText()));
    }
    return normalizePath(parts.join('/'));
  }
  return undefined;
}

function normalizePath(raw: string): string {
  const withSlash = raw.startsWith('/') || raw.startsWith('http') ? raw : `/${raw}`;
  if (withSlash.startsWith('http')) return withSlash;
  const segs = withSlash.split('/').filter((s) => s.length > 0);
  return `/${segs.join('/')}`;
}

function effectsOf(
  ctx: Ctx,
  cls: ClassDeclaration,
  methodName: string,
  seen: Set<string>,
): Effect[] {
  const key = `${cls.getName() ?? ''}.${methodName}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const method = cls.getMethod(methodName);
  if (!method) return [];
  const types = ctorTypes(cls);
  const effects: Effect[] = [];
  for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const callee = expr.getName();
    const recv = expr.getExpression().getText();

    if (recv === 'window' && callee === 'open') {
      effects.push({ type: 'external', url: urlOf(call.getArguments()[0]) });
      continue;
    }
    if (!recv.startsWith('this.')) continue;
    const prop = recv.slice('this.'.length).split('.')[0] ?? '';
    const typeName = types.get(prop);

    if (HTTP_VERBS.has(callee) && (typeName === 'HttpClient' || prop === 'http')) {
      const url = urlOf(call.getArguments()[0]);
      if (url) effects.push({ type: 'api', method: callee.toUpperCase(), url });
      continue;
    }
    if (callee === 'navigate' && (typeName === 'Router' || prop === 'router')) {
      const url = urlOf(call.getArguments()[0]);
      if (url) effects.push({ type: 'navigate', url });
      continue;
    }
    if (
      callee === 'open' &&
      (typeName === 'Dialog' || prop === 'dialog' || profileForDialog(typeName, prop) !== undefined)
    ) {
      const arg = call.getArguments()[0];
      const component = arg && Node.isIdentifier(arg) ? arg.getText() : undefined;
      if (component) effects.push({ type: 'dialog', component });
      continue;
    }
    if (typeName && !HTTP_VERBS.has(callee) && callee !== 'subscribe' && callee !== 'pipe') {
      const target = classByName(ctx.project.getSourceFiles(), typeName);
      if (target) {
        ctx.parsedFiles.add(target.getSourceFile().getFilePath());
        effects.push(...effectsOf(ctx, target, callee, seen));
      }
    }
  }
  return dedupe(effects);
}

function dedupe(effects: Effect[]): Effect[] {
  const seen = new Set<string>();
  const out: Effect[] = [];
  for (const e of effects) {
    const key = `${e.type}|${e.method ?? ''}|${e.url ?? ''}|${e.component ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function emit(
  ctx: Ctx,
  ref: HandlerRef,
  handler: string,
  effect: Effect,
  file: string | undefined,
  line: number | undefined,
): void {
  const detail =
    effect.type === 'api'
      ? `${effect.method} ${effect.url}`
      : effect.type === 'dialog'
        ? effect.component
        : effect.url;
  const safety = classify({
    type: effect.type,
    method: effect.method,
    handler,
    elementText: ref.elementText,
  });
  const action: ActionNode = {
    id: stableId('action', handler, effect.type, detail),
    kind: 'action',
    type: effect.type,
    safety,
    ...(detail !== undefined ? { detail } : {}),
    handler,
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    confidence: 'extracted',
    source: 'static',
  };
  addNode(ctx, action);
  addEdge(ctx, {
    from: ref.sourceId,
    to: action.id,
    type: 'TRIGGERS',
    confidence: 'extracted',
    source: 'static',
  });

  if (effect.type === 'api' && effect.method && effect.url) {
    const api: ApiEndpointNode = {
      id: stableId('api', effect.method, effect.url),
      kind: 'api',
      method: effect.method,
      urlPattern: effect.url,
      ...(file !== undefined ? { file } : {}),
      confidence: 'extracted',
      source: 'static',
    };
    addNode(ctx, api);
    addEdge(ctx, {
      from: action.id,
      to: api.id,
      type: 'CALLS',
      confidence: 'extracted',
      source: 'static',
    });
  }

  if (effect.type === 'navigate' && effect.url) {
    const route = ctx.routes.find((r) => r.fullPath === effect.url && !r.redirectTo);
    if (route) {
      addEdge(ctx, {
        from: action.id,
        to: route.id,
        type: 'NAVIGATES_TO',
        confidence: 'extracted',
        source: 'static',
      });
    }
  }

  if (effect.type === 'dialog' && effect.component) {
    const route = ctx.routes.find((r) => r.id === ref.routeId);
    if (!route) return;
    ensureComponentNode(ctx, effect.component);
    const state = `modal:${effect.component}`;
    const screen: ScreenNode = {
      id: stableId('screen', route.id, state),
      kind: 'screen',
      routeId: route.id,
      state,
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
    addEdge(ctx, {
      from: action.id,
      to: screen.id,
      type: 'OPENS',
      confidence: 'extracted',
      source: 'static',
    });
  }
}

/** Resolve every handler ref collected during template extraction. */
export function extractActions(ctx: Ctx): void {
  for (const ref of ctx.handlers) {
    const info = ctx.components.get(ref.componentName);
    const cls = info?.cls;
    for (const method of ref.methods) {
      if (!cls) continue;
      const handler = `${ref.componentName}.${method}`;
      for (const effect of effectsOf(ctx, cls, method, new Set())) {
        emit(ctx, ref, handler, effect, info?.file, cls.getMethod(method)?.getStartLineNumber());
      }
    }
    if (ref.routerLink) {
      emit(
        ctx,
        ref,
        `${ref.componentName}.routerLink`,
        { type: 'navigate', url: normalizePath(ref.routerLink) },
        info?.file,
        undefined,
      );
    }
    if (ref.externalHref) {
      emit(
        ctx,
        ref,
        `${ref.componentName}.href`,
        { type: 'external', url: ref.externalHref },
        info?.file,
        undefined,
      );
    }
  }
}
