import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appUrl, loadConfiguration, xstoreConnection } from "../src/config.js";
import { revalidateDeviceAccess } from "../src/device-access.js";
import { runScript } from "../src/runner.js";
import { workspace } from "./helpers.js";

const env = {
  XSTORE_INSTALLATION_TOKEN: "synthetic-device-token",
  XSTORE_DB_USER: "test_user",
  XSTORE_DB_PASSWORD: "synthetic-password"
};
const local = "https://localhost:8443";
const settings = () => xstoreConnection({ retailLocationId: 123 }, local, env);

test("shared Xstore settings use local defaults and reuse the configured token in the client URL", async () => {
  const config = { ...await loadConfiguration(undefined, local), xstore: settings() };
  const url = new URL(appUrl("/", config));
  assert.equal(url.origin, local);
  assert.equal(url.pathname, "/xstoreclient/");
  assert.equal(url.searchParams.get("INSTALLATION_TOKEN"), env.XSTORE_INSTALLATION_TOKEN);
  assert.equal(url.searchParams.get("SERVER_ADDRESS"), "localhost");
  assert.equal(url.searchParams.get("SERVER_PORT"), "8443");
  assert.equal(url.searchParams.get("RETAIL_LOCATION_ID"), "123");
  assert.equal(url.searchParams.get("WORKSTATION_ID"), "1");
  assert.equal(config.xstore.database?.host, "localhost");
  assert.equal(config.xstore.database?.port, 1521);
  assert.equal(config.xstore.database?.serviceName, "shw_xstore_23_0");
  assert.throws(() => appUrl("https://unintended.example/", config), /must target/);
  assert.throws(() => appUrl("/other", config), /must target/);
  const remote = {
    ...config, baseUrl: "https://pos.example.invalid",
    xstore: xstoreConnection({
      retailLocationId: 456, workstationId: 2, shellAppVersion: "24.0.1",
      database: { host: "db.example.invalid", port: 1522, serviceName: "lab" }
    }, "https://pos.example.invalid", env)
  };
  const remoteUrl = new URL(appUrl("/", remote));
  assert.equal(remoteUrl.searchParams.get("SERVER_PORT"), "443");
  assert.equal(remoteUrl.searchParams.get("SERVER_ADDRESS"), "pos.example.invalid");
  assert.equal(remoteUrl.searchParams.get("RETAIL_LOCATION_ID"), "456");
  assert.equal(remoteUrl.searchParams.get("WORKSTATION_ID"), "2");
  assert.equal(remoteUrl.searchParams.get("SHELL_APP_VERSION"), "24.0.1");
  assert.equal(remote.xstore.database?.host, "db.example.invalid");
});

test("device settings reject incomplete, unsafe and mistyped inputs without exposing secrets", () => {
  for (const raw of [
    { retailLocationId: 0 }, { retailLocationId: "123" }, { workstationId: null },
    { organizationId: null }, { organizationId: -1 }, { unknown: true },
    { revalidateToken: null }, { installationTokenEnv: env.XSTORE_INSTALLATION_TOKEN },
    { shellAppVersion: "" }, { database: { host: "user:password@db" } },
    { database: { serviceName: "https://localhost:8443/xstoreshellapp" } },
    { database: { port: 65536 } }, { database: { port: "1521" } },
    { database: { password: env.XSTORE_DB_PASSWORD } }, { revalidateToken: false, database: {} }
  ]) {
    assert.throws(() => xstoreConnection({ retailLocationId: 123, ...raw }, local, env), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(env.XSTORE_INSTALLATION_TOKEN));
      assert.ok(!error.message.includes(env.XSTORE_DB_PASSWORD));
      return true;
    });
  }
  for (const base of [`${local}/xstoreclient/`, `${local}/?token=secret`, `${local}/#fragment`]) {
    assert.throws(() => xstoreConnection({ retailLocationId: 123 }, base, env), /must be an origin/);
  }
  assert.throws(() => xstoreConnection({ retailLocationId: 123 }, local, {}), /XSTORE_INSTALLATION_TOKEN/);
  assert.throws(() => xstoreConnection({ retailLocationId: 123 }, local, {
    XSTORE_INSTALLATION_TOKEN: "synthetic"
  }), /XSTORE_DB_USER/);
  assert.throws(() => xstoreConnection({ retailLocationId: 123 }, "https://pos.example.invalid", env), /explicit database/);
  assert.throws(() => xstoreConnection({
    retailLocationId: 123, database: { host: "db.example.invalid" }
  }, "https://pos.example.invalid", env), /explicit database/);
  assert.equal(xstoreConnection({ retailLocationId: 123, revalidateToken: false }, local, {
    XSTORE_INSTALLATION_TOKEN: "synthetic"
  }).database, undefined);
});

function fakeDatabase(rowsAffected: number | undefined = 1) {
  const calls: string[] = [];
  const statements: { sql: string; binds: Record<string, string | number>; autoCommit: boolean }[] = [];
  const connection = {
    callTimeout: 0,
    async execute(sql: string, binds: Record<string, string | number>, options: { autoCommit: false }) {
      calls.push("execute");
      statements.push({ sql, binds, autoCommit: options.autoCommit });
      return rowsAffected === undefined ? {} : { rowsAffected };
    },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    async close() { calls.push("close"); }
  };
  return { calls, statements, connection };
}

test("revalidation binds the specific device and commits only one eligible record", async () => {
  const db = fakeDatabase();
  const xstore = settings();
  xstore.installationToken = "'; do not interpolate this token";
  await revalidateDeviceAccess(xstore, 1234, async options => {
    assert.equal(options.connectString, "localhost:1521/shw_xstore_23_0?connect_timeout=5&transport_connect_timeout=5");
    assert.equal(options.password, env.XSTORE_DB_PASSWORD);
    return db.connection;
  });
  const statement = db.statements[0]!;
  for (const [column, bind] of [
    ["ORGANIZATION_ID", "organizationId"], ["RTL_LOC_ID", "retailLocationId"],
    ["WKSTN_ID", "workstationId"], ["TOKEN", "token"]
  ]) assert.match(statement.sql, new RegExp(`${column} = :${bind}`));
  assert.match(statement.sql, /STATUS IN \('ENABLED', 'BLOCKED'\)/);
  assert.ok(!statement.sql.includes(xstore.installationToken));
  assert.deepEqual(statement.binds, {
    organizationId: 1, retailLocationId: 123, workstationId: 1, token: xstore.installationToken
  });
  assert.equal(statement.autoCommit, false);
  assert.deepEqual(db.calls, ["execute", "commit", "close"]);
  assert.equal(db.connection.callTimeout, 1234);
});

test("missing or ambiguous device updates are rolled back, never committed", async () => {
  for (const count of [0, 2]) {
    const db = fakeDatabase(count);
    await assert.rejects(revalidateDeviceAccess(settings(), 1000, async () => db.connection), /exactly one/);
    assert.deepEqual(db.calls, ["execute", "rollback", "close"]);
  }
});

test("database failures are explicit, sanitized, rolled back and closed", async t => {
  const privateError = Object.assign(new Error(`${env.XSTORE_INSTALLATION_TOKEN} ${env.XSTORE_DB_PASSWORD}`), { code: "ORA-01031" });
  await assert.rejects(revalidateDeviceAccess(settings(), 1000, async () => { throw privateError; }), /during connect \(ORA-01031\)/);
  for (const stage of ["execute", "commit"] as const) {
    const db = fakeDatabase();
    t.mock.method(db.connection, stage, async () => { throw privateError; });
    await assert.rejects(revalidateDeviceAccess(settings(), 1000, async () => db.connection), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ORA-01031/);
      assert.ok(!error.message.includes(env.XSTORE_INSTALLATION_TOKEN));
      assert.ok(!error.message.includes(env.XSTORE_DB_PASSWORD));
      return true;
    });
    assert.deepEqual(db.calls.slice(-2), ["rollback", "close"]);
  }
  const db = fakeDatabase(0);
  t.mock.method(db.connection, "rollback", async () => { throw privateError; });
  t.mock.method(db.connection, "close", async () => { throw privateError; });
  await assert.rejects(revalidateDeviceAccess(settings(), 1000, async () => db.connection), /exactly one.*Rollback also failed.*cleanup failed/);
  await revalidateDeviceAccess({ ...settings(), database: undefined }, 1000, async () => {
    assert.fail("token-only mode must not connect to a database");
  });
});

test("dry-run validates device settings without contacting Oracle or exposing secrets", async t => {
  const directory = await workspace(t);
  const configFile = resolve(directory, "config.json");
  const key = "XSTORE_TEST_DEVICE_TOKEN";
  const previous = process.env[key];
  process.env[key] = env.XSTORE_INSTALLATION_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  await writeFile(configFile, JSON.stringify({
    xstore: { retailLocationId: 123, installationTokenEnv: key, revalidateToken: false }
  }));
  const config = await loadConfiguration(configFile);
  assert.equal(config.baseUrl, `${local}/`);
  assert.equal(config.xstore?.installationToken, env.XSTORE_INSTALLATION_TOKEN);
  // An unreachable database proves a dry run does not attempt revalidation.
  config.xstore = { ...settings(), database: { ...settings().database!, host: "unreachable.invalid" } };
  const result = await runScript({
    script: "smoke/xstore-is-running.xstore", config, dryRun: true, reportDir: directory
  });
  assert.equal(result.report.status, "passed");
  for (const file of [result.jsonPath, result.textPath]) {
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes(env.XSTORE_INSTALLATION_TOKEN));
    assert.ok(!text.includes(env.XSTORE_DB_PASSWORD));
  }
});
