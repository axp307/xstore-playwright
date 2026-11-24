// One-off discovery: signs in, scans the first sale item twice, and reports which DOM nodes of its sale
// line changed. Use the result to choose the `saleLineQuantity` selector. Test instances only.
// Leaves the sale open: cancel it in Xstore before running the DIY sale script again.
// Run: npx tsx tools/discover-quantity-dom.ts [script] [config]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loadConfiguration, readJson, saleItems, strings } from "../src/config.js";
import { parseScript } from "../src/parser.js";
import { executeAction } from "../src/xstore.js";

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
const describe = (page: Page): Promise<DomNode[]> =>
  page.locator(config.selectors.saleLines).first().evaluate(describeInPage);

const browser = await chromium.launch({ headless: false, slowMo: 0 });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: config.ignoreHttpsErrors });
  context.setDefaultTimeout(config.timeoutMs);
  const page = await context.newPage();
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
  const scanOnce = async () => {
    await page.locator(config.selectors.scanInput).fill(item.saleId);
    await page.locator(config.selectors.scanInput).press("Enter");
  };
  await scanOnce();
  await lines.first().waitFor({ timeout: 10000 }).catch(async error => {
    await mkdir("reports", { recursive: true });
    await page.screenshot({ path: "reports/quantity-discovery-failure.png" });
    console.log("Screenshot: reports/quantity-discovery-failure.png");
    console.log("Screen text at failure:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600));
    throw error;
  });
  const first = await describe(page);
  const firstText = await lines.first().innerText();
  const count = await lines.count();
  await scanOnce();
  // Either the first line changes (quantity) or a new line appears, whichever Xstore does for a repeat.
  await page.waitForFunction(([selector, text, n]) => {
    const els = document.querySelectorAll(selector as string);
    return els.length > (n as number) || (els[0] as HTMLElement | undefined)?.innerText !== text;
  }, [config.selectors.saleLines, firstText, count] as const);
  const afterCount = await lines.count();
  const second = await describe(page);

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
} finally {
  await browser.close();
}
