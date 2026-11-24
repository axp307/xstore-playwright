import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseScript } from "../src/parser.js";
import { exactCashAmount } from "../src/xstore.js";
import { httpUrl, loadConfiguration, readJson } from "../src/config.js";
import { formatRunSummary, formatStepLog, runScript } from "../src/runner.js";
import { workspace } from "./helpers.js";

// Verifies the sample script maps to the seven expected actions with original line numbers.
// Also checks product IDs keep leading zeros and repeats and keywords are case-insensitive.
test("parses all sample keywords, preserving source line numbers and product IDs", async () => {
  const steps = parseScript(await readFile("examples/cash-sale.xstore", "utf8"));
  assert.deepEqual(steps.map(step => step.action.kind), [
    "open", "configure", "login", "startTransaction", "startSale", "addProducts", "cashCheckout"
  ]);
  assert.equal(steps[0]!.line, 3);
  assert.deepEqual(steps[5]!.action, { kind: "addProducts", products: ["650921315", "651234940"] });
  assert.deepEqual(parseScript('open APP at "/"\nAdd products 000123, 000123')[1]!.action,
    { kind: "addProducts", products: ["000123", "000123"] });
});

// Confirms malformed or unknown steps throw at parse time, with the failing line number.
// Guards against arbitrary commands or loosely matched sentences being accepted.
test("rejects unsupported syntax and malformed product lists before execution", () => {
  for (const source of [
    "", "# no steps", "Log in using \"creds.json\"", 'Open app at "/" trailing',
    'Open app at "/"\nAdd products 123,', 'Open app at "/"\nAdd products 123, abc',
    'Open app at "/"\nEvaluate "alert(1)"', 'Open app at "/"\nStart a sale as a VIP Customer'
  ]) {
    assert.throws(() => parseScript(source));
  }
  assert.throws(() => parseScript('Open app at "/"\n\n# comment\nUnknown action'), /Line 4/);
});

// Checks exactCashAmount normalizes valid amounts without float rounding, incl. locale formats.
// Also asserts ambiguous strings (labels, negatives, 3 decimals) are rejected.
test("cash parsing is exact, supports grouping and alternate separators, rejects ambiguous amounts", async () => {
  const { amountFormat } = await loadConfiguration();
  for (const [input, expected] of [
    ["$1,234.56", "1234.56"], ["0.1", "0.10"], ["12", "12.00"],
    ["001.05", "1.05"], [" 0.00 $ ", "0.00"], ["9007199254740993.01", "9007199254740993.01"]
  ]) {
    assert.equal(exactCashAmount(input!, amountFormat), expected);
  }
  assert.equal(exactCashAmount("1.234,50 \u20ac", {
    decimalSeparator: ",", groupSeparator: ".", currencySymbol: "\u20ac"
  }), "1234,50");
  for (const input of ["", "-1.00", "1.234", "$12,34.56", "Amount Due: $12.34", "NaN", "1e3", "12.34 56.78"]) {
    assert.throws(() => exactCashAmount(input, amountFormat));
  }
});

// Verifies config loading: --base-url precedence, selector merging, and URL resolution rules.
// Iterates invalid configs (bad types, unknown keys, bad separators) that must be rejected.
test("configuration overrides are validated and base URL override wins", async t => {
  const directory = await workspace(t);
  const file = resolve(directory, "config.json");
  await writeFile(file, JSON.stringify({
    baseUrl: "http://localhost:8080", selectors: { username: "#user" },
    configurationFields: { site: "#site" }
  }));
  const config = await loadConfiguration(file, "https://test.example.com/pos/");
  assert.equal(config.baseUrl, "https://test.example.com/pos/");
  assert.equal(config.browserState, "fresh");
  assert.equal(config.ignoreHttpsErrors, false);
  assert.equal(config.stepDelayMs, 0);
  assert.equal((await loadConfiguration("config/localhost-shell.json")).stepDelayMs, 1000);
  assert.equal((await loadConfiguration("config/localhost-shell.json")).ignoreHttpsErrors, true);
  await writeFile(file, JSON.stringify({ browserState: "fresh" }));
  assert.equal((await loadConfiguration(file)).browserState, "fresh");
  assert.equal((await loadConfiguration("config/localhost.example.json")).browserState, "fresh");
  await writeFile(file, JSON.stringify({
    baseUrl: "http://localhost:8080", selectors: { username: "#user" },
    configurationFields: { site: "#site" }
  }));
  assert.equal(config.selectors.username, "#user");
  assert.equal(config.selectors.password, 'input[name="password"]');
  assert.deepEqual(config.configurationFields, { site: "#site" });
  assert.equal(httpUrl("login", config.baseUrl), "https://test.example.com/pos/login");
  assert.equal(httpUrl("/login", config.baseUrl), "https://test.example.com/login");
  for (const input of [
    { timeoutMs: 0 }, { ignoreHttpsErrors: "yes" }, { stepDelayMs: -1 }, { stepDelayMs: 1.5 }, { stepDelayMs: "1000" }, { stepDelayMs: null }, { browserState: "persistent" }, { browserState: null }, { timeoutMs: "100" }, { baseUrl: "file:///tmp/app" },
    { selectors: { usernme: "#user" } }, { selectors: { toString: "#x" } },
    { selectors: { username: "" } }, { unknownOption: true },
    { amountFormat: { decimalSeparator: ",", groupSeparator: "," } },
    { amountFormat: { decimalSeparator: "2" } }
  ]) {
    await writeFile(file, JSON.stringify(input));
    await assert.rejects(loadConfiguration(file));
  }
  assert.throws(() => httpUrl("https://user:password@example.com"));
});

// Runs the sample in dry-run mode and checks every step is planned with zero duration.
// Confirms reports persist and example input values never appear in the text report.
test("console formatters show the measured execution/observation-delay breakdown", () => {
  const step = { line: 5, step: "x", status: "passed" as const, durationMs: 1250, executionMs: 250, observationDelayMs: 1000 };
  assert.equal(formatStepLog(step), "[passed] line 5 (elapsed 1250 ms = execution 250 ms + observation delay 1000 ms)");
  const summary = formatRunSummary({
    mode: "browser", status: "passed", startedAt: "", finishedAt: "", durationMs: 2000,
    stepExecutionMs: 500, stepObservationDelayMs: 1000, scanTimes: [], steps: [step]
  });
  assert.equal(summary, "Run passed; steps: execution 500 ms + observation delay 1000 ms; wall-clock total 2000 ms (includes ~500 ms browser startup/cleanup and other overhead).");
});

test("dry-run validates external files and writes planned steps without launching a browser", async t => {
  const directory = await workspace(t);
  const result = await runScript({
    script: "examples/cash-sale.xstore", config: await loadConfiguration(),
    dryRun: true, reportDir: directory
  });
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.mode, "dry-run");
  assert.equal(result.report.steps.length, 7);
  assert.ok(result.report.steps.every(step => step.status === "planned" && step.durationMs === 0 && step.executionMs === 0 && step.observationDelayMs === 0));
  assert.equal(result.report.stepObservationDelayMs, 0);
  assert.ok(result.report.durationMs >= 0);
  assert.deepEqual(JSON.parse(await readFile(result.jsonPath, "utf8")), result.report);
  const text = await readFile(result.textPath, "utf8");
  assert.match(text, /Total elapsed \(wall-clock, incl. browser launch\/close\): \d+ ms/);
  assert.doesNotMatch(text, /REPLACE_ME|DEMO_USER|DEMO_REGISTER/);
});

// Feeds missing, malformed, and mismatched input files to preflight.
// Each must fail before any browser launch, without echoing file contents in the error.
test("preflight rejects missing, malformed and mismatched input files without exposing their contents", async t => {
  const directory = await workspace(t);
  const script = resolve(directory, "test.xstore");
  const input = resolve(directory, "input.txt");
  const config = await loadConfiguration();
  const run = () => runScript({ script, config, dryRun: true, reportDir: directory });
  await writeFile(script, 'Open app at "/"\nLog in using "input.txt"');
  await assert.rejects(run(), /ENOENT/);
  await writeFile(input, '{"password": "private-do-not-echo"');
  await assert.rejects(run(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid JSON/);
    assert.doesNotMatch(error.message, /private-do-not-echo/);
    return true;
  });
  await writeFile(input, JSON.stringify({ username: "test", password: 123 }));
  await assert.rejects(run(), /non-empty string/);
  await writeFile(input, JSON.stringify({ username: "test" }));
  await assert.rejects(run(), /exactly username and password/);
  await writeFile(input, JSON.stringify({ username: "test", password: "secret", extra: "unexpected" }));
  await assert.rejects(run(), /exactly username and password/);
  await writeFile(script, 'Open app at "/"\nUse first-time configuration from "input.txt" if prompted');
  await writeFile(input, JSON.stringify({ unmapped: "store" }));
  await assert.rejects(run(), /no configuration field selector/);
  await writeFile(input, "{}");
  await assert.rejects(run(), /configuration file is empty/);
  await writeFile(script, 'Open app at "javascript:alert(1)"');
  await assert.rejects(run(), /HTTP/);
  await assert.rejects(readJson(input + ".missing"), /ENOENT/);
});

// Checks the three shell-smoke keywords parse, and the smoke script plus its default inputs validate.
// A dry run preflights smoke/shell-configuration.json (store, register, host, port) without a browser.
test("smoke script parses and its shell configuration passes preflight", async t => {
  const steps = parseScript(await readFile("smoke/xstore-is-running.xstore", "utf8"));
  assert.deepEqual(steps.map(step => step.action.kind), ["open", "shellConfigure", "dismissDeviceError", "expectLogin"]);
  const directory = await workspace(t);
  const result = await runScript({
    script: "smoke/xstore-is-running.xstore", config: await loadConfiguration("config/localhost-shell.json"),
    dryRun: true, reportDir: directory
  });
  assert.equal(result.report.status, "passed");
  assert.equal(JSON.parse(await readFile("smoke/shell-configuration.json", "utf8")).store, "721197");
});

// Rejects shell configuration files with missing/extra keys or an out-of-range port.
// Values are not echoed since only keys and the port rule appear in the error text.
test("shell configuration preflight rejects bad files", async t => {
  const directory = await workspace(t);
  const script = resolve(directory, "s.xstore");
  const input = resolve(directory, "shell.json");
  const config = await loadConfiguration();
  await writeFile(script, 'Open app at "/"\nUse Xstore shell configuration from "shell.json" if prompted');
  const run = () => runScript({ script, config, dryRun: true, reportDir: directory });
  await writeFile(input, JSON.stringify({ store: "1", register: "1", host: "localhost" }));
  await assert.rejects(run(), /exactly store, register, host, port/);
  await writeFile(input, JSON.stringify({ store: "1", register: "1", host: "localhost", port: "70000" }));
  await assert.rejects(run(), /port must be/);
  await writeFile(input, JSON.stringify({ store: "1", register: "1", host: "localhost", port: "8443" }));
  assert.equal((await run()).report.status, "passed");
});

// Checks the DIY cash-sale script parses to the expected actions and its sale-items file passes preflight.
// Also verifies the amount-due text from the Amount Due button/label is reduced to the typed amount.
test("DIY sale with cash script parses and preflights its sale items", async t => {
  const steps = parseScript(await readFile("diy-sale/diy-sale-with-cash.xstore", "utf8"));
  assert.deepEqual(steps.map(step => step.action.kind), [
    "open", "shellConfigure", "dismissDeviceError", "expectLogin", "xstoreLogin", "clickStartTransaction",
    "skipCustomerLookup", "scanItems", "clickAmountDue", "selectCash", "enterExactCash", "expectSaleComplete"
  ]);
  const directory = await workspace(t);
  const result = await runScript({
    script: "diy-sale/diy-sale-with-cash.xstore", config: await loadConfiguration("config/localhost-shell.json"),
    dryRun: true, reportDir: directory
  });
  assert.equal(result.report.status, "passed");
  assert.equal(exactCashAmount("Amount Due $513.17", { decimalSeparator: ".", groupSeparator: ",", currencySymbol: "$" }), "513.17");
});

// Rejects malformed sale-items files (shape, non-numeric IDs, non-positive quantities) before any browser work.
test("sale items preflight rejects bad files", async t => {
  const directory = await workspace(t);
  const script = resolve(directory, "s.xstore");
  const input = resolve(directory, "items.json");
  const config = await loadConfiguration();
  await writeFile(script, 'Open app at "/"\nScan sale items from "items.json"');
  const run = () => runScript({ script, config, dryRun: true, reportDir: directory });
  for (const [value, message] of [
    [{}, /non-empty "items" array/],
    [{ items: [] }, /non-empty "items" array/],
    [{ items: [{ saleId: "12" }] }, /exactly saleId and quantity/],
    [{ items: [{ saleId: "abc", quantity: 1 }] }, /saleId must be a string of digits/],
    [{ items: [{ saleId: "123", quantity: 0 }] }, /quantity must be a positive integer/]
  ] as const) {
    await writeFile(input, JSON.stringify(value));
    await assert.rejects(run(), message);
  }
  await writeFile(input, JSON.stringify({ items: [{ saleId: "650427503", quantity: 1 }] }));
  assert.equal((await run()).report.status, "passed");
});

// Checks the "if shown" suffix makes the login-screen wait and login steps optional, and only those.
test("login steps accept an optional 'if shown' suffix", () => {
  const steps = parseScript('Open app at "/"\nWait for the Xstore login screen if shown\nLog in at the Xstore login screen using "l.json" if shown\nWait for the Xstore login screen');
  assert.deepEqual(steps.slice(1).map(step => step.action), [
    { kind: "expectLogin", optional: true }, { kind: "xstoreLogin", file: "l.json", optional: true }, { kind: "expectLogin" }
  ]);
});
