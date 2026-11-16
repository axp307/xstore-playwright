import { expect } from "playwright/test";
import type { Page } from "playwright";
import type { Configuration } from "./config.js";
import { httpUrl } from "./config.js";
import type { Action } from "./parser.js";

// Converts displayed amount-due text into the string typed into the cash field.
// Works on strings only (no floats) and rejects labels, negatives or ambiguous formats.
export function exactCashAmount(text: string, format: Configuration["amountFormat"]): string {
  let value = text.trim();
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

// Drives the shell app's Location Details and Connection Details forms, then launches Xstore.
// Throws unless Test Connection shows a Success dialog, so a bad host/port never reaches Launch.
export async function completeShellSetup(
  page: Page, config: Configuration, values: Record<string, string>
): Promise<void> {
  const s = config.selectors;
  await page.locator(s.shellLocationDetails).click();
  await page.locator(s.shellStore).fill(values.store!);
  await page.locator(s.shellRegister).fill(values.register!);
  await page.locator(s.shellSave).click();
  await page.locator(s.shellConnectionDetails).click();
  await page.locator(s.shellHost).fill(values.host!);
  await page.locator(s.shellPort).fill(values.port!);
  await page.locator(s.shellTestConnection).click();
  const dialog = page.locator(s.shellDialog).first();
  await dialog.waitFor({ state: "visible" });
  if (!await page.locator(s.shellConnectionSuccess).isVisible()) {
    const message = (await dialog.innerText()).replace(/\s+/g, " ").trim();
    throw new Error(`Test Connection did not succeed: ${message}`);
  }
  await page.locator(s.shellDialogOk).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(s.shellSave).click();
  await page.locator(s.shellLaunch).click();
}

// Performs one parsed step in the browser using the configured selectors.
// Returns "skipped" only for the conditional setup step; any failure is thrown to the runner.
export async function executeAction(
  page: Page, action: Action, config: Configuration, data?: Record<string, string>
): Promise<"passed" | "skipped"> {
  const s = config.selectors;
  const field = (selector: string) => page.locator(selector);
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
        .filter({ visible: true }).first().waitFor();
      if (!await field(s.shellConfigScreen).isVisible()) return "skipped";
      await completeShellSetup(page, config, data!);
      break;
    }
    case "dismissDeviceError": {
      await field(s.deviceErrorDialog).or(field(s.loginReady)).filter({ visible: true }).first().waitFor();
      if (!await field(s.deviceErrorDialog).isVisible()) return "skipped";
      await field(s.deviceErrorOk).click();
      await field(s.deviceErrorDialog).waitFor({ state: "hidden" });
      break;
    }
    case "expectLogin":
      await field(s.loginReady).waitFor({ state: "visible" });
      await expect(field(s.deviceErrorDialog), "device error dialog still blocking").toHaveCount(0);
      break;
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
