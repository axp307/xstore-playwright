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

## Reuse and revalidate a device token

Xstore blocks other device tokens on the same register when a new installation
connects. By default, each fresh browser run creates a new installation.
To avoid this, copy `config/xstore-device.example.json` to
`config/xstore-device.local.json`, review the organization/store/register, and
set these environment variables securely in your shell:

| Variable | Value |
| --- | --- |
| `XSTORE_INSTALLATION_TOKEN` | An existing authorized device's `INSTALLATION_TOKEN`, reused on every run |
| `XSTORE_DB_USER` | Local Oracle schema user with access to `CTL_CHEETAH_DEVICE_ACCESS` |
| `XSTORE_DB_PASSWORD` | That user's database password |

```sh
npm start -- --script smoke/xstore-is-running.xstore \
  --config config/xstore-device.local.json
```

The runner opens `/xstoreclient/` directly with that token; no shell setup is
needed. Before opening the browser it sets **only the matching token** to
`ENABLED` in `CTL_CHEETAH_DEVICE_ACCESS`, scoped by organization, store and
register. Missing, mismatched, quick-config or pending-approval records fail
instead of enabling unrelated devices. A new token must first be authorized
through Xstore. Only `ENABLED` and `BLOCKED` records are eligible.

The database defaults to `localhost:1521/shw_xstore_23_0` (Oracle service name,
not the shell's HTTPS URL). `baseUrl` sets the web host/port; database connection
settings are separate. A lab needs an explicitly configured web origin,
database host and service name. Use authorized non-production environments
only. Set `xstore.revalidateToken` to `false` and omit `xstore.database` to reuse
the token without database access.

Browser cookies remain isolated between runs. Device tokens do **not** isolate
server-side cashier or transaction state: use a dedicated test register, and
do not run Electron and automation concurrently on the same device identity.
No token can prevent another newly installed device from blocking it.
Dry-run validates inputs but never connects to Oracle or Xstore. Keep tokens,
passwords and token-bearing URLs out of git; `.env` is ignored but is **not**
automatically loaded.
