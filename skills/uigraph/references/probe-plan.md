# ProbePlan reference

A probe plan is the JSON you submit for a `verify_edge` task. uigraph
validates it, executes it in a real browser, and judges the evidence —
you never execute anything and never write a fact.

## Shape

```json
{
  "edgeKey": "<copy exactly from the task bundle>",
  "steps": [
    { "action": "goto | click | fill | press | waitFor",
      "url": "/relative/path (goto only)",
      "locator": { ...LocatorDescriptor... },
      "value": "text to fill / key name for press" }
  ],
  "expect": [
    { "type": "element | url | request",
      "locator": { ...LocatorDescriptor (element) ... },
      "urlPattern": "regex source (url/request)",
      "method": "GET|POST|... (request)" }
  ]
}
```

- `steps`: 1–25 entries. `expect`: 1–10 entries.
- LocatorDescriptor: `{ "strategy": "role|label|placeholder|text|attr|css",
  "role"?, "name"?, "nameRegex"?, "attr"?: {"name","value"}, "css"?,
  "scope"?: [outer locators], "filterText"? }`. Prefer the ladder:
  role+name > label > placeholder > attr > scoped text > css.
- Verdicts: every step ran and every expectation matched → `verified`;
  steps ran but an expectation failed → `contradicted` (likely an app bug —
  report it, don't force a pass); a step itself failed → `unreached`.

## Example 1 — navigate check

Edge claim: clicking "Add user" on `/users` navigates to `/users/new`.

```json
{
  "edgeKey": "action_ab12cd34ef56|NAVIGATES_TO|screen_1234abcd5678",
  "steps": [
    { "action": "goto", "url": "/users" },
    { "action": "click", "locator": { "strategy": "role", "role": "button", "name": "Add user" } }
  ],
  "expect": [
    { "type": "url", "urlPattern": "/users/new$" },
    { "type": "element", "locator": { "strategy": "role", "role": "heading", "name": "New user" } }
  ]
}
```

## Example 2 — modal check

Edge claim: clicking "Edit profile" opens a dialog (OPENS edge).

```json
{
  "edgeKey": "action_9f8e7d6c5b4a|OPENS|screen_0a1b2c3d4e5f",
  "steps": [
    { "action": "goto", "url": "/settings" },
    { "action": "click", "locator": { "strategy": "role", "role": "button", "name": "Edit profile" } },
    { "action": "waitFor", "locator": { "strategy": "role", "role": "dialog" } }
  ],
  "expect": [
    { "type": "element",
      "locator": { "strategy": "role", "role": "heading", "name": "Edit profile",
                   "scope": [ { "strategy": "role", "role": "dialog" } ] } }
  ]
}
```

## Example 3 — request expectation

Edge claim: submitting the search form calls `GET /api/users?q=...` (CALLS edge).

```json
{
  "edgeKey": "action_1122334455aa|CALLS|api_bbccddeeff00",
  "steps": [
    { "action": "goto", "url": "/users" },
    { "action": "fill", "locator": { "strategy": "placeholder", "name": "Search users" }, "value": "ada" },
    { "action": "press", "locator": { "strategy": "placeholder", "name": "Search users" }, "value": "Enter" }
  ],
  "expect": [
    { "type": "request", "method": "GET", "urlPattern": "/api/users\\?q=" }
  ]
}
```

## Rejection rules (validated before anything runs)

Your plan is rejected — nothing executes — when any of these hold:

1. It does not match the schema (unknown fields, missing `edgeKey`, empty
   `steps` or `expect`, oversized strings, >25 steps, >10 expectations).
2. `edgeKey` does not match the task's edge.
3. Any `click`/`press` targets a locator whose text matches the destructive
   denylist (`delete`, `remove`, `destroy`, `pay`, `purchase`, `buy`, `send`,
   `publish`, `logout`, `log out`, `sign out`, `cancel account`,
   `deactivate`). Those edges are review-only: use `submit_review`.
4. Any `goto` leaves the configured base origin — only relative paths or
   same-origin URLs are allowed.
5. The task is a `review_edge` task (probes are never run against unsafe
   actions).

If your plan is rejected, fix the plan; do not look for a way around the
validator.
