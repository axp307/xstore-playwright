# Xstore Playwright quick start

Run the Xstore shell smoke test to confirm the login screen is ready. This
project requires Node.js 22 or newer and npm. The first setup also downloads
Playwright's Chromium browser.

```sh
npm ci
npx playwright install chromium
```

## Run the smoke test

Start an authorized Xstore test instance at `https://localhost:8443`. Review
`smoke/shell-configuration.json` and set the intended test store, register,
host, and port, then run:

```sh
npm start -- --script smoke/xstore-is-running.xstore \
  --config config/localhost-shell.json \
  --slow-mo 400 \
  --report-dir reports/live
```

The test passes only when the Xstore login screen is ready. It does not log in
or start a sale. The configuration accepts the localhost HTTPS certificate for
this run only; do not use it for an untrusted host. Use a test instance, never
production.

### Run the DIY Sale with Cash test

Completes a no-account cash sale: signs in with the generic developer login in
`config/xstore-login.json` if a login form is shown, starts a transaction,
skips customer lookup, scans the sale IDs in `diy-sale/sale-items.json`, and
tenders the exact amount due in cash. It passes when Xstore returns to Customer
Lookup or the Main Menu.

```sh
npm start -- --script diy-sale/diy-sale-with-cash.xstore \
  --config config/localhost-shell.json \
  --slow-mo 400 \
  --report-dir reports/live
```

This completes a real sale, so use a test instance only. If a previous run left
a sale open, cancel it first.

## More Information

See the [Technical Overview](docs/wiki/Technical-Overview.md) for framework
architecture, script syntax, configuration, reports, testing, and extension
details.
