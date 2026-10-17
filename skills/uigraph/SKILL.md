---
name: uigraph
description: Query the uigraph UI knowledge graph before any browsing or page snapshot, write UI tests from its verified locators and paths, and run the uigraph verify loop (lease tasks, plan probes, submit reviews). Use whenever the project has a .uigraph/ directory and you need to know what is on a screen, how to reach it, what an element does, or which tests a code change makes stale.
---

# uigraph

uigraph is a deterministic UI knowledge graph built from source code and a real
browser crawl. **No AI ever writes a fact into it**: you plan, uigraph executes
and judges. Every answer is a verified fact or an explicit `unknown` — never
guess beyond them.

## Query-first rule

**Always query the graph before opening a browser or taking a page snapshot.**
A graph query costs ~100 tokens; a snapshot costs thousands and goes stale.
Only fall back to a browser snapshot when the graph answers `unknown` — and
treat that as a signal the graph needs a rebuild or crawl, not as license to
guess.

## Command map (CLI and MCP tools)

| Need | CLI | MCP tool |
| --- | --- | --- |
| What is on a screen | `uigraph screen <route> [--state s]` | `get_screen{route,state?}` |
| A locator for "the save button" | `uigraph locators <query>` | `locators_for{query}` |
| How to reach a screen | `uigraph path <target> [--from x]` | `path_to{target,from?}` |
| What an element does + safety | `uigraph actions <element>` | `actions_of{element}` |
| Explain any node | `uigraph explain <name>` | `explain{name}` |
| What my diff makes stale | `uigraph impact --files a,b` | `stale_check{files[]}` |
| Health report | `uigraph report --out GRAPH_REPORT.md` | — |
| Build / crawl / merge | `uigraph build` · `uigraph crawl --url u` · `uigraph merge` | — |
| Verify loop | `uigraph verify`, `uigraph task next/submit/review` | `next_task`, `get_bundle`, `submit_probe`, `submit_review` |

Add `--json` to any CLI command for compact JSON. Use only `verified` (or at
worst `observed`/`extracted`) locators in generated tests; never use anything
`ambiguous` without verifying it first.

## The verify loop

1. `next_task` (or `uigraph task next --json`) — leases the oldest open task
   for 10 minutes and returns a compact bundle: the edge under verification,
   its nodes, the relevant source lines, and the plan instructions.
2. Read the bundle. Decide what a real browser would have to see for the edge
   to be true.
3. For a `verify_edge` task: reply with `submit_probe{taskId, plan}` — a
   ProbePlan JSON (see `references/probe-plan.md`). **You only plan.** uigraph
   validates the plan, executes it in a real browser, and judges the evidence
   itself; your plan is a proposal, never a fact.
4. For a `review_edge` task (the edge touches a mutating/destructive/unknown
   action, so it will never be probed): reply with
   `submit_review{taskId, likely, reasoning}`. Your judgment is stored at
   confidence `ai_reviewed` at most — a hint, never `verified`.
5. Repeat until `next_task` returns an empty queue.

**CONTRADICTED means the app likely has a bug** (or the static extraction is
wrong): the code claims one thing, the running app did another. Report it to
the user as a finding. Do not retry with ever-looser plans to force a pass.

## Safety rules (uigraph enforces these; do not fight them)

- Never plan a click or keypress on anything destructive or mutating
  (delete / remove / destroy / pay / purchase / buy / send / publish / logout /
  sign out / cancel account / deactivate...). Such edges are review-only.
- `goto` only relative paths or URLs on the configured base origin
  (on-origin only). Plans that leave the origin are rejected.
- No fixed sleeps, no positional locators (`nth`); use the structured locator
  shapes from the bundle.
- Plans violating these rules are rejected by schema + safety validation
  before anything runs.
