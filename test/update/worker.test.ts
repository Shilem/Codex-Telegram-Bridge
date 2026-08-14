import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readUpdateAction, writeUpdateAction, type UpdateAction } from "../../src/update/action-store.js";
import { runUpdateWorker } from "../../src/update/worker.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(scriptBody: string): Promise<{ file: string; action: UpdateAction }> {
  const directory = await mkdtemp(join(tmpdir(), "ctb-update-worker-"));
  directories.push(directory);
  const script = join(directory, "update.sh");
  const file = join(directory, "state", "update-actions", "ctb-update-00000000-0000-0000-0000-000000000000.json");
  await writeFile(script, scriptBody, { mode: 0o700 });
  const action: UpdateAction = {
    schemaVersion: 1,
    actionId: "ctb-update-00000000-0000-0000-0000-000000000000",
    currentVersion: "1.0.0",
    expectedVersion: "1.1.0",
    chatId: 10,
    messageId: 20,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "pending",
    command: { executable: "/bin/bash", args: [script], environment: { PATH: "/usr/bin:/bin" } },
  };
  await writeUpdateAction(file, action);
  return { file, action };
}

describe("独立更新 worker", () => {
  it("原子记录成功终态", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { file } = await fixture("echo update-ok\n");
    await expect(runUpdateWorker(file)).resolves.toBe(0);
    await expect(readUpdateAction(file)).resolves.toMatchObject({
      status: "succeeded",
      result: { exitCode: 0, reason: "已安装 1.1.0 并通过健康检查" },
    });
  });

  it("保留明确错误并区分自动回滚", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { file } = await fixture("echo '[ctb] 错误：健康检查失败，已回滚到 1.0.0' >&2\nexit 1\n");
    await expect(runUpdateWorker(file)).resolves.toBe(1);
    await expect(readUpdateAction(file)).resolves.toMatchObject({
      status: "rolled_back",
      result: { exitCode: 1, reason: "[ctb] 错误：健康检查失败，已回滚到 1.0.0" },
    });
  });
});
