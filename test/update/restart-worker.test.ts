import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readRestartAction, writeRestartAction, type RestartAction } from "../../src/update/restart-action-store.js";
import { runRestartWorker } from "../../src/update/restart-worker.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("独立重启 worker", () => {
  it("按持久化顺序停止并启动服务，再记录成功终态", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-worker-"));
    directories.push(directory);
    const script = join(directory, "service-command.mjs");
    const output = join(directory, "commands.log");
    const file = join(directory, "state", "restart-actions", "ctb-restart-00000000-0000-0000-0000-000000000000.json");
    await writeFile(script, "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[3], `${process.argv[2]}\\n`);\n");
    const action: RestartAction = {
      schemaVersion: 1,
      actionId: "ctb-restart-00000000-0000-0000-0000-000000000000",
      chatId: 10,
      messageId: 20,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      commands: [
        { executable: process.execPath, args: [script, "stop", output] },
        { executable: process.execPath, args: [script, "start", output] },
      ],
      environment: { PATH: process.env.PATH ?? "" },
    };
    await writeRestartAction(file, action);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runRestartWorker(file)).resolves.toBe(0);
    await expect(readFile(output, "utf8")).resolves.toBe("stop\nstart\n");
    await expect(readRestartAction(file)).resolves.toMatchObject({
      status: "succeeded",
      result: { exitCode: 0, reason: "Bridge 服务已由服务管理器重启" },
    });
  });

  it("停止服务失败时不启动服务，并保留可执行原因", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-worker-failure-"));
    directories.push(directory);
    const failingScript = join(directory, "fail.mjs");
    const startScript = join(directory, "start.mjs");
    const output = join(directory, "started.log");
    const file = join(directory, "state", "restart-actions", "ctb-restart-00000000-0000-0000-0000-000000000000.json");
    await writeFile(failingScript, "process.stderr.write('restart-stop-failed\\n'); process.exit(2);\n");
    await writeFile(startScript, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'started');\n");
    await writeRestartAction(file, {
      schemaVersion: 1,
      actionId: "ctb-restart-00000000-0000-0000-0000-000000000000",
      chatId: 10,
      messageId: 20,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      commands: [
        { executable: process.execPath, args: [failingScript] },
        { executable: process.execPath, args: [startScript, output] },
      ],
      environment: { PATH: process.env.PATH ?? "" },
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runRestartWorker(file)).resolves.toBe(2);
    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readRestartAction(file)).resolves.toMatchObject({
      status: "failed",
      result: { exitCode: 2, reason: "restart-stop-failed" },
    });
  });
});
