import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { TestContext } from "node:test";

export async function workspace(t: TestContext): Promise<string> {
  const root = resolve("reports");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
