// One-off discovery: signs in, scans the first sale item twice, and reports which DOM nodes of its sale
// line changed. Use the result to choose the `saleLineQuantity` selector. Test instances only.
// Leaves the sale open: cancel it in Xstore before running the DIY sale script again.
// Run: npx tsx tools/discover-quantity-dom.ts [script] [config]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import type { Locator } from "playwright";
import { loadConfiguration, readJson, saleItems, strings } from "../src/config.js";
import { parseScript } from "../src/parser.js";
import { saveFailureScreenshot } from "../src/runner.js";
import { executeAction, scanCompleted } from "../src/xstore.js";
import type { SaleLineSnapshot } from "../src/xstore.js";

interface DomNode { path: string; tag: string; id: string; cls: string; text: string }

const scriptPath = resolve(process.argv[2] ?? "diy-sale/diy-sale-with-cash.xstore");
const config = await loadConfiguration(process.argv[3] ?? "config/localhost-shell.json");
const steps = parseScript(await readFile(scriptPath, "utf8"));
const scanIndex = steps.findIndex(step => step.action.kind === "scanItems");
if (scanIndex < 0) throw new Error("Script has no scan step.");
const scan = steps[scanIndex]!.action as { kind: "scanItems"; file: string };
const [item] = saleItems(await readJson(resolve(dirname(scriptPath), scan.file)), "Sale items");
if (!item) throw new Error("No sale items.");

// Flattens the first sale line into one record per descendant, keyed by its position in the tree.
// Built with new Function so tsx's helper injection (__name) does not leak into the browser.
const describeInPage = new Function("root", `
  const out = [];
  const walk = (el, path) => {
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => (n.textContent || "").trim()).filter(Boolean).join(" ");
    out.push({ path, tag: el.tagName.toLowerCase(), id: el.id, cls: el.getAttribute("class") || "", text: own });
    Array.from(el.children).forEach((child, i) => walk(child, path + ">" + child.tagName.toLowerCase() + "[" + i + "]"));
  };
  walk(root, root.tagName.toLowerCase());
  return out;
`) as (root: Element) => DomNode[];
const describe = (line: Locator): Promise<DomNode[]> => line.evaluate(describeInPage);

const browser = await chromium.launch({ headless: false, slowMo: 0 });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: config.ignoreHttpsErrors });
  context.setDefaultTimeout(config.timeoutMs);
  const page = await context.newPage();
  // Inputs are masked and the file is owner-only; page text is deliberately not logged (customer data).
  const failureShot = async (error: unknown): Promise<never> => {
    await mkdir("reports", { recursive: true });
    const file = resolve("reports", `quantity-discovery-failure-${Date.now()}.png`);
    await saveFailureScreenshot(page, config, file).then(() => console.log(`Masked screenshot: ${file}`), () => undefined);
    throw error;
  };
  try {
    const cartReady = () => page.getByText("Shopping Cart", { exact: true }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    for (const step of steps.slice(0, scanIndex)) {
      const action = step.action;
      // A sale left open by an earlier run resumes on the cart, which has no login or menu to step through.
      if (step.line > steps[1]!.line && await cartReady()) break;
      const needsFile = ["configure", "login", "xstoreLogin", "shellConfigure"].includes(action.kind);
      const data = needsFile
        ? strings(await readJson(resolve(dirname(scriptPath), (action as { file: string }).file)), `Input at line ${step.line}`)
        : undefined;
      console.log(`[running] line ${step.line}: ${step.text}`);
      await executeAction(page, action, config, data);
    }
    const lines = page.locator(config.selectors.saleLines);
    const cart = (): Promise<SaleLineSnapshot[]> =>
      lines.evaluateAll(elements => elements.map(element => ({ id: element.id, text: (element as HTMLElement).innerText })));
    // Submits the sale ID and waits for this scan's acknowledgement, whatever the cart already held.
    const scanOnce = async () => {
      const snapshotBefore = await cart();
      await page.locator(config.selectors.scanInput).fill(item.saleId);
      await page.locator(config.selectors.scanInput).press("Enter");
      await expect(async () => {
        expect(scanCompleted(snapshotBefore, await cart(), item.saleId), "scan was not acknowledged").toBe(true);
      }).toPass({ timeout: config.timeoutMs });
    };
    const escapedId = item.saleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`(?<![\\w.,$-])${escapedId}(?!\\w|[.,]\\d)`);
    // The submitted item's own line, tracked by DOM id so other rows in a resumed cart are never compared.
    const itemLine = async () => {
      const match = (await cart()).find(line => token.test(line.text));
      if (!match) throw new Error(`No sale line shows sale ID ${item.saleId}.`);
      return page.locator(`[id="${match.id}"]`);
    };
    await scanOnce();
    const target = await itemLine();
    const first = await describe(target);
    const count = await lines.count();
    await scanOnce();
    const afterCount = await lines.count();
    const second = await describe(target);

    const before = new Map(first.map(n => [n.path, n]));
    const changed = second.filter(n => {
      const old = before.get(n.path);
      return !old || old.text !== n.text || old.cls !== n.cls;
    }).map(n => ({ ...n, was: before.get(n.path)?.text }));
    console.log(`\nLines before: ${count}, after second scan: ${afterCount}`);
    console.log(afterCount > count ? "Repeated scan added a NEW line." : "Repeated scan changed the existing line.");
    console.log("Changed nodes in the first sale line:");
    console.table(changed.map(n => ({ path: n.path, id: n.id, class: n.cls, was: n.was, now: n.text })));
    await mkdir("reports", { recursive: true });
    const file = resolve("reports", `quantity-discovery-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({ saleId: item.saleId, count, afterCount, first, second, changed }, null, 2), { mode: 0o600 });
    console.log(`Full DOM snapshots written to ${file}`);
  } catch (error) {
    await failureShot(error);
  }
} finally {
  await browser.close();
}
