# uigraph

Deterministic UI knowledge graph for AI test agents. The graph is built by
compilers and a real-browser crawl, queried by agents, and **no AI ever writes
a fact**: AI (via the host coding agent, never an API key) only plans probes;
uigraph executes them and judges evidence.

## Layout
- `src/types.ts`, `src/schemas.ts`, `src/core/ids.ts` — frozen contracts. Do not change shapes casually.
- `src/core/` — store (JSON per route), merge + confidence promotion, query engine, locator rendering.
- `src/adapters/angular/` — static extraction via `@angular/compiler` + ts-morph. More adapters follow the `FrameworkAdapter` interface.
- `src/crawl/` — Playwright crawler (observes, verifies uniqueness), probe runner + evidence checker.
- `src/verify/` — file-based task queue handed to coding agents (MCP/CLI). Agent output is untrusted: validate with `src/schemas.ts` before anything runs.
- `src/cli/`, `src/mcp/` — commander CLI and stdio MCP server.
- `fixtures/` — test apps (excluded from tsconfig; never import them).
- `tests/` — vitest, mirrors src areas. `evals/` holds golden query expectations.

## Commands
- `npm test` · `npm run typecheck` · `npx vitest run tests/<area>`

## Rules
- Strict TS, no `any`, no positional locators (`nth`), no fixed sleeps.
- Determinism: same code in, byte-identical graph out (sort nodes/edges before save; `builtAt` is the only exception).
- Safety: anything matching `DESTRUCTIVE_TEXT` or with safety `mutate|destructive|unknown` is never clicked by crawl or probe.
- Confidence promotion only in `core/merge`: static+runtime agreement → `verified`; AI judgment alone caps at `ai_reviewed`.
