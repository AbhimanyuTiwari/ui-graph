# Token comparison

Measured on the Angular fixture (`fixtures/angular-app`, 55 graph nodes) with `scripts/measure-tokens.ts` on 2026-10-17. Tokens are `ceil(chars / 4)`, the same estimate the query budget uses.

Seven questions — three screens, two paths, one explain, one locator search — cost **1403** tokens from the graph. Reading every `.ts` and `.html` file under `src/` costs **1825** tokens. The largest single answer (`getScreen /users/:id`) is **467** tokens.

| Question | Graph tokens |
| --- | ---: |
| getScreen /users | 269 |
| getScreen /users/:id | 467 |
| getScreen /login | 221 |
| pathTo /users/:id | 159 |
| pathTo /users#modal:CreateUserDialog | 138 |
| explain Sign in | 26 |
| locators email | 123 |
| **Sum** | **1403** |
| Read all fixture source | 1825 |

`tests/core/benchmark.test.ts` fails if that sum exceeds the source read or 1500 tokens. The fixture is small, so the gap is the per-answer size (467 versus 1825), not a large batch multiplier.
