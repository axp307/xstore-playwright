import { parseArgs } from "node:util";
import { loadConfiguration } from "./config.js";
import { formatRunSummary, runScript } from "./runner.js";

// CLI entry point: parses flags, loads the environment config, and invokes the runner.
// Prints report paths and sets a nonzero exit code when the run fails.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      script: { type: "string" },
      config: { type: "string" },
      "base-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      "slow-mo": { type: "string", default: "250" },
      "report-dir": { type: "string", default: "reports" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) {
    console.log(`Usage: npm start -- --script <file> [--config <json>] [--base-url <url>]
  --dry-run          Parse and validate inputs without opening a browser
  --headless         Hide the browser (headed by default)
  --slow-mo <ms>     Delay browser actions for observation (default: 250)
  --report-dir <dir> JSON and text report output directory (default: reports)`);
    return;
  }
  if (!values.script) throw new Error("--script is required. Use --help for usage.");
  const slowMo = Number(values["slow-mo"]);
  if (!Number.isSafeInteger(slowMo) || slowMo < 0) throw new Error("--slow-mo must be a non-negative integer.");
  const config = await loadConfiguration(values.config, values["base-url"]);
  const result = await runScript({
    script: values.script, config, dryRun: values["dry-run"], headless: values.headless,
    slowMo, reportDir: values["report-dir"]
  });
  console.log(`${formatRunSummary(result.report, config.timesInSeconds)}
JSON: ${result.jsonPath}
Text: ${result.textPath}`);
  if (result.report.status === "failed") {
    console.error(result.report.error ?? result.report.steps.find(step => step.error)?.error);
    process.exitCode = 1;
  }
}

// Top-level guard so setup/preflight errors print a clean message and exit nonzero.
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
