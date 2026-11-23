import { expect } from "playwright/test";
import type { Locator, Page } from "playwright";
import { performance } from "node:perf_hooks";
import type { Configuration } from "./config.js";
import { httpUrl } from "./config.js";
import type { SaleItem } from "./config.js";
import type { Action } from "./parser.js";

// Converts displayed amount-due text into the string typed into the cash field.
// Works on strings only (no floats) and rejects labels, negatives or ambiguous formats.
export function exactCashAmount(text: string, format: Configuration["amountFormat"]): string {
  let value = text.trim().replace(/^Amount Due\s*/i, "");
  if (format.currencySymbol && value.startsWith(format.currencySymbol)) {
    value = value.slice(format.currencySymbol.length).trim();
  } else if (format.currencySymbol && value.endsWith(format.currencySymbol)) {
    value = value.slice(0, -format.currencySymbol.length).trim();
  }
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const integer = format.groupSeparator
    ? `(?:[0-9]+|[0-9]{1,3}(?:${escape(format.groupSeparator)}[0-9]{3})+)`
    : "[0-9]+";
  const match = value.match(new RegExp(`^(${integer})(?:${escape(format.decimalSeparator)}([0-9]{1,2}))?$`));
  if (!match) throw new Error("Amount due is not a supported non-negative currency amount. Adjust amountDue/amountFormat.");
  const whole = match[1]!.split(format.groupSeparator || "\0").join("").replace(/^0+(?=\d)/, "");
  return `${whole}${format.decimalSeparator}${(match[2] ?? "").padEnd(2, "0")}`;
}

export interface SaleLineSnapshot { id: string; text: string; quantity?: number | undefined }

// Decides whether a scan of `saleId` has been acknowledged by the cart. A line with a new DOM id counts.
// Otherwise the same line (matched by id, so reordering is ignored) must show the sale ID as a whole token
// (123 never matches 91234 or $123.00) and have changed, with a higher quantity when quantities are readable.
export function scanCompleted(before: SaleLineSnapshot[], after: SaleLineSnapshot[], saleId: string): boolean {
  const known = new Map(before.map(line => [line.id, line]));
  if (after.some(line => !known.has(line.id))) return true;
  const escaped = saleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?<![\\w.,$-])${escaped}(?!\\w|[.,]\\d)`);
  return after.some(now => {
    const old = known.get(now.id);
    if (!old || !token.test(now.text)) return false;
    if (old.quantity !== undefined && now.quantity !== undefined) return now.quantity > old.quantity;
    return now.text !== old.text;
  });
}

// Picks a delay uniformly within +/-25% of humanDelayMs; `random` is injectable for tests.
export function jitteredDelay(humanDelayMs: number, random: () => number = Math.random): number {
  return Math.round(humanDelayMs * (0.75 + random() * 0.5));
}

// Waits the configured "human delay" (with +/-25% jitter) before an action, simulating a person's reaction time.
// The measured pause is accumulated per page so the runner can report it separately from action time.
const humanDelayElapsed = new WeakMap<Page, number>();

async function humanPause(page: Page, config: Configuration): Promise<void> {
  if (config.humanDelayMs <= 0) return;
  const started = performance.now();
  await page.waitForTimeout(jitteredDelay(config.humanDelayMs));
  humanDelayElapsed.set(page, (humanDelayElapsed.get(page) ?? 0) + performance.now() - started);
}

// Returns the human delay (seconds, 3 decimals) accumulated since the last call and resets it.
export function takeHumanDelaySec(page: Page): number {
  const elapsed = humanDelayElapsed.get(page) ?? 0;
  humanDelayElapsed.delete(page);
  return Math.round(elapsed) / 1000;
}

// Wraps a locator so click/fill/press are each preceded by the human delay.
// Chained locators (or/filter/first) stay plain: they are only used for waiting and visibility checks.
function humanize(page: Page, config: Configuration, locator: Locator): Locator {
  const paced = new Set<string | symbol>(["click", "fill", "press"]);
  return new Proxy(locator, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (!paced.has(prop) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await humanPause(page, config);
        return value.apply(target, args);
      };
    }
  });
}

// Remembers the amount due noted at the Cash step so the tender step types exactly that value.
const notedAmountDue = new WeakMap<Page, string>();

// Drives the shell app's Location Details and Connection Details forms, then launches Xstore.
// Throws unless Test Connection shows a Success dialog, so a bad host/port never reaches Launch.
export async function completeShellSetup(
  page: Page, config: Configuration, values: Record<string, string>
): Promise<void> {
  const s = config.selectors;
  const loc = (selector: string) => humanize(page, config, page.locator(selector));
  await loc(s.shellLocationDetails).click();
  await loc(s.shellStore).fill(values.store!);
  await loc(s.shellRegister).fill(values.register!);
  await loc(s.shellSave).click();
  await loc(s.shellConnectionDetails).click();
  await loc(s.shellHost).fill(values.host!);
  await loc(s.shellPort).fill(values.port!);
  await loc(s.shellTestConnection).click();
  const dialog = page.locator(s.shellDialog).first();
  await dialog.waitFor({ state: "visible" });
  if (!await page.locator(s.shellConnectionSuccess).isVisible()) {
    const message = (await dialog.innerText()).replace(/\s+/g, " ").trim();
    throw new Error(`Test Connection did not succeed: ${message}`);
  }
  await loc(s.shellDialogOk).click();
  await dialog.waitFor({ state: "hidden" });
  await loc(s.shellSave).click();
  await loc(s.shellLaunch).click();
}

// Performs one parsed step in the browser using the configured selectors.
// DEVELOPER NOTE: the login (not xstoreLogin), startTransaction, startSale, addProducts and cashCheckout cases rely
// on GUESSED selectors (see defaultSelectors in config.ts). Their button labels, field names and
// cart/amount/completion markers are placeholders; verify them against a live Xstore before
// trusting a failure or a pass from those steps.
// Returns "skipped" only for the conditional setup step; any failure is thrown to the runner.
export async function executeAction(
  page: Page, action: Action, config: Configuration, data?: Record<string, string>, items?: SaleItem[],
  onScanTime?: (saleId: string, seconds: number) => void
): Promise<"passed" | "skipped"> {
  const s = config.selectors;
  const field = (selector: string) => humanize(page, config, page.locator(selector));
  switch (action.kind) {
    case "open": {
      const response = await page.goto(httpUrl(action.target, config.baseUrl), { waitUntil: "domcontentloaded" });
      if (response && !response.ok()) throw new Error(`App navigation returned HTTP ${response.status()}.`);
      break;
    }
    case "configure": {
      // Wait for a known screen, not a fixed delay or an early isVisible check.
      await field(s.configurationScreen).or(field(s.username)).or(field(s.startTransaction))
        .filter({ visible: true }).first().waitFor();
      if (!await field(s.configurationScreen).isVisible()) return "skipped";
      for (const [key, value] of Object.entries(data!)) {
        await field(config.configurationFields[key]!).fill(value);
      }
      await field(s.configurationSubmit).click();
      await field(s.username).or(field(s.startTransaction)).filter({ visible: true }).first().waitFor();
      break;
    }
    case "shellConfigure": {
      // Conditional: only the shell setup screen triggers the two-form configuration and launch.
      await field(s.shellConfigScreen).or(field(s.deviceErrorDialog)).or(field(s.loginReady))
        .or(field(s.mainMenuLogOut)).or(field(s.customerLookupSkip))
        .filter({ visible: true }).first().waitFor();
      if (!await field(s.shellConfigScreen).isVisible()) return "skipped";
      await completeShellSetup(page, config, data!);
      break;
    }
    case "dismissDeviceError": {
      // A signed-in Xstore (Main Menu or Customer Lookup) has no dialog to dismiss; the strict login wait is separate.
      await field(s.deviceErrorDialog).or(field(s.loginReady)).or(field(s.mainMenuLogOut)).or(field(s.customerLookupSkip))
        .filter({ visible: true }).first().waitFor();
      if (!await field(s.deviceErrorDialog).isVisible()) return "skipped";
      await field(s.deviceErrorOk).click();
      await field(s.deviceErrorDialog).waitFor({ state: "hidden" });
      break;
    }
    case "expectLogin":
      if (action.optional) {
        // Already signed in (Main Menu or Customer Lookup): there is no login form to wait for.
        await field(s.loginReady).or(field(s.mainMenuLogOut)).or(field(s.customerLookupSkip))
          .filter({ visible: true }).first().waitFor();
        if (!await field(s.loginReady).isVisible()) return "skipped";
      }
      await field(s.loginReady).waitFor({ state: "visible" });
      await expect(field(s.deviceErrorDialog), "device error dialog still blocking")
        .toBeHidden({ timeout: config.timeoutMs });
      break;
    case "xstoreLogin": {
      if (action.optional) {
        await field(s.loginReady).or(field(s.mainMenuLogOut)).or(field(s.customerLookupSkip))
          .filter({ visible: true }).first().waitFor();
        if (!await field(s.loginReady).isVisible()) return "skipped";
      }
      // Xstore shows Start Transaction before sign-on, so the cashier must be logged in first.
      await field(s.loginReady).fill(data!.username!);
      await field(s.loginReady).press("Enter");
      const password = field(s.loginPasswordInput);
      await password.waitFor({ state: "visible" });
      await password.fill(data!.password!);
      await password.press("Enter");
      await field(s.mainMenuLogOut).waitFor({ state: "visible" });
      break;
    }
    case "login":
      await field(s.username).fill(data!.username!);
      await field(s.password).fill(data!.password!);
      await field(s.loginSubmit).click();
      await field(s.startTransaction).waitFor();
      break;
    case "startTransaction":
      await field(s.startTransaction).click();
      break;
    case "startSale":
      await field(s.startSale).click();
      await field(s.diyCustomer).click();
      break;
    case "addProducts":
      for (const product of action.products) {
        const before = await field(s.cartItems).count();
        await field(s.productId).fill(product);
        await field(s.addProduct).click();
        // Verify each scan has actually added an item before sending the next.
        await expect(field(s.cartItems)).toHaveCount(before + 1, { timeout: config.timeoutMs });
      }
      break;
    case "clickStartTransaction":
      // A signed-in instance can already be on Customer Lookup, where there is nothing to click.
      await field(s.startTransactionCard).or(field(s.customerLookupSkip)).filter({ visible: true }).first().waitFor();
      if (await field(s.customerLookupSkip).isVisible()) return "skipped";
      await field(s.startTransactionCard).click();
      await field(s.customerLookupSkip).waitFor({ state: "visible" });
      break;
    case "skipCustomerLookup":
      await field(s.customerLookupSkip).click();
      await field(s.scanInput).waitFor({ state: "visible" });
      break;
    case "scanItems":
      for (const item of items!) {
        const lines = field(s.saleLines);
        const snapshot = async (): Promise<SaleLineSnapshot[]> => {
          const base = await lines.evaluateAll(elements => elements.map(element => ({ id: element.id, text: (element as HTMLElement).innerText })));
          // Quantity uses a Playwright locator so any selector engine works; absent or non-numeric means unknown.
          if (!s.saleLineQuantity) return base;
          return Promise.all(base.map(async (line, i) => {
            const cell = lines.nth(i).locator(s.saleLineQuantity).first();
            const raw = await cell.count() ? await cell.innerText() : "";
            return { ...line, quantity: /^\s*\d+\s*$/.test(raw) ? Number(raw) : undefined };
          }));
        };
        const before = await snapshot();
        await field(s.scanInput).fill(item.saleId);
        // Timing starts once the sale ID is entered and ends when the cart shows the result.
        // The human delay before Enter is taken first so it is not counted as scan time.
        await humanPause(page, config);
        const scanStarted = performance.now();
        await page.locator(s.scanInput).press("Enter");
        // A new item grows the cart; a repeated item raises the quantity of its own existing line instead.
        // scanCompleted ignores unrelated updates, so a pending or rejected scan is not mistaken for done.
        await expect(async () => {
          expect(scanCompleted(before, await snapshot(), item.saleId), `sale ID ${item.saleId} was not added to the cart`).toBe(true);
        }).toPass({ timeout: config.timeoutMs });
        if (action.recordScanTimes) onScanTime?.(item.saleId, (performance.now() - scanStarted) / 1000);
      }
      break;
    case "clickAmountDue":
      await field(s.amountDueButton).click();
      await field(s.cashTender).waitFor({ state: "visible" });
      break;
    case "selectCash": {
      const text = await field(s.paymentAmountDue).innerText();
      notedAmountDue.set(page, exactCashAmount(text, config.amountFormat));
      await field(s.cashTender).click();
      await field(s.tenderInput).waitFor({ state: "visible" });
      break;
    }
    case "enterExactCash": {
      const due = notedAmountDue.get(page);
      if (!due) throw new Error("No amount due was noted; run the Cash step first.");
      // The tender field is read-only (keypad-driven), so type through the keyboard.
      await humanPause(page, config);
      await page.keyboard.type(due, { delay: 50 });
      await expect(field(s.tenderInput), "tender field did not show the exact amount due")
        .toHaveValue(due, { timeout: config.timeoutMs });
      await humanPause(page, config);
      await page.keyboard.press("Enter");
      break;
    }
    case "expectSaleComplete":
      await field(s.tenderDialog).waitFor({ state: "hidden" });
      await field(s.customerLookupSkip).or(field(s.mainMenuLogOut)).filter({ visible: true }).first().waitFor();
      break;
    case "cashCheckout":
      await field(s.checkout).click();
      await field(s.cash).click();
      await field(s.amountDue).waitFor();
      const due = exactCashAmount(await field(s.amountDue).innerText(), config.amountFormat);
      await field(s.cashAmount).fill(due);
      await field(s.completeTransaction).click();
      await field(s.transactionComplete).waitFor();
      break;
  }
  return "passed";
}
