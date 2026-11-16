import { expect } from "playwright/test";
import type { Page } from "playwright";
import type { Configuration } from "./config.js";
import { httpUrl } from "./config.js";
import type { Action } from "./parser.js";

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
