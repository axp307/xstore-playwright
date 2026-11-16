export type Action =
  | { kind: "open"; target: string }
  | { kind: "configure"; file: string }
  | { kind: "login"; file: string }
  | { kind: "startTransaction" }
  | { kind: "startSale" }
  | { kind: "addProducts"; products: string[] }
  | { kind: "cashCheckout" };

export interface Step {
  line: number;
  text: string;
  action: Action;
}

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
    } else {
      throw new Error(`Line ${index + 1}: unknown step. See README for supported keywords.`);
    }
    steps.push({ line: index + 1, text, action });
  }
  if (!steps.length) throw new Error("Script has no executable steps.");
  if (steps[0]!.action.kind !== "open") throw new Error("The first step must open the app.");
  return steps;
}
