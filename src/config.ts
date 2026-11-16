import { readFile } from "node:fs/promises";

export const defaultSelectors = {
  configurationScreen: '[data-testid="first-time-configuration"]',
  configurationSubmit: 'button:has-text("Save Configuration")',
  username: 'input[name="username"]',
  password: 'input[name="password"]',
  loginSubmit: 'button:has-text("Log In")',
  startTransaction: 'button:has-text("Start Transaction")',
  startSale: 'button:has-text("Sale")',
  diyCustomer: 'button:has-text("DIY Customer")',
  productId: 'input[name="productId"]',
  addProduct: 'button:has-text("Add Product")',
  cartItems: '[data-testid="cart-item"]',
  checkout: 'button:has-text("Checkout")',
  cash: 'button:has-text("Cash")',
  amountDue: '[data-testid="amount-due"]',
  cashAmount: 'input[name="cashAmount"]',
  completeTransaction: 'button:has-text("Complete Transaction")',
  transactionComplete: '[data-testid="transaction-complete"]',
  // Xstore shell app (setup/launch) and login screen, discovered from the live app's DOM.
  shellConfigScreen: '#configMain',
  shellLocationDetails: 'role=button[name="Location Details"s]',
  shellStore: '[id="storeNumber|input"]',
  shellRegister: '[id="registerNumber|input"]',
  shellSave: 'role=button[name="Save"s]',
  shellConnectionDetails: 'role=button[name="Connection Details"s]',
  shellHost: '[id="serverHost|input"]',
  shellPort: '[id="serverPort|input"]',
  shellTestConnection: 'role=button[name="Test Connection"s]',
  shellDialog: 'oj-dialog',
  shellConnectionSuccess: 'oj-dialog:has-text("Connection Test"):has(:text-is("Success"))',
  shellDialogOk: 'oj-dialog >> role=button[name="OK"s]',
  shellLaunch: 'role=button[name="Launch Xstore"s]',
  deviceErrorDialog: 'oj-dialog:has-text("Hardware Error")',
  deviceErrorOk: 'oj-dialog:has-text("Hardware Error") >> role=button[name="OK"s]',
  loginReady: '#focusBarInfoArea:has-text("Log In") #focusBarInputField input'
};

export interface Configuration {
  baseUrl: string;
  timeoutMs: number;
  // Only "fresh" exists today; a persistent-profile mode would be added here later.
  browserState: "fresh";
  // Opt-in: accept the trusted localhost's self-signed HTTPS certificate for this run's context only.
  ignoreHttpsErrors: boolean;
  // Observation pause (ms) after each successfully executed step; separate from Playwright slowMo.
  stepDelayMs: number;
  selectors: typeof defaultSelectors;
  configurationFields: Record<string, string>;
  amountFormat: { decimalSeparator: string; groupSeparator: string; currencySymbol: string };
}

// Narrows an unknown JSON value to a plain object or throws with a labelled message.
// Shared guard so every config/input shape error names the offending section.
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

// Validates that a JSON object maps keys to non-empty strings and returns it typed.
// Used for credential, configuration-field, and selector override maps.
export function strings(value: unknown, label: string): Record<string, string> {
  const entries = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label}.${key} must be a non-empty string.`);
    }
    result[key] = entry;
  }
  return result;
}

// Reads and parses a JSON file, hiding parser excerpts that could leak secret values.
// Missing-file errors pass through unchanged so callers can report the path.
export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    // JSON parser errors can contain excerpts of credentials.
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}.`);
    throw error;
  }
}

// Resolves a script target against the base URL and allows only credential-free HTTP(S).
// Blocks file:/javascript: schemes and user:password@ URLs from reaching the browser.
export function httpUrl(target: string, base?: string): string {
  const url = new URL(target, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("App URLs must use HTTP(S) and must not contain credentials.");
  }
  return url.href;
}

// Builds the validated environment configuration from an optional JSON file and --base-url.
// Merges selector overrides over defaultSelectors and rejects unknown keys or bad formats.
export async function loadConfiguration(file?: string, baseUrl?: string): Promise<Configuration> {
  const raw = file ? object(await readJson(file), "Configuration") : {};
  const allowed = ["baseUrl", "timeoutMs", "selectors", "configurationFields", "amountFormat", "browserState", "ignoreHttpsErrors", "stepDelayMs"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`Unknown configuration key: ${key}`);
  }
  const base = baseUrl ?? raw.baseUrl ?? "http://localhost:8080";
  if (typeof base !== "string") throw new Error("baseUrl must be a string.");
  const browserState = raw.browserState === undefined ? "fresh" : raw.browserState;
  if (browserState !== "fresh") {
    throw new Error('browserState must be "fresh"; persistent profiles are not supported yet.');
  }
  const stepDelayMs = raw.stepDelayMs === undefined ? 0 : raw.stepDelayMs;
  if (typeof stepDelayMs !== "number" || !Number.isSafeInteger(stepDelayMs) || stepDelayMs < 0) {
    throw new Error("stepDelayMs must be a non-negative safe integer (milliseconds).");
  }
  const ignoreHttpsErrors = raw.ignoreHttpsErrors ?? false;
  if (typeof ignoreHttpsErrors !== "boolean") throw new Error("ignoreHttpsErrors must be true or false.");
  const timeout = raw.timeoutMs ?? 15_000;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  const overrides = raw.selectors === undefined ? {} : strings(raw.selectors, "selectors");
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaultSelectors, key)) throw new Error(`Unknown selector: ${key}`);
  }
  const fields = raw.configurationFields === undefined
    ? { storeId: 'input[name="storeId"]', registerId: 'input[name="registerId"]' }
    : strings(raw.configurationFields, "configurationFields");
  const format = { decimalSeparator: ".", groupSeparator: ",", currencySymbol: "$" };
  if (raw.amountFormat !== undefined) {
    const values = object(raw.amountFormat, "amountFormat");
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(format, key) || typeof value !== "string") throw new Error(`Invalid amountFormat.${key}`);
    }
    Object.assign(format, values);
  }
  if (format.decimalSeparator.length !== 1 || format.groupSeparator.length > 1
    || format.decimalSeparator === format.groupSeparator
    || /[0-9]/.test(format.decimalSeparator + format.groupSeparator)
    || /[0-9]/.test(format.currencySymbol)) {
    throw new Error("Amount separators must be distinct non-digit characters; currencySymbol must not contain digits.");
  }
  return {
    baseUrl: httpUrl(base),
    timeoutMs: timeout,
    browserState,
    ignoreHttpsErrors,
    stepDelayMs,
    selectors: { ...defaultSelectors, ...overrides },
    configurationFields: fields,
    amountFormat: format
  };
}
