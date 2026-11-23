export type Action =
  | { kind: "open"; target: string }
  | { kind: "configure"; file: string }
  | { kind: "login"; file: string }
  | { kind: "shellConfigure"; file: string }
  | { kind: "dismissDeviceError" }
  | { kind: "expectLogin"; optional?: boolean }
  | { kind: "xstoreLogin"; file: string; optional?: boolean }
  | { kind: "startTransaction" }
  | { kind: "startSale" }
  | { kind: "addProducts"; products: string[] }
  | { kind: "cashCheckout" }
  | { kind: "clickStartTransaction" }
  | { kind: "skipCustomerLookup" }
  | { kind: "scanItems"; file: string }
  | { kind: "clickAmountDue" }
  | { kind: "selectCash" }
  | { kind: "enterExactCash" }
  | { kind: "expectSaleComplete" };

export interface Step {
  line: number;
  text: string;
  action: Action;
}

// Turns script text into typed steps by matching each line against the fixed keyword patterns.
// Rejects unknown lines (with line numbers) before any browser work, so typos fail fast.
export function parseScript(source: string): Step[] {
  const steps: Step[] = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const text = raw.trim().replace(/^\d+\.\s+/, "");
    if (!text || text.startsWith("#")) continue;
    let action: Action;
    let match: RegExpMatchArray | null;
    if ((match = text.match(/^Open app at "([^"]+)"$/i))) {
      action = { kind: "open", target: match[1]! };
    } else if ((match = text.match(/^Use first-time configuration from "([^"]+)" if prompted$/i))) {
      action = { kind: "configure", file: match[1]! };
    } else if ((match = text.match(/^Use Xstore shell configuration from "([^"]+)" if prompted$/i))) {
      action = { kind: "shellConfigure", file: match[1]! };
    } else if (/^Dismiss the device error prompt if shown$/i.test(text)) {
      action = { kind: "dismissDeviceError" };
    } else if ((match = text.match(/^Wait for the Xstore login screen( if shown)?$/i))) {
      action = match[1] ? { kind: "expectLogin", optional: true } : { kind: "expectLogin" };
    } else if ((match = text.match(/^Log in at the Xstore login screen using "([^"]+)"( if shown)?$/i))) {
      action = match[2] ? { kind: "xstoreLogin", file: match[1]!, optional: true } : { kind: "xstoreLogin", file: match[1]! };
    } else if ((match = text.match(/^Log in using "([^"]+)"$/i))) {
      action = { kind: "login", file: match[1]! };
    } else if (/^Go to Start Transaction$/i.test(text)) {
      action = { kind: "startTransaction" };
    } else if (/^Start a sale as a DIY Customer$/i.test(text)) {
      action = { kind: "startSale" };
    } else if ((match = text.match(/^Add products ([0-9]+(?:\s*,\s*[0-9]+)*)$/i))) {
      action = { kind: "addProducts", products: match[1]!.split(/\s*,\s*/) };
    } else if (/^Check out with cash using the exact amount due$/i.test(text)) {
      action = { kind: "cashCheckout" };
    } else if (/^Click on "Start Transaction"$/i.test(text)) {
      action = { kind: "clickStartTransaction" };
    } else if (/^Skip customer lookup$/i.test(text)) {
      action = { kind: "skipCustomerLookup" };
    } else if ((match = text.match(/^Scan sale items from "([^"]+)"$/i))) {
      action = { kind: "scanItems", file: match[1]! };
    } else if (/^Click on "Amount Due"$/i.test(text)) {
      action = { kind: "clickAmountDue" };
    } else if (/^Note the amount due and click on "Cash"$/i.test(text)) {
      action = { kind: "selectCash" };
    } else if (/^Enter the exact amount due and press Enter$/i.test(text)) {
      action = { kind: "enterExactCash" };
    } else if (/^Wait for the Customer Lookup or Main Menu screen$/i.test(text)) {
      action = { kind: "expectSaleComplete" };
    } else {
      throw new Error(`Line ${index + 1}: unknown step. See README for supported keywords.`);
    }
    steps.push({ line: index + 1, text, action });
  }
  if (!steps.length) throw new Error("Script has no executable steps.");
  if (steps[0]!.action.kind !== "open") throw new Error("The first step must open the app.");
  return steps;
}
