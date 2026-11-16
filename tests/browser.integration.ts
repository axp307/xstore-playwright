import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { loadConfiguration } from "../src/config.js";
import { runScript } from "../src/runner.js";
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
