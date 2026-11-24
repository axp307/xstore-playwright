---
name: xstore-scripts
description: Write, edit, run, or debug .xstore test scripts, and add new .xstore keywords (parser patterns, actions, selectors) in this Playwright framework. Use when asked to create an Xstore POS test, add a step/keyword, or fix a failing script.
---

# Writing `.xstore` scripts and adding keywords

`.xstore` files are plain-text test scripts. Each line is matched against a **fixed set of protected keywords** in `src/parser.ts`; anything else is rejected before a browser opens. Never invent step wording: use an existing keyword or add one (see "Adding a keyword").

## Quick reference

| File | Role |
|---|---|
| `src/parser.ts` | `Action` union + regex per keyword. Source of truth for valid lines. |
| `src/xstore.ts` | `executeAction` switch: what each action does in the browser. |
| `src/runner.ts` | Preflight of input files (JSON), step timing, redaction, reports. |
| `src/config.ts` | `defaultSelectors` registry, config loading, JSON validators. |
| `tests/framework.test.ts` | Parser/preflight unit tests (no browser). |
| `diy-sale/`, `smoke/`, `examples/` | Real example scripts and their JSON inputs. |

## Script format

- One step per line; optional numbering (`1. `) is stripped. Blank lines and `#` comments are ignored.
- Keywords are case-insensitive; quoted values are case-preserved.
- The **first step must be `Open app at "..."`**. A script needs at least one step.
- File paths in quotes are **relative to the `.xstore` file's directory**.
- Put a `#` header comment explaining purpose, side effects (e.g. "completes a real sale"), and the `--config` to use.
- Steps ending in `if shown` / `if prompted` are conditional and report `skipped` when not applicable.

## Current keywords

`src/parser.ts` is authoritative; re-check it. At time of writing:

| Step text | Notes |
|---|---|
| `Open app at "<path-or-url>"` | Must be first. Resolved against `baseUrl`. |
| `Use Xstore shell configuration from "<json>" if prompted` | JSON: exactly `store`, `register`, `host`, `port`. |
| `Dismiss the device error prompt if shown` | |
| `Wait for the Xstore login screen` / `... if shown` | |
| `Log in at the Xstore login screen using "<json>"` / `... if shown` | JSON: exactly `username`, `password`. |
| `Click on "Start Transaction"` | Skips if already on Customer Lookup. |
| `Skip customer lookup` | |
| `Scan sale items from "<json>"` | See `diy-sale/sale-items.json` for shape. |
| `Click on "Amount Due"` | |
| `Note the amount due and click on "Cash"` | Must precede the next step. |
| `Enter the exact amount due and press Enter` | Requires the noted amount. |
| `Wait for the Customer Lookup or Main Menu screen` | Sale-complete check. |

Legacy keywords (`Use first-time configuration ...`, `Log in using ...`, `Go to Start Transaction`, `Start a sale as a DIY Customer`, `Add products ...`, `Check out with cash using the exact amount due`) rely on **guessed selectors** unverified against a live Xstore. Prefer the verified ones above.

## Writing a new test

1. Copy the closest script (`diy-sale/diy-sale-with-cash.xstore` for transactions, `smoke/xstore-is-running.xstore` for read-only checks).
2. Put inputs in sibling JSON files. Never commit real credentials; use `*.example.json` templates and git-ignored files (`secrets/`, `config/*.local.json`).
3. Validate without a browser:
   ```sh
   npm start -- --script path/to/test.xstore --config config/localhost-shell.json --dry-run
   ```
   Dry run parses and preflights all inputs and lists planned steps.
4. Run live (test instances only; never production):
   ```sh
   npm start -- --script path/to/test.xstore --config config/localhost-shell.json --slow-mo 400 --report-dir reports/live
   ```
5. Reports (JSON + text, plus a masked screenshot on failure) go to the report dir.

## Adding a keyword

Do all of these; skipping one is the usual cause of bugs.

1. **`src/parser.ts`**
   - Add a member to the `Action` union (e.g. `{ kind: "myAction"; file: string }`).
   - Add an `else if` branch with an anchored, case-insensitive regex (`^...$`, `/i`). Quote user-supplied values as `"([^"]+)"`. Order matters: put more specific patterns before overlapping general ones.
   - Keep the unknown-step error unchanged.
2. **`src/config.ts`** — add new selectors to `defaultSelectors`: VERIFIED block only once confirmed on the live UI, otherwise GUESSED with a comment. Prefer ids/roles over text; each selector must match exactly one visible element. Environments can override via `selectors` in the config JSON.
3. **`src/xstore.ts`** — add a `case` in `executeAction`:
   - Return `"skipped"` for conditional steps; otherwise `break` (passes); throw on failure.
   - Wait for a concrete UI state (`waitFor`, `expect(...).toHaveCount`), not fixed delays.
   - Read-only keypad inputs need `page.keyboard.type`, not `fill()`.
   - Cross-step state (like the noted amount) lives in a `WeakMap<Page, ...>`.
4. **`src/runner.ts`** — only if the keyword takes an input file: add its kind to the preflight loop, validate the file shape (fail early with `Line N: ...`), and decide whether values are secrets (secrets go into `secretValues` and are redacted from reports; non-secret data like store/host or sale IDs must `continue` before that).
5. **Tests** in `tests/framework.test.ts`: add the line to the keyword-parsing test, plus a negative/preflight case if there is validation.
6. **Docs**: update the table above, and `docs/wiki/Technical-Overview.md` / `README.md` if user-facing.
7. Verify: `npm run typecheck && npm test`, then `--dry-run`, then (if a test instance is available) a headed live run with `--slow-mo`.

## Finding real selectors

Run headed with `--slow-mo`, inspect the element in the live Xstore (Oracle JET `oj-*` components; many inputs are read-only and keypad-driven), and confirm the locator resolves to one visible element before adding it to `defaultSelectors`.

## Safety rules

- Live scripts can complete real transactions: test instances only.
- Never print or commit credentials.
- `ignoreHttpsErrors` is opt-in via config, for trusted localhost only.
