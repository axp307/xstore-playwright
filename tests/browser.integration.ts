import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { loadConfiguration } from "../src/config.js";
import { runScript, saveFailureScreenshot } from "../src/runner.js";
import { workspace } from "./helpers.js";

const headless = process.env.HEADED !== "1";
const slowMo = headless ? 0 : 100;

interface MockState {
  configuration: Record<string, string> | undefined;
  username: string | undefined;
  products: string[];
  tender: string | undefined;
  completed: boolean;
}

// Starts a local HTTP server serving a fake POS page plus a /record endpoint.
// Options inject failures (rejected product, bad login, HTTP 503) and capture what the runner submitted.
async function mock(options: { setup: boolean; rejectProduct?: boolean; failLogin?: boolean; httpError?: boolean }) {
  const state: MockState = {
    configuration: undefined, username: undefined, products: [], tender: undefined, completed: false
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/record" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      Object.assign(state, JSON.parse(body));
      response.end("ok");
      return;
    }
    response.writeHead(options.httpError ? 503 : 200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html><body><main></main><script>
      const main = document.querySelector("main");
      const products = [];
      // Posts observed UI input back to the test server so assertions can inspect it.
      // Keeps the mock stateless in the page while the server holds the evidence.
      async function record(value) {
        await fetch("/record", { method: "POST", body: JSON.stringify(value) });
      }
      // Appends a labelled button wired to a handler, standing in for POS screen controls.
      // Labels match the default selectors (e.g. has-text("Log In")).
      function button(text, handler) {
        const element = document.createElement("button");
        element.textContent = text;
        element.onclick = handler;
        main.append(element);
      }
      // Renders the login screen and, on valid demo credentials, advances to Start Transaction -> Sale -> DIY.
      // Credentials are checked in-page so the runner's external-file input is really exercised.
      function login() {
        main.innerHTML = '<input name="username"><input name="password" type="password">';
        button("Log In", async () => {
          const username = document.querySelector('[name="username"]').value;
          const password = document.querySelector('[name="password"]').value;
          if (${Boolean(options.failLogin)} || username !== "DEMO_USER" || password !== "REPLACE_ME") return;
          await record({ username });
          main.innerHTML = "";
          button("Start Transaction", () => {
            main.innerHTML = "";
            button("Sale", () => {
              main.innerHTML = "";
              button("DIY Customer", cart);
            });
          });
        });
      }
      // Renders the first-time configuration screen and records the submitted store/register.
      // Proceeds to login after saving, mimicking the conditional setup flow.
      function setup() {
        main.innerHTML = '<section data-testid="first-time-configuration"><input name="storeId"><input name="registerId"></section>';
        button("Save Configuration", async () => {
          await record({ configuration: {
            storeId: document.querySelector('[name="storeId"]').value,
            registerId: document.querySelector('[name="registerId"]').value
          }});
          login();
        });
      }
      // Renders the sale screen: add products, check out, and tender cash against a fixed $1,234.56 due.
      // Only an exact tender completes the transaction, so wrong amounts are detectable.
      function cart() {
        main.innerHTML = '<input name="productId"><div id="items"></div>';
        button("Add Product", async () => {
          if (${Boolean(options.rejectProduct)}) return;
          products.push(document.querySelector('[name="productId"]').value);
          await record({ products });
          const line = document.createElement("div");
          line.dataset.testid = "cart-item";
          line.textContent = products[products.length - 1];
          document.querySelector("#items").append(line);
          document.querySelector('[name="productId"]').value = "";
        });
        button("Checkout", () => {
          main.innerHTML = "";
          button("Cash", () => {
            main.innerHTML = '<div data-testid="amount-due">$1,234.56</div><input name="cashAmount">';
            button("Complete Transaction", async () => {
              const tender = document.querySelector('[name="cashAmount"]').value;
              await record({ tender });
              if (tender !== "1234.56") return;
              await record({ completed: true });
              main.innerHTML = '<div data-testid="transaction-complete">Sale complete</div>';
            });
          });
        });
      }
      setTimeout(${options.setup ? "setup" : "login"}, 80);
    </script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    state, url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}

// Runs the full sample against the mock twice, with and without the first-time setup screen.
// Asserts step statuses, exact submitted data, and that the persisted report matches.
for (const setup of [true, false]) {
  test(`real Chromium completes a cash sale with setup ${setup ? "present" : "absent"}`, async t => {
    const directory = await workspace(t);
    const app = await mock({ setup });
    t.after(app.close);
    const config = await loadConfiguration(undefined, app.url);
    config.timeoutMs = 3000;
    const result = await runScript({
      script: "examples/cash-sale.xstore", config, headless, slowMo, reportDir: directory
    });
    assert.equal(result.report.status, "passed", JSON.stringify(result.report));
    assert.equal(result.report.steps[1]!.status, setup ? "passed" : "skipped");
    assert.ok(result.report.steps.every(step => ["passed", "skipped"].includes(step.status)));
    assert.equal(app.state.username, "DEMO_USER");
    assert.deepEqual(app.state.products, ["650921315", "651234940"]);
    assert.equal(app.state.tender, "1234.56");
    assert.equal(app.state.completed, true);
    assert.deepEqual(app.state.configuration, setup
      ? { storeId: "DEMO_STORE", registerId: "DEMO_REGISTER" } : undefined);
    assert.ok(result.report.durationMs >= result.report.steps.reduce((total, step) => total + step.durationMs, 0) - 7);
    const persisted = JSON.parse(await readFile(result.jsonPath, "utf8"));
    assert.deepEqual(persisted, result.report);
  });
}

// Makes the mock ignore product adds to prove the scan step fails on the cart-count check.
// Later steps must be not-run and no tender may be sent.
test("a rejected product fails the scan step and never tenders the transaction", async t => {
  const directory = await workspace(t);
  const app = await mock({ setup: false, rejectProduct: true });
  t.after(app.close);
  const config = await loadConfiguration(undefined, app.url);
  config.timeoutMs = 500;
  const { report, textPath } = await runScript({
    script: "examples/cash-sale.xstore", config, headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.equal(report.steps[5]!.status, "failed");
  assert.equal(report.steps[6]!.status, "not-run");
  assert.ok(report.steps[5]!.durationMs > 0);
  assert.match(report.steps[5]!.error!, /toHaveCount/);
  assert.equal(app.state.completed, false);
  assert.equal(app.state.tender, undefined);
  assert.match(await readFile(textPath, "utf8"), /\[not-run\]/);
});

// Forces a login-step failure whose Playwright error text contains the secret password.
// Verifies the persisted JSON and text reports redact it.
test("a login failure redacts external credentials from the persisted error", async t => {
  const directory = await workspace(t);
  const app = await mock({ setup: false });
  t.after(app.close);
  const config = await loadConfiguration(undefined, app.url);
  config.timeoutMs = 500;
  // The unmatched selector makes Playwright include the secret in its call log.
  config.selectors.loginSubmit = 'button:has-text("REPLACE_ME")';
  const { report, jsonPath, textPath } = await runScript({
    script: "examples/cash-sale.xstore", config, headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.equal(report.steps[2]!.status, "failed");
  assert.ok(report.steps.slice(3).every(step => step.status === "not-run"));
  assert.match(report.steps[2]!.error!, /\[REDACTED\]/);
  for (const file of [jsonPath, textPath]) {
    assert.doesNotMatch(await readFile(file, "utf8"), /REPLACE_ME|DEMO_USER/);
  }
});

// Serves HTTP 503 so the first navigation step fails.
// Checks the failure is reported with its status and all remaining steps are not-run.
test("HTTP errors fail navigation, produce a report, and stop subsequent steps", async t => {
  const directory = await workspace(t);
  const app = await mock({ setup: false, httpError: true });
  t.after(app.close);
  const { report } = await runScript({
    script: "examples/cash-sale.xstore", config: await loadConfiguration(undefined, app.url),
    headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.equal(report.steps[0]!.status, "failed");
  assert.match(report.steps[0]!.error!, /HTTP 503/);
  assert.ok(report.steps.slice(1).every(step => step.status === "not-run"));
});

test("stepDelayMs pauses after passed steps only and is counted in step durations", async t => {
  const directory = await workspace(t);
  const app = await shellMock({});
  t.after(app.close);
  const config = { ...(await loadConfiguration("config/localhost-shell.json", app.url)), stepDelayMs: 400 };
  const { report, textPath } = await runScript({
    script: "smoke/xstore-is-running.xstore", config, headless, slowMo: 0, reportDir: directory
  });
  assert.equal(report.status, "passed");
  for (const step of report.steps) {
    assert.equal(step.durationMs, step.executionMs + step.observationDelayMs);
    if (step.status === "passed") assert.ok(step.observationDelayMs >= 390 && step.executionMs < 400, `${step.step}: ${step.durationMs} ms`);
    else assert.equal(step.observationDelayMs, 0);
  }
  assert.equal(report.stepObservationDelayMs, report.steps.reduce((sum, step) => sum + step.observationDelayMs, 0));
  assert.ok(report.durationMs >= report.stepExecutionMs + report.stepObservationDelayMs - 3);
  assert.match(await readFile(textPath, "utf8"), /execution \d+ ms \+ observation delay \d+ ms/);
});

// Starts a local HTTP server imitating the Xstore shell app: two setup forms, a Test Connection dialog,
// Launch, an optional hardware-error dialog, then a login screen. Markup mirrors the selectors found live.
async function shellMock(options: { failConnection?: string; deviceError?: boolean; retainDialog?: boolean; noLogin?: boolean }) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html><body><div id="root"></div><script>
      const root = document.getElementById("root");
      const saved = {};
      function button(text, handler) {
        const element = document.createElement("button");
        element.textContent = text;
        element.onclick = handler;
        return element;
      }
      function field(id) { const e = document.createElement("input"); e.id = id; return e; }
      function dialog(html, ok) {
        const d = document.createElement("oj-dialog");
        d.innerHTML = html;
        d.append(button("OK", () => { ${options.retainDialog ? "d.hidden = true" : "d.remove()"}; ok && ok(); }));
        document.body.append(d);
      }
      function main() {
        root.innerHTML = '<div id="configMain"><p>Xstore Configuration</p></div>';
        const area = root.firstChild;
        area.append(button("Location Details", locationForm), button("Connection Details", connection),
          button("Launch Xstore", launch));
      }
      function locationForm() {
        root.innerHTML = "";
        root.append(field("storeNumber|input"), field("registerNumber|input"), button("Back", main),
          button("Save", () => { saved.store = document.getElementById("storeNumber|input").value;
            saved.register = document.getElementById("registerNumber|input").value; main(); }));
      }
      function connection() {
        root.innerHTML = "";
        root.append(field("serverHost|input"), field("serverPort|input"), button("Back", main),
          button("Test Connection", () => dialog(${JSON.stringify(options.failConnection
            ? `<h2>Connection Test</h2><p>${options.failConnection}</p>` : "<h2>Connection Test</h2><p>Success</p>")})),
          button("Save", () => { saved.host = document.getElementById("serverHost|input").value;
            saved.port = document.getElementById("serverPort|input").value; main(); }));
      }
      function login() {
        root.innerHTML = ${JSON.stringify(options.noLogin ? "<p>Loading</p>"
          : '<div id="focusBarInfoArea"><h1>Log In</h1><div id="focusBarInputField"><input type="text"></div></div>')};
        document.title = JSON.stringify(saved);
      }
      function launch() {
        if (!saved.store || !saved.host) return;
        ${options.deviceError ? 'dialog("<h2>Hardware Error</h2><p>scanner</p>", login)' : "login()"};
      }
      main();
    </script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}

// Runs the smoke script against the shell mock with and without a hardware-error dialog.
// Both must end at the login screen, with the dialog step reported as passed or skipped respectively.
for (const options of [{ deviceError: false }, { deviceError: true }, { deviceError: true, retainDialog: true }]) {
  const { deviceError, retainDialog } = options;
  test(`smoke script reaches login with device error ${deviceError}, retained dialog ${Boolean(retainDialog)}`, async t => {
    const directory = await workspace(t);
    const app = await shellMock(options);
    t.after(app.close);
    const config = await loadConfiguration(undefined, app.url);
    config.timeoutMs = 3000;
    const { report } = await runScript({
      script: "smoke/xstore-is-running.xstore", config, headless, slowMo, reportDir: directory
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(report.steps.map(step => step.status), [
      "passed", "passed", deviceError ? "passed" : "skipped", "passed"
    ]);
  });
}

// A failed Test Connection dialog must fail the setup step and never press Launch.
// Later steps stay not-run, and the report keeps the dialog text and a failure screenshot.
for (const failConnection of ["Failed to connect", "Unsuccessful", "Not Success"]) {
  test(`connection result "${failConnection}" fails the run before Launch`, async t => {
    const directory = await workspace(t);
    const app = await shellMock({ failConnection });
    t.after(app.close);
    const config = await loadConfiguration(undefined, app.url);
    config.timeoutMs = 3000;
    const { report, textPath } = await runScript({
      script: "smoke/xstore-is-running.xstore", config, headless, slowMo, reportDir: directory
    });
    assert.equal(report.status, "failed");
    assert.equal(report.steps[1]!.status, "failed");
    assert.ok(report.steps[1]!.error!.includes(`Test Connection did not succeed: Connection Test ${failConnection}`));
    assert.ok(report.steps.slice(2).every(step => step.status === "not-run"));
    assert.ok(report.steps[1]!.screenshot);
    assert.match(await readFile(textPath, "utf8"), /Screenshot:/);
  });
}

// Compares saved evidence with an explicitly masked reference image on a page containing private fields.
// Verifies credentials, custom configuration controls and editable inputs are masked and PNGs stay owner-only.
test("failure screenshots mask sensitive inputs and have private file permissions", async t => {
  const directory = await workspace(t);
  const browser = await chromium.launch({ headless });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<input name="username" value="private-user"><input name="password" value="private-password">
    <textarea>private-notes</textarea><div id="custom-config">private-config</div>
    <div contenteditable>private-editable</div><input id="serverHost|input" value="private-host">`);
  const config = await loadConfiguration();
  config.configurationFields = { custom: "#custom-config" };
  const expected = await page.screenshot({
    mask: [page.locator('input, textarea, [contenteditable], #custom-config')]
  });
  const file = resolve(directory, "failure.png");
  await saveFailureScreenshot(page, config, file);
  assert.deepEqual(await readFile(file), expected);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

// An app that never shows the login form must fail the final step rather than pass by default.
// Guards the "ends successfully only when the login screen is visibly ready" requirement.
test("a missing login screen fails the smoke test", async t => {
  const directory = await workspace(t);
  const app = await shellMock({ noLogin: true });
  t.after(app.close);
  const config = await loadConfiguration(undefined, app.url);
  config.timeoutMs = 800;
  const { report } = await runScript({
    script: "smoke/xstore-is-running.xstore", config, headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.equal(report.steps[2]!.status, "failed");
});

// An unreachable server must produce a failed report whose first step records the network error.
// Uses a closed local port so no real service is contacted.
test("an unreachable app fails the first step with a saved report", async t => {
  const directory = await workspace(t);
  const app = await shellMock({});
  const url = app.url;
  await app.close();
  const config = await loadConfiguration(undefined, url);
  config.timeoutMs = 2000;
  const { report, jsonPath } = await runScript({
    script: "smoke/xstore-is-running.xstore", config, headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.match(report.steps[0]!.error!, /ERR_CONNECTION_REFUSED/);
  assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).status, "failed");
});

interface DiyState {
  username: string | undefined;
  password: string | undefined;
  scans: string[];
  tender: string | undefined;
  completed: boolean;
}

// Fake Xstore using the verified DIY-sale DOM shapes: focus-bar login + password dialog, Main Menu,
// Customer Lookup, cart lines, Payment Options, and a read-only keyboard-driven tender field.
// `entry` picks the starting screen; the amount due is fixed at $1,234.56 and only an exact tender completes.
async function diyMock(options: { entry: "login" | "mainMenu" | "customerLookup"; rejectScan?: boolean }) {
  const state: DiyState = { username: undefined, password: undefined, scans: [], tender: undefined, completed: false };
  const server = createServer(async (request, response) => {
    if (request.url === "/record" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      Object.assign(state, JSON.parse(body));
      response.end("ok");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html><body><main></main><script>
      const main = document.querySelector("main");
      const scans = [];
      let username = "";
      async function record(value) {
        await fetch("/record", { method: "POST", body: JSON.stringify(value) });
      }
      function button(text, handler) {
        const element = document.createElement("button");
        element.textContent = text;
        element.onclick = handler;
        main.append(element);
      }
      function login() {
        main.innerHTML = '<div id="focusBarInfoArea"><div>Log In</div><div id="focusBarInputField"><input></div></div>';
        main.querySelector("input").onkeydown = event => {
          if (event.key !== "Enter") return;
          username = event.target.value;
          main.insertAdjacentHTML("beforeend", '<div id="LOGIN_USER_PWD"><input type="password"></div>');
          document.querySelector("#LOGIN_USER_PWD input").onkeydown = async keyEvent => {
            if (keyEvent.key !== "Enter") return;
            await record({ username, password: keyEvent.target.value });
            mainMenu();
          };
        };
      }
      function mainMenu() {
        main.innerHTML = '<div class="card">Start Transaction</div>';
        button("Log Out", login);
        main.querySelector(".card").onclick = customerLookup;
      }
      function customerLookup() {
        main.innerHTML = "";
        button("Skip", cart);
      }
      function cart() {
        main.innerHTML = '<div id="focusBarInputField"><input></div><div class="xstore-sale-list-sizing"></div>';
        main.querySelector("input").onkeydown = async event => {
          if (event.key !== "Enter" || ${Boolean(options.rejectScan)}) return;
          scans.push(event.target.value);
          await record({ scans });
          const line = document.createElement("div");
          line.id = "listItem sli_1_" + scans.length;
          main.querySelector(".xstore-sale-list-sizing").append(line);
          event.target.value = "";
        };
        main.insertAdjacentHTML("beforeend", '<oj-button title="Amount Due $1,234.56"><button>Amount Due $1,234.56</button></oj-button>');
        main.querySelector("oj-button button").onclick = payment;
      }
      function payment() {
        main.innerHTML = '<div class="oj-typography-subheading-lg">Amount Due $1,234.56</div>'
          + '<div class="xstore-tender-card-sizing"><div>Cash</div></div>';
        main.querySelector(".xstore-tender-card-sizing").onclick = tender;
      }
      // The field is read-only, so digits only arrive through document key events (like the real keypad).
      function tender() {
        main.insertAdjacentHTML("beforeend", '<div id="ENTER_TENDER_AMOUNT"><input readonly></div>');
        const input = document.querySelector("#ENTER_TENDER_AMOUNT input");
        document.onkeydown = async event => {
          if (/^[0-9.]$/.test(event.key)) input.value += event.key;
          if (event.key !== "Enter") return;
          await record({ tender: input.value });
          if (input.value !== "1234.56") return;
          await record({ completed: true });
          document.onkeydown = null;
          customerLookup();
        };
      }
      ({ login, mainMenu, customerLookup })["${options.entry}"]();
    </script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    state, url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}

// Writes the DIY script and its inputs into a temp directory, mirroring diy-sale/diy-sale-with-cash.xstore.
async function diyScript(directory: string): Promise<string> {
  const script = resolve(directory, "diy.xstore");
  await writeFile(script, [
    'Open app at "/"',
    "Dismiss the device error prompt if shown",
    "Wait for the Xstore login screen if shown",
    'Log in at the Xstore login screen using "login.json" if shown',
    'Click on "Start Transaction"',
    "Skip customer lookup",
    'Scan sale items from "items.json"',
    'Click on "Amount Due"',
    'Note the amount due and click on "Cash"',
    "Enter the exact amount due and press Enter",
    "Wait for the Customer Lookup or Main Menu screen"
  ].join("\n"));
  await writeFile(resolve(directory, "login.json"), JSON.stringify({ username: "100", password: "1" }));
  await writeFile(resolve(directory, "items.json"), JSON.stringify({ items: [
    { saleId: "650427503", quantity: 1 }, { saleId: "651234940", quantity: 1 }
  ] }));
  return script;
}

// Runs the DIY sale from each entry state: login screen, Main Menu and Customer Lookup (already signed in).
// The optional login steps run only when a login form is shown; every entry state submits the exact noted amount.
for (const entry of ["login", "mainMenu", "customerLookup"] as const) {
  test(`DIY sale with cash completes from the ${entry} entry state`, async t => {
    const directory = await workspace(t);
    const app = await diyMock({ entry });
    t.after(app.close);
    const config = await loadConfiguration(undefined, app.url);
    config.timeoutMs = 3000;
    const { report } = await runScript({
      script: await diyScript(directory), config, headless, slowMo, reportDir: directory
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    const statuses = report.steps.map(step => step.status);
    assert.deepEqual(statuses.slice(2, 5), [
      entry === "login" ? "passed" : "skipped",
      entry === "login" ? "passed" : "skipped",
      entry === "customerLookup" ? "skipped" : "passed"
    ]);
    assert.ok(statuses.slice(5).every(status => status === "passed"));
    assert.deepEqual(app.state.scans, ["650427503", "651234940"]);
    assert.equal(app.state.tender, "1234.56");
    assert.equal(app.state.completed, true);
    if (entry === "login") {
      assert.equal(app.state.username, "100");
      assert.equal(app.state.password, "1");
    } else {
      assert.equal(app.state.username, undefined);
    }
  });
}

// A rejected scan must fail the scan step and stop the run before Amount Due, Cash or any tender.
test("a rejected DIY scan fails the scan step and never tenders", async t => {
  const directory = await workspace(t);
  const app = await diyMock({ entry: "customerLookup", rejectScan: true });
  t.after(app.close);
  const config = await loadConfiguration(undefined, app.url);
  config.timeoutMs = 500;
  const { report } = await runScript({
    script: await diyScript(directory), config, headless, slowMo, reportDir: directory
  });
  assert.equal(report.status, "failed");
  assert.equal(report.steps[6]!.status, "failed");
  assert.match(report.steps[6]!.error!, /650427503 was not added to the cart/);
  assert.ok(report.steps.slice(7).every(step => step.status === "not-run"));
  assert.equal(app.state.tender, undefined);
  assert.equal(app.state.completed, false);
});
