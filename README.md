# Xstore Playwright automation

A standalone TypeScript framework for readable, deterministic Oracle Retail
Xstore POS test scripts. No LLM is used at runtime. Chromium opens visibly by
default, terminal output shows each running step, and every execution produces
JSON and text reports with step status, duration, and total elapsed time.

**Integration boundary:** this is a working runner, not a verified selector
integration for Sherwin-Williams Xstore. Default selectors are illustrative.
Map them to your deployed web UI before running a real sale. Desktop/native
Xstore screens are outside Playwright's scope.

## Install and run

Requires Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run dry-run
```

`dry-run` parses the example and validates all referenced files and selector
field mappings. It does **not** connect to Xstore or confirm selectors.

For localhost:

```sh
npm start -- --script examples/cash-sale.xstore --config config/localhost.example.json --base-url http://localhost:8080 --slow-mo 500
```

For a remote test server, use the same script and change the base URL:

```sh
npm start -- --script examples/cash-sale.xstore --config config/remote.local.json --base-url https://pos-test.example.com
```

Copy the example environment configuration to `config/remote.local.json` and
adjust selectors for that deployment. `--base-url` overrides the configuration;
otherwise the default is `http://localhost:8080`. Relative navigation paths
resolve using standard URL rules (a leading `/` starts at the origin).
Absolute HTTP(S) URLs in scripts bypass the base URL. URLs containing credentials
and non-HTTP(S) URLs are rejected.

Use `--headless` for CI, `--slow-mo 0` for normal speed, and
`--report-dir <directory>` to change report location. `npm start -- --help`
lists all flags. The browser closes at the end; step output is visible while it
runs. `npm run build` emits JavaScript; the built CLI is `node dist/src/cli.js`.

**Safety:** use a test store/register with test data. Completing a cash sale
changes POS state; there is no rollback or retry. Dry-run first, then validate
selectors against your live test UI. Never point this at production accidentally.

## Script syntax

One step per line. Keywords are case-insensitive, but quoted paths/URLs and
product IDs retain their case/content. Optional `1. ` numbering is cosmetic;
reports use actual source line numbers. Blank lines and whole-line `#` comments
are ignored. No arbitrary JavaScript, interpolation, or natural-language guessing.
Unrecognized steps fail before any browser action.

```text
1. Open app at "/"
2. Use first-time configuration from "../secrets/configuration.local.txt" if prompted
3. Log in using "../secrets/credentials.local.txt"
4. Go to Start Transaction
5. Start a sale as a DIY Customer
6. Add products 650921315, 651234940
7. Check out with cash using the exact amount due
```

The first executable step must be `Open app at "URL-or-path"`. The seven patterns
above are the complete supported vocabulary. Paths must be double-quoted;
inline comments, escaped quotes, and multiline steps are not supported.
Product IDs are comma-separated digit strings; leading zeros are preserved.
Repeated IDs are sent as repeated scans.

## External inputs and secrets

Paths referenced by a script resolve **relative to the script**, while CLI paths
resolve relative to the current directory. Input files contain JSON, even when
named `.txt`. All inputs are checked before opening the browser.

Credentials contain exactly these two non-empty string fields:

```json
{ "username": "your-test-user", "password": "your-test-password" }
```

First-time configuration contains non-empty string values keyed by
`configurationFields` in the environment file:

```json
{ "storeId": "123", "registerId": "1" }
```

Each supplied key must have a field selector. Missing required UI fields will
cause the application/next-screen wait to fail; the runner does not invent
configuration values. Put real files in ignored `secrets/` or use
`*.local.txt` / `config/*.local.json`; never replace committed demo values with
real credentials. Inspect git status before committing.

The runner redacts loaded input values from persisted error messages and step
text, does not log fill values, and writes reports with owner-only permissions
on POSIX. Reports can still reveal URLs, paths, UI labels and other application
data; keep them private. Do not put credentials directly in scripts or selectors.

## Adapting to Xstore

All action selectors live in `src/config.ts` (`defaultSelectors`) and can be
overridden via the environment JSON's `selectors` object. They accept Playwright
selector strings (`css`, `text=`, etc.). Unknown selector/config keys are rejected.
Use unique, stable selectors for your specific customization; repeated/ambiguous
buttons fail rather than choosing an arbitrary match.

```json
{
  "baseUrl": "http://localhost:8080",
  "timeoutMs": 20000,
  "browserState": "fresh",
  "selectors": {
    "configurationScreen": "#initial-setup",
    "username": "#operator-id",
    "password": "#operator-password",
    "loginSubmit": "button:has-text(\"Login\")",
    "cartItems": "#cart .sale-line",
    "amountDue": "#cash-tender .balance",
    "transactionComplete": "#receipt-complete"
  },
  "configurationFields": {
    "storeId": "#setup-store",
    "registerId": "#setup-register"
  }
}
```

`browserState` (environment config only, never a script step) controls browser
state. The only supported value, and the default when omitted, is `"fresh"`: every
run uses a new isolated context with no cookies or storage. Any other value,
including a persistent profile, is rejected until implemented; the extension point
is the `newContext()` call in `src/runner.ts`.

`configurationScreen` must identify only the first-time setup panel; `username`
and `startTransaction` identify the alternative ready screens. The conditional
step waits for one of those screens, skips if setup is absent, and fails on an
unknown screen/time-out. Login is not silently skipped.

The supplied flow assumes **Sale -> DIY Customer -> scan products -> Checkout ->
Cash -> enter amount -> Complete Transaction**. `cartItems` must enumerate each
scanned sale line (not headers or quantity-only rows): each product addition
waits for the line count to increase. If your Xstore combines identical scans
into one quantity row, add a deployment-specific quantity assertion in
`src/xstore.ts`. Additional prompts (customer lookup, receipt choices, tax
dialogs, store-specific login/configuration screens) require explicit actions.

`amountDue` must select the visible numeric balance only, not a label or the
whole checkout panel. The parser accepts non-negative amounts, optional configured
currency symbol at either end, and up to two decimal places. Grouping uses
three-digit groups; defaults accept `$1,234.56`. Set `amountFormat` for e.g.
`{"decimalSeparator": ",", "groupSeparator": ".", "currencySymbol": "\u20ac"}`.
The cash input receives `1234.56` (or the configured decimal equivalent),
without floating-point rounding. Other currency precision/grouping conventions
need an adapter change. Transaction success requires the configured completion
marker, not merely a successful click.

## Reports and failure behavior

Reports are unique `reports/run-*.json` / `.txt` files (ignored by git).
Step statuses are `passed`, `skipped` (conditional setup), `failed`, `not-run`
(after failure), or `planned` (dry-run). Dry-run's overall `passed` means preflight
succeeded, not that the UI was tested. Durations are integer milliseconds using
a monotonic clock. Total includes browser startup/cleanup; per-step timing
includes action waits and slow motion, but excludes preflight/report writing.

The first failed step stops execution, preserves its error and timing, marks
remaining steps `not-run`, and exits nonzero. Browser startup/navigation/cleanup
failures also produce a failed report. Invalid syntax, invalid environment data,
and missing/malformed input files fail preflight with a nonzero exit and no run
report. Report write failures are surfaced, not treated as success.

## Extending and verifying

To add a keyword, add an `Action` variant and matching anchored pattern in
`src/parser.ts`, implement it in `executeAction` in `src/xstore.ts`, centralize
any new selectors in `src/config.ts`, and add parser/action tests. Do not use
arbitrary executable code from scripts. Keep conditionals bounded by explicit
known screen markers.

```sh
npm test                 # parser, currency, configuration and dry-run tests
npm run test:browser     # actual Chromium against a local HTTP mock
npm run typecheck
```

The browser integration suite checks first-time setup present/absent, login,
product scans, exact cash tender, transaction completion, and fail-fast reports.
It does not claim compatibility with an unobserved Xstore deployment.
To watch the safe mock workflow in a visible browser on macOS/Linux, run
`HEADED=1 npm run test:browser`.
