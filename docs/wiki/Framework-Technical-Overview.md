# Framework Technical Overview

> Wiki-ready page. Source of truth lives in `docs/wiki/`; copy it into a GitHub
> Wiki page (e.g. `Framework-Technical-Overview`) when a remote exists. This
> repo currently has no GitHub remote, so nothing has been published.
> Reflects commit `49e435f`; update as the implementation changes.

## 1. Purpose

A standalone TypeScript + Playwright runner that executes human-readable,
deterministic test scripts against Oracle Retail Xstore POS (localhost now,
remote test servers later). No LLM or natural-language guessing at runtime: a
fixed vocabulary of step patterns maps to Playwright actions.

Goals: watchable (headed browser, `slowMo`), reproducible, and ending with a
report of each step's status and duration plus a total.

> **Integration boundary:** the runner and mock workflow are verified. The
> default Xstore selectors are **illustrative and unverified** against any real
> Xstore/Sherwin-Williams deployment. They must be mapped to the actual web UI
> before running a real sale. Native/desktop Xstore screens are out of scope.

## 2. Architecture

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Argument parsing (`--script`, `--config`, `--base-url`, `--dry-run`, `--headless`, `--slow-mo`, `--report-dir`), exit code |
| `src/parser.ts` | Script text -> `Step[]` (`Action` union); syntax errors with line numbers |
| `src/config.ts` | Environment config loading/validation, `defaultSelectors`, URL validation, JSON input helpers |
| `src/runner.ts` | Preflight, browser lifecycle, step loop, timing, redaction, report writing |
| `src/xstore.ts` | `executeAction` (Playwright actions per keyword), `exactCashAmount` |
| `examples/` | Sample script and example input files |
| `config/localhost.example.json` | Example environment config |
| `tests/` | Unit tests and mock-app Chromium integration tests |

```mermaid
flowchart LR
  S[Script .xstore] --> P[parseScript]
  C[Env config JSON + --base-url] --> L[loadConfiguration]
  P --> F[Preflight: URLs, input files]
  L --> F
  F -->|--dry-run| R[Report: planned]
  F --> B[Launch Chromium]
  B --> E[executeAction per step]
  E --> R2[Report: JSON + text]
```

## 3. Workflow: how input is interpreted

1. **CLI** loads the environment configuration (`loadConfiguration`). The
   `--base-url` flag overrides `baseUrl` in the file; default
   `http://localhost:8080`.
2. **Parse** (`parseScript`): each non-blank, non-`#` line has an optional
   `N. ` prefix stripped, then must match one anchored, case-insensitive
   pattern. Unknown lines throw `Line N: unknown step` **before any browser
   action**. The script must contain steps and the first must be `Open app at`.
3. **Preflight** (`runScript`, before any browser): validates `Open app` URLs;
   reads every referenced input file (paths relative to the script), checks
   shape (credentials: exactly `username` + `password`; configuration: non-empty
   and every key has a field selector in `configurationFields`). Loaded values
   are collected for redaction. Preflight failures throw, exit nonzero, and
   write **no** report.
4. **Dry run** (`--dry-run`): marks every step `planned`, writes a report, never
   launches a browser or contacts Xstore. A dry-run "passed" means preflight
   succeeded, not that the UI works.
5. **Live run**: launches Chromium (headed by default, `slowMo` default 250 ms),
   sets default and navigation timeouts to `timeoutMs`, and executes steps
   sequentially. Console shows `[running]` / `[passed|skipped|failed]` with
   durations live.
6. **Failure handling**: the first failed step records its (redacted) error,
   stops execution, leaves later steps `not-run`, and the process exits 1.
   Browser start/navigation/cleanup errors also yield a failed report.
7. **Report**: `reports/run-<timestamp>-<id>.json` and `.txt` (git-ignored,
   mode `0600`) with status, start/finish, total ms, and per-step line, text,
   status, duration, error. Durations use a monotonic clock; total includes
   browser startup/cleanup.

Statuses: `planned`, `passed`, `skipped` (conditional step not needed),
`failed`, `not-run`.

## 4. Prerequisites and running on your device

- Node.js **22+** and npm
- Network access to download Playwright's Chromium (one-time)
- A reachable Xstore web endpoint (not needed for dry-run or mock tests)

```sh
npm ci                          # or: npm install
npx playwright install chromium
npm run typecheck
npm test                        # parser, config, cash parsing, dry-run
npm run test:browser            # real Chromium against a local mock app
HEADED=1 npm run test:browser   # watch the mock run in a visible browser
npm run dry-run                 # validate the example script/inputs only
npm run build                   # emits dist/; CLI: node dist/src/cli.js
```

Run against **localhost**:

```sh
npm start -- --script examples/cash-sale.xstore \
  --config config/localhost.example.json --base-url http://localhost:8080 --slow-mo 500
```

Run against a **remote test server** (same script, different environment):

```sh
cp config/localhost.example.json config/remote.local.json   # ignored by git
npm start -- --script examples/cash-sale.xstore \
  --config config/remote.local.json --base-url https://pos-test.example.com
```

Flags: `--dry-run`, `--headless` (CI), `--slow-mo <ms>` (`0` = full speed),
`--report-dir <dir>`, `--help`.

> **Safety:** a real run completes a cash sale and changes POS state, with no
> rollback or retry. Use a test store/register and test data; never target
> production by accident. Dry-run first.

## 5. Writing a new script

Create a `.xstore` text file. One step per line; blank lines and whole-line `#`
comments are ignored; `1.` numbering is cosmetic (reports use source line
numbers). Keywords are case-insensitive; quoted paths/URLs and product IDs keep
their exact content.

```text
# examples/cash-sale.xstore
1. Open app at "/"
2. Use first-time configuration from "configuration.example.json" if prompted
3. Log in using "credentials.example.json"
4. Go to Start Transaction
5. Start a sale as a DIY Customer
6. Add products 650921315, 651234940
7. Check out with cash using the exact amount due
```

### Supported keywords (complete vocabulary)

| Step | Action |
| --- | --- |
| `Open app at "URL-or-path"` | Navigate (relative to base URL; absolute HTTP(S) bypasses it); fails on non-OK HTTP. Must be first. |
| `Use first-time configuration from "file" if prompted` | Conditional: waits for setup, login, or start-transaction screen; fills fields and submits only if the setup screen is visible, else `skipped` |
| `Log in using "file"` | Fills username/password, submits, waits for the Start Transaction control. Never skipped. |
| `Go to Start Transaction` | Clicks the start-transaction control |
| `Start a sale as a DIY Customer` | Clicks Sale, then DIY Customer |
| `Add products <id>[, <id>...]` | Per ID: fills, adds, then waits for the cart line count to increase. Leading zeros and repeats preserved. |
| `Check out with cash using the exact amount due` | Checkout -> Cash -> reads amount due -> enters exact amount -> completes -> waits for completion marker |

Restrictions: paths must be double-quoted; no inline comments, escaped quotes,
multiline steps, interpolation, or embedded code.

### External input files

Paths inside a script resolve relative to the **script's directory**; CLI paths
resolve relative to the current directory. Files contain JSON (even if named
`.txt`).

Credentials (exactly these two non-empty strings):

```json
{ "username": "your-test-user", "password": "your-test-password" }
```

First-time configuration (non-empty strings keyed by `configurationFields`):

```json
{ "storeId": "123", "registerId": "1" }
```

Keep real values out of git: use the ignored `secrets/`, `*.local.txt`, or
`config/*.local.json`. Committed `examples/*.example.json` hold demo values
only. Loaded values are redacted from persisted step text and errors; reports
can still expose URLs, paths and UI text, so keep them private.

## 6. Environment configuration

`config/localhost.example.json` (unknown keys are rejected):

| Key | Meaning | Default |
| --- | --- | --- |
| `baseUrl` | HTTP(S) origin; no embedded credentials | `http://localhost:8080` |
| `timeoutMs` | Positive integer timeout for actions/navigation | `15000` |
| `ignoreHttpsErrors` | Opt-in: accept a trusted self-signed HTTPS certificate for the run's context only | `false` |
| `browserState` | Browser state per run. Only `"fresh"` (new isolated context) is supported; other values are rejected | `"fresh"` |
| `selectors` | Overrides for named selectors (see below) | `defaultSelectors` |
| `configurationFields` | Config-file key -> field selector | `storeId`, `registerId` inputs |
| `amountFormat` | `decimalSeparator`, `groupSeparator`, `currencySymbol` | `.`, `,`, `$` |

Cash amounts are parsed as strings (no floating point): optional currency symbol
at either end, three-digit grouping, up to two decimals, e.g. `$1,234.56` ->
`1234.56`. Ambiguous text (labels, negatives, 3 decimals) is rejected. For
other locales set `amountFormat`.

## 7. Xstore selectors and integration boundaries

All selectors are centralized in `defaultSelectors` (`src/config.ts`) and
overridable per environment via `selectors` (Playwright selector strings; unique
and stable ones recommended — ambiguous matches fail rather than guess).

Names: `configurationScreen`, `configurationSubmit`, `username`, `password`,
`loginSubmit`, `startTransaction`, `startSale`, `diyCustomer`, `productId`,
`addProduct`, `cartItems`, `checkout`, `cash`, `amountDue`, `cashAmount`,
`completeTransaction`, `transactionComplete`.

Known assumptions to validate against the real deployment:

- Flow is Sale -> DIY Customer -> scan -> Checkout -> Cash -> amount -> Complete.
- `configurationScreen` identifies only the setup panel; `username` and
  `startTransaction` identify the alternative ready screens.
- `cartItems` matches one element per scanned line; systems that merge repeated
  scans into a quantity row need an adjusted assertion in `src/xstore.ts`.
- `amountDue` selects only the numeric balance.
- `transactionComplete` is a reliable success marker.
- Extra prompts (customer lookup, receipts, tax dialogs, store-specific login)
  need explicit new actions.

The customization source at `na-pos` (e.g. `shw_xstore/`) may help find screen
labels, but selectors have **not** been verified against a running Xstore.

## 8. Adding a new keyword

1. Add a variant to the `Action` union in `src/parser.ts`.
2. Add an anchored pattern branch in `parseScript` returning that action.
3. Implement it in `executeAction` (`src/xstore.ts`); wait on explicit UI
   conditions, not fixed sleeps. Return `"skipped"` only for bounded
   conditionals with known screen markers.
4. Add any new selector to `defaultSelectors` (and the README/this page).
5. If it takes an input file, extend preflight in `src/runner.ts`.
6. Add parser tests (`tests/framework.test.ts`) and a mock-flow case
   (`tests/browser.integration.ts`) if behaviour is observable.
7. Update the syntax table above.

## 9. Testing

- `npm test`: parsing, rejection of malformed syntax, cash parsing, config
  validation, dry-run reports, and preflight/redaction errors.
- `npm run test:browser`: real Chromium vs. a local HTTP mock: setup
  present/absent, login, scans, exact tender, completion, and fail-fast reports
  (rejected product, login failure with redaction, HTTP error). This proves the
  runner, not compatibility with an unobserved Xstore deployment.

## 10. Smoke test: "Xstore is running" (live-verified shell flow)

`smoke/xstore-is-running.xstore` + `config/localhost-shell.json` +
`smoke/shell-configuration.json` verify the shell app reaches the real Xstore
login screen (no login, no sale). Run:

```sh
npm start -- --script smoke/xstore-is-running.xstore --config config/localhost-shell.json --slow-mo 400 --report-dir reports/live
```

Keywords added: `Use Xstore shell configuration from "file" if prompted`
(`shellConfigure`: Location Details, Connection Details, requires a Success
Test Connection dialog, saves, Launch Xstore; skipped if the setup screen is
absent), `Dismiss the device error prompt if shown` (`dismissDeviceError`, OK on
a "Hardware Error" dialog if present) and `Wait for the Xstore login screen`
(`expectLogin`). The shell file needs exactly `store`, `register`, `host`,
`port` (strings, port 1-65535; not redacted since they are not secrets).

Config: `ignoreHttpsErrors` (default `false`) sets Playwright's
`ignoreHTTPSErrors` on the fresh context only, to trust localhost's
self-signed certificate; no browser/system trust changes. Failures (service
down, failed connection test, unknown screen, no login) are failed runs with a
saved report and a per-step failure screenshot (`<run>-line-N.png`).

Selectors for these screens (`shell*`, `deviceError*`, `loginReady`) were taken
from the live app on 2026-11-16 (e.g. `#configMain`, `[id="storeNumber|input"]`,
`oj-dialog`, `#focusBarInfoArea`). Observed behavior: the "Hardware Error"
(barcode scanner) dialog appeared in some launches and not others, and one
headed run timed out waiting for the setup screen (cause not determined), so
treat timing as variable. Cash-sale selectors remain unverified.

## 11. Roadmap / open questions (edit as the project matures)

- Map and verify selectors against a live Xstore test environment.
- Additional keywords (returns, other tenders, voids, assertions).
- Screenshots/traces on failure; retries; per-step timing aggregates.
- Persistent browser profile as a new `browserState` value (extension point: `newContext()` in `src/runner.ts`).
- Remote-server environment configs and CI usage.
- Publish this page to the GitHub Wiki once a remote repository exists.
