import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { restartActionFile, writeRestartAction } from "../../src/update/restart-action-store.js";
import { RestartManager } from "../../src/update/restart-manager.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RestartManager", () => {
  it("在 Telegram offset 落账前只持久化 Linux 重启动作，落账后才启动独立 worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-"));
    directories.push(directory);
    const launched: Array<{ command: string; args: readonly string[]; environment: NodeJS.ProcessEnv | undefined }> = [];
    const spawnProcess = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      launched.push({ command, args, environment: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    }) as unknown as typeof spawn;
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "linux",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess,
      userId: 501,
    });

    const action = await manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 });

    expect(launched).toHaveLength(0);
    await expect(manager.pendingActions()).resolves.toEqual([expect.objectContaining({
      actionId: action.actionId,
      status: "pending",
      chatId: 10,
      messageId: 20,
    })]);
    await manager.launchAfterUpdateCommitted(action.actionId);

    expect(launched).toHaveLength(1);
    expect(launched[0]?.command).toBe("systemd-run");
    expect(launched[0]?.args).toContain("/opt/node24/bin/node");
    expect(launched[0]?.environment).toMatchObject(action.environment);
    expect(launched[0]?.args.some((value) => value.replaceAll("\\", "/").endsWith("/dist/update/restart-worker.js"))).toBe(true);
    expect(action.commands).toEqual([{
      executable: "systemctl",
      args: ["--user", "restart", "codex-telegram-bridge.service"],
    }]);
    await writeRestartAction(restartActionFile(join(directory, "state"), action.actionId), {
      ...action,
      status: "succeeded",
      updatedAt: action.updatedAt + 1_000,
      result: { exitCode: 0, reason: "Bridge 服务已重启" },
    });
    await expect(manager.waitForTerminal(action.actionId)).resolves.toMatchObject({ status: "succeeded" });
    await manager.markNotified(action.actionId);
    await expect(manager.pendingActions()).resolves.toEqual([]);
  });

  it("macOS 使用当前用户域的 launchctl kickstart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-macos-"));
    directories.push(directory);
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "darwin",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess: (() => new EventEmitter()) as unknown as typeof spawn,
      userId: 501,
    });

    await expect(manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 })).resolves.toMatchObject({
      commands: [{
        executable: "launchctl",
        args: ["kickstart", "-k", "gui/501/com.shilem.codex-telegram-bridge"],
      }],
    });
  });

  it("Linux worker 继承 user systemd bus 所需环境", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/501");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/501/bus");
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-linux-env-"));
    directories.push(directory);
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "linux",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess: (() => new EventEmitter()) as unknown as typeof spawn,
      userId: 501,
    });

    await expect(manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 })).resolves.toMatchObject({
      environment: {
        XDG_RUNTIME_DIR: "/run/user/501",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      },
    });
  });

  it("待提交的重启动作也拒绝重复请求", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-duplicate-"));
    directories.push(directory);
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "linux",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess: (() => new EventEmitter()) as unknown as typeof spawn,
      userId: 501,
    });

    await manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 });
    await expect(manager.request({ chatId: 10, messageId: 21, sourceUpdateId: 2 })).rejects.toMatchObject({ code: "RESTART_ALREADY_RUNNING" });
  });

  it("取消未落账动作后允许重新请求重启", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-uncommitted-"));
    directories.push(directory);
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "linux",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess: (() => new EventEmitter()) as unknown as typeof spawn,
      userId: 501,
    });
    const action = await manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 });
    const cancellable = manager as unknown as {
      cancelUncommitted(actionId: string): Promise<{ status: string; result: { reason: string } }>;
    };

    const cancelled = await cancellable.cancelUncommitted(action.actionId);
    expect(cancelled.status).toBe("failed");
    expect(cancelled.result.reason).toContain("未完成落账");
    await expect(manager.request({ chatId: 10, messageId: 21, sourceUpdateId: 2 })).resolves.toMatchObject({ status: "pending" });
  });

  it("Windows 先结束当前计划任务，再启动同一任务", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-restart-manager-windows-"));
    directories.push(directory);
    const manager = new RestartManager({ stateDirectory: join(directory, "state") }, pino({ level: "silent" }), {
      platform: "win32",
      nodeExecutable: "C:\\node\\node.exe",
      spawnProcess: (() => new EventEmitter()) as unknown as typeof spawn,
      userId: undefined,
    });

    await expect(manager.request({ chatId: 10, messageId: 20, sourceUpdateId: 1 })).resolves.toMatchObject({
      commands: [
        { executable: "schtasks.exe", args: ["/End", "/TN", "CodexTelegramBridge"] },
        { executable: "schtasks.exe", args: ["/Run", "/TN", "CodexTelegramBridge"] },
      ],
    });
  });
});
