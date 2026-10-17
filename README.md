# uigraph

**Stop guessing locators. Give your test agent a map.**

uigraph builds a deterministic UI knowledge graph from your web app — source
**or** compiled code — covering every route, screen, element, action, and
transition. Claude Code, Codex, Cursor, Copilot, and Gemini CLI query that
graph through MCP or the CLI instead of re-reading the DOM, so they write
Playwright tests from verified role and label locators.

No `data-testid` required. No model API key. Destructive controls are never clicked.

```
uigraph build . --adapter angular
uigraph build ./dist --adapter angular --bundles main.js --source-maps
uigraph build . --adapter next
uigraph export --out .uigraph/export
uigraph crawl --url http://localhost:4200 --from-graph
uigraph merge --static .uigraph/graph --runtime .uigraph/graph-runtime --out .uigraph/graph

uigraph path "users/:id"              # ordered steps + locators + preconditions
uigraph screen "/users"               # verified locators on that screen
uigraph explain "Save"                # what it is, where defined, what it triggers
uigraph impact --files src/app/user-detail.ts   # what a diff touches
```

## Why

Agents that test UIs by looking at them re-read the DOM on every step. That is
slow, and the guess is where wrong tests come from. Your code already states
what exists. uigraph extracts it once, verifies it against the running app,
and answers `path`, `screen`, and `explain` from the graph.

Use it when you:

- generate Playwright tests from Angular or Next.js without inventing selectors
- want role, label, and `formControlName` locators instead of `nth()` and CSS
- need a crawler that observes the live app and refuses delete, pay, send, and logout
- want Cursor, Claude Code, or any MCP client to query the UI instead of snapshotting it

## How it works

1. **Static pass** (every commit, no AI, nothing leaves your machine):
   framework adapters parse your code with the framework's own compiler —
   Angular first (`@angular/compiler` + ts-morph), routes, templates, handlers
   resolved to navigations and API calls. Compiled bundles work via source
   maps; without them, a reduced extraction still recovers selectors, routes
   and static attributes.
2. **Runtime crawl** (nightly / on demand): a Playwright crawler visits each
   route, computes real accessible names, proves locator uniqueness, observes
   navigations and network calls. **It never clicks anything destructive.**
3. **Merge**: static + runtime agreement promotes a fact to `verified`.
   Disagreement is `contradicted` and reported — never papered over.
4. **Query**: CLI and MCP tools (`get_screen`, `path_to`, `locators_for`,
   `actions_of`, `stale_check`, `explain`) return compact, auditable answers.
   `unknown` is a valid answer; agents are told to block, not guess.

## Every fact is tagged

| Confidence | Meaning |
|---|---|
| `extracted` | explicit in source |
| `inferred` | resolved (call graph, lazy routes) |
| `observed` | seen in the live app |
| `verified` | static **and** runtime agree, or a probe confirmed it |
| `ambiguous` | several candidates — never used silently |
| `ai_reviewed` | an AI read the code; a hint, never truth |
| `contradicted` | runtime disproved the claim — likely an app bug or stale code |

Only `verified` locators are handed to test generators.

## AI verification — no API keys

uigraph never calls a model. Low-confidence edges become **tasks** your own
coding agent picks up (MCP: `next_task` → `get_bundle` → `submit_probe`).
The agent plans a probe; **uigraph validates it, runs it in a sandboxed
browser, and judges the evidence deterministically.** AI judgment alone caps
at `ai_reviewed`. Plans are saved as recipes and replayed later without AI.

Safety is enforced by uigraph, not by the agent: schema-validated plans,
an on-origin allowlist, and a denylist that rejects destructive actions
(delete / pay / send / logout) no matter what the plan claims.

## Locators without test ids

No `data-testid` required. The ladder: role + accessible name → label →
placeholder → framework-native stable attributes (`formcontrolname`, `name`,
`href`) → scoped text → structure (flagged). Uniqueness is proven on the live
page, and unnamed interactive elements are reported as accessibility findings.

## Install

```bash
npm i -D uigraph
npx uigraph install          # registers the agent skill (--project for repo-local)
npx uigraph mcp              # or add as an MCP server to your agent
```

## Status

v0.1. Angular source and compiled bundles (with source maps, or a reduced
scan without them), Next.js app and pages routes, ng-bootstrap and Angular
Material dialog profiles, crawler, CLI, MCP, verify queue, and a Graphify-style
export (`graph.json`, `GRAPH_REPORT.md`, `graph.html`).

## License

MIT.
