import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { httpUrl, readJson, saleItems, strings } from "./config.js";
import type { Configuration, SaleItem } from "./config.js";
import { parseScript } from "./parser.js";
import { executeAction, takeHumanDelaySec } from "./xstore.js";

// Rounds seconds to at most 3 decimals (millisecond precision).
export function roundSec(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// Seconds elapsed since a performance.now() timestamp, to 3 decimals.
function elapsedSec(startedMs: number): number {
  return roundSec((performance.now() - startedMs) / 1000);
}

export interface RunOptions {
  script: string;
  config: Configuration;
  dryRun?: boolean;
  headless?: boolean;
  slowMo?: number;
  reportDir?: string;
}

export interface StepResult {
  // 1-based position in the script's executable steps; `line` is the source line.
  stepNumber: number;
  line: number;
  step: string;
  status: "not-run" | "planned" | "passed" | "skipped" | "failed";
  // Elapsed step time = executionSec + humanDelaySec + observationDelaySec (always exactly their sum).
  durationSec: number;
  // Action time (includes any --slow-mo and failure screenshot); excludes both delays below.
  executionSec: number;
  // Measured humanDelayMs pauses before clicks/fills/key presses within the step (simulated reaction time).
  humanDelaySec: number;
  // Measured elapsed stepDelayMs pause; 0 unless the step passed.
  observationDelaySec: number;
  error?: string;
  screenshot?: string | undefined;
}

export interface RunReport {
  mode: "dry-run" | "browser";
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  // Wall-clock run time, including browser launch/close overhead.
  durationSec: number;
  // Sums over steps; their total is at most durationSec (the rest is lifecycle overhead).
  stepExecutionSec: number;
  stepHumanDelaySec: number;
  stepObservationDelaySec: number;
  steps: StepResult[];
  // One entry per scanned item for "record scan times" steps.
  scanTimes: ScanTime[];
  error?: string;
}

export interface ScanTime {
  saleId: string;
  seconds: number;
}

// Renders a duration held in seconds as "1.45 s" or, when timesInSeconds is false, "1450 ms".
export function formatTime(seconds: number, inSeconds = true): string {
  return inSeconds ? `${seconds} s` : `${Math.round(seconds * 1000)} ms`;
}

export function formatScanTime(scan: ScanTime, inSeconds = true): string {
  const took = inSeconds ? `${scan.seconds.toFixed(3)} seconds` : `${Math.round(scan.seconds * 1000)} milliseconds`;
  return `[scan-time] item ${scan.saleId} took ${took} to complete scanning`;
}

// Formats the terminal completion line for a step from the same measured fields stored in the report.
// Shows elapsed time as execution plus human delay plus observation delay so console and report agree.
export function formatStepLog(step: StepResult, inSeconds = true): string {
  const t = (value: number) => formatTime(value, inSeconds);
  return `[${step.status}] step ${step.stepNumber} (elapsed ${t(step.durationSec)} = execution ${t(step.executionSec)} + human delay ${t(step.humanDelaySec)} + observation delay ${t(step.observationDelaySec)})`;
}

// Formats the CLI end-of-run summary: summed step time versus wall-clock total.
// The difference is browser startup/cleanup and other overhead outside any step.
export function formatRunSummary(report: RunReport, inSeconds = true): string {
  const t = (value: number) => formatTime(value, inSeconds);
  const overhead = roundSec(Math.max(0, report.durationSec - report.stepExecutionSec - report.stepHumanDelaySec - report.stepObservationDelaySec));
  return `Run ${report.status}; steps: execution ${t(report.stepExecutionSec)} + human delay ${t(report.stepHumanDelaySec)} + observation delay ${t(report.stepObservationDelaySec)}; `
    + `wall-clock total ${t(report.durationSec)} (includes ~${t(overhead)} browser startup/cleanup and other overhead).`;
}

// Masks editable and configured input fields before capturing failure evidence.
// Writes the buffer with owner-only permissions; callers retain best-effort error handling.
export async function saveFailureScreenshot(page: Page, config: Configuration, file: string): Promise<void> {
  const s = config.selectors;
  const mask = [
    'input, textarea, [contenteditable]',
    s.username, s.password, ...Object.values(config.configurationFields),
    s.shellStore, s.shellRegister, s.shellHost, s.shellPort
  ].map(selector => page.locator(selector));
  const screenshot = await page.screenshot({ mask });
  await writeFile(file, screenshot, { mode: 0o600, flag: "wx" });
}

// Checks a shell-setup input file has exactly store, register, host and a valid port.
// Run during preflight so typos fail before the browser touches the real app.
function validateShellSetup(values: Record<string, string>, line: number): void {
  const keys = ["store", "register", "host", "port"];
  if (Object.keys(values).sort().join() !== [...keys].sort().join()) {
    throw new Error(`Line ${line}: shell configuration file must contain exactly ${keys.join(", ")}.`);
  }
  if (!/^[0-9]+$/.test(values.port!) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error(`Line ${line}: port must be a number from 1 to 65535.`);
  }
}

// Runs a whole script: parse, preflight inputs, then dry-run or drive Chromium step by step.
// Times every step, stops at the first failure, redacts secrets, and writes JSON/text reports.
export async function runScript(options: RunOptions): Promise<{
  report: RunReport; jsonPath: string; textPath: string;
}> {
  const steps = parseScript(await readFile(options.script, "utf8"));
  const data = new Map<number, Record<string, string>>();
  const items = new Map<number, SaleItem[]>();
  const secretValues: string[] = [];
  // Preflight every input before opening a browser or changing POS state.
  for (const step of steps) {
    const action = step.action;
    if (action.kind === "open") httpUrl(action.target, options.config.baseUrl);
    if (action.kind === "scanItems") {
      const file = resolve(dirname(resolve(options.script)), action.file);
      items.set(step.line, saleItems(await readJson(file), `Sale items at line ${step.line}`));
      continue; // Sale IDs are catalog data, not secrets.
    }
    if (action.kind !== "configure" && action.kind !== "login" && action.kind !== "xstoreLogin" && action.kind !== "shellConfigure") continue;
    const file = resolve(dirname(resolve(options.script)), action.file);
    const values = strings(await readJson(file), `Input at line ${step.line}`);
    if (action.kind === "shellConfigure") {
      validateShellSetup(values, step.line);
      data.set(step.line, values);
      continue; // Store/register/host/port are project settings, not secrets, so they are not redacted.
    }
    if (action.kind === "login" || action.kind === "xstoreLogin") {
      if (!values.username || !values.password || Object.keys(values).length !== 2) {
        throw new Error(`Line ${step.line}: credential file must contain exactly username and password.`);
      }
    } else {
      if (!Object.keys(values).length) throw new Error(`Line ${step.line}: configuration file is empty.`);
      for (const key of Object.keys(values)) {
        if (!Object.hasOwn(options.config.configurationFields, key)) {
          throw new Error(`Line ${step.line}: no configuration field selector for ${key}.`);
        }
      }
    }
    data.set(step.line, values);
    // The shared developer login ("xstoreLogin") is not secret; redacting a value like "1" would garble reports.
    if (action.kind !== "xstoreLogin") secretValues.push(...Object.values(values));
  }
  const redact = (value: string) => secretValues.filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  const report: RunReport = {
    mode: options.dryRun ? "dry-run" : "browser", status: "passed",
    startedAt: new Date().toISOString(), finishedAt: "", durationSec: 0, stepExecutionSec: 0, stepHumanDelaySec: 0, stepObservationDelaySec: 0,
    scanTimes: [],
    steps: steps.map((step, index) => ({ stepNumber: index + 1, line: step.line, step: redact(step.text), status: "not-run", durationSec: 0, executionSec: 0, humanDelaySec: 0, observationDelaySec: 0 }))
  };
  const directory = resolve(options.reportDir ?? "reports");
  await mkdir(directory, { recursive: true });
  const id = `run-${report.startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const jsonPath = resolve(directory, `${id}.json`);
  const textPath = resolve(directory, `${id}.txt`);
  const started = performance.now();
  let browser: Browser | undefined;
  try {
    if (options.dryRun) {
      for (const result of report.steps) {
        result.status = "planned";
        console.log(`[planned] step ${result.stepNumber}: ${result.step}`);
      }
    } else {
      browser = await chromium.launch({ headless: options.headless ?? false, slowMo: options.slowMo ?? 250 });
      // "fresh" = isolated, empty context per run; a future persistent mode would branch here.
      const context = await browser.newContext({ ignoreHTTPSErrors: options.config.ignoreHttpsErrors });
      context.setDefaultTimeout(options.config.timeoutMs);
      context.setDefaultNavigationTimeout(options.config.timeoutMs);
      const page = await context.newPage();
      for (const [index, step] of steps.entries()) {
        const result = report.steps[index]!;
        console.log(`[running] step ${result.stepNumber}: ${result.step}`);
        const stepStarted = performance.now();
        try {
          result.status = await executeAction(page, step.action, options.config, data.get(step.line), items.get(step.line), (saleId, seconds) => {
            const scan = { saleId: redact(saleId), seconds };
            report.scanTimes.push(scan);
            console.log(formatScanTime(scan, options.config.timesInSeconds));
          });
          result.humanDelaySec = takeHumanDelaySec(page);
          // Deliberate observation pause; counted in this step's durationSec and the run total.
          if (result.status === "passed" && options.config.stepDelayMs > 0) {
            result.executionSec = roundSec(Math.max(0, elapsedSec(stepStarted) - result.humanDelaySec));
            const delayStarted = performance.now();
            await page.waitForTimeout(options.config.stepDelayMs);
            result.observationDelaySec = elapsedSec(delayStarted);
          }
        } catch (error) {
          result.status = "failed";
          result.humanDelaySec = takeHumanDelaySec(page);
          result.error = redact(error instanceof Error ? error.message : String(error));
          report.status = "failed";
          // Best-effort evidence of what the page showed; never masks the original failure.
          const shot = resolve(directory, `${id}-line-${step.line}.png`);
          result.screenshot = await saveFailureScreenshot(page, options.config, shot).then(() => shot, () => undefined);
        } finally {
          // Without a pause, execution is the whole step; otherwise it was captured before the pause.
          if (result.observationDelaySec === 0) {
            result.executionSec = roundSec(Math.max(0, elapsedSec(stepStarted) - result.humanDelaySec));
          }
          result.durationSec = roundSec(result.executionSec + result.humanDelaySec + result.observationDelaySec);
          console.log(formatStepLog(result, options.config.timesInSeconds));
        }
        if (report.status === "failed") break;
      }
    }
  } catch (error) {
    report.status = "failed";
    report.error = redact(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      report.status = "failed";
      report.error = redact(`Browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    report.finishedAt = new Date().toISOString();
    report.durationSec = elapsedSec(started);
    report.stepExecutionSec = roundSec(report.steps.reduce((sum, step) => sum + step.executionSec, 0));
    report.stepHumanDelaySec = roundSec(report.steps.reduce((sum, step) => sum + step.humanDelaySec, 0));
    report.stepObservationDelaySec = roundSec(report.steps.reduce((sum, step) => sum + step.observationDelaySec, 0));
    const t = (value: number) => formatTime(value, options.config.timesInSeconds);
    const lines = [
      `Run: ${report.status} (${report.mode})`,
      `Started: ${report.startedAt}`, `Finished: ${report.finishedAt}`,
      `Total elapsed (wall-clock, incl. browser launch/close): ${t(report.durationSec)}`,
      `Steps: execution ${t(report.stepExecutionSec)} + human delay ${t(report.stepHumanDelaySec)} + observation delay ${t(report.stepObservationDelaySec)} = ${t(roundSec(report.stepExecutionSec + report.stepHumanDelaySec + report.stepObservationDelaySec))}`,
      "Execution includes Playwright --slow-mo; human delay is the humanDelayMs pause before each click/fill/key press; observation delay is the stepDelayMs pause after passed steps.",
      ...report.steps.map(step =>
        `${step.stepNumber}. [${step.status}] ${t(step.durationSec)} (execution ${t(step.executionSec)} + human delay ${t(step.humanDelaySec)} + observation delay ${t(step.observationDelaySec)}) - ${step.step}${step.error ? `\n   ${step.error}` : ""}${step.screenshot ? `\n   Screenshot: ${step.screenshot}` : ""}`),
      ...report.scanTimes.map(scan => formatScanTime(scan, options.config.timesInSeconds)),
      ...(report.error ? [`Run error: ${report.error}`] : [])
    ];
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await writeFile(textPath, lines.join("\n") + "\n", { mode: 0o600 });
  }
  return { report, jsonPath, textPath };
}
