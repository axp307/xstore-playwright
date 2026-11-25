import oracledb from "oracledb";
import type { XstoreConnection } from "./config.js";

interface DeviceAccessDatabase {
  callTimeout?: number | undefined;
  execute(sql: string, binds: Record<string, string | number>, options: { autoCommit: false }): Promise<{ rowsAffected?: number | undefined }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

type Connect = (options: { user: string; password: string; connectString: string }) => Promise<DeviceAccessDatabase>;

function databaseError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^(ORA|NJS|DPI)-\d+$/.test(code) ? ` (${code})` : "";
}

export async function revalidateDeviceAccess(
  settings: XstoreConnection, timeoutMs: number,
  connect: Connect = options => oracledb.getConnection(options)
): Promise<void> {
  const db = settings.database;
  if (!db) return;
  let connection: DeviceAccessDatabase | undefined;
  let failure: Error | undefined;
  let stage = "connect";
  try {
    connection = await connect({
      user: db.user, password: db.password,
      connectString: `${db.host}:${db.port}/${db.serviceName}?connect_timeout=5&transport_connect_timeout=5`
    });
    connection.callTimeout = timeoutMs;
    stage = "update";
    const result = await connection.execute(`
      UPDATE CTL_CHEETAH_DEVICE_ACCESS
         SET STATUS = 'ENABLED', UPDATE_DATE = SYSTIMESTAMP
       WHERE ORGANIZATION_ID = :organizationId
         AND RTL_LOC_ID = :retailLocationId
         AND WKSTN_ID = :workstationId
         AND TOKEN = :token
         AND STATUS IN ('ENABLED', 'BLOCKED')`, {
      organizationId: settings.organizationId,
      retailLocationId: settings.retailLocationId,
      workstationId: settings.workstationId,
      token: settings.installationToken
    }, { autoCommit: false });
    if (result.rowsAffected !== 1) {
      failure = new Error("Device token revalidation expected exactly one ENABLED or BLOCKED record. "
        + "Check the configured organization, store, register and existing installation token; authorize new devices in Xstore first.");
      throw failure;
    }
    stage = "commit";
    await connection.commit();
  } catch (error) {
    failure ??= new Error(`Device token revalidation failed during ${stage}${databaseError(error)}. Check the database settings and permissions.`);
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        failure = new Error(`${failure.message} Rollback also failed${databaseError(rollbackError)}.`);
      }
    }
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        failure = new Error(`${failure?.message ?? "Device token revalidation committed."} Database cleanup failed${databaseError(error)}.`);
      }
    }
  }
  if (failure) throw failure;
}
