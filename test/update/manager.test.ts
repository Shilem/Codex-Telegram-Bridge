import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { updateActionFile, writeUpdateAction } from "../../src/update/action-store.js";
import { UpdateManager } from "../../src/update/manager.js";

function config(directory: string) {
  return {
    currentVersion: "1.0.0",
    manifestUrl: "https://example.test/manifest.json",
    signatureUrl: "https://example.test/manifest.sig",
    archiveUrl: "https://example.test/release.tgz",
    publicKeyFile: join(directory, "public.pem"),
    stateDirectory: join(directory, "state"),
    configFile: join(directory, "config", "config.json"),
    codexExecutable: "/opt/codex/bin/codex",
    installRoot: join(directory, "install"),
    binDirectory: join(directory, "bin"),
  };
}

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("UpdateManager", () => {
  it("验证远端签名、版本递增和产物名称", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-update-manager-"));
    directories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(directory, "public.pem");
    await writeFile(keyFile, publicKey.export({ format: "pem", type: "spki" }));
    const manifest = Buffer.from(JSON.stringify({ version: "1.0.1", archive: "release.tgz", sha256: "a".repeat(64) }));
    const signature = sign("sha256", manifest, privateKey);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(
      url.endsWith(".sig") ? signature : manifest,
      { status: 200 },
    ))));
    const manager = new UpdateManager({ ...config(directory), publicKeyFile: keyFile }, pino({ level: "silent" }));
    await expect(manager.check()).resolves.toMatchObject({ version: "1.0.1" });
  });

  it("拒绝明文更新地址", () => {
    expect(() => new UpdateManager({
      ...config("/tmp/ctb-update-insecure"),
      manifestUrl: "http://example.test/manifest.json",
    }, pino({ level: "silent" }))).toThrow("HTTPS");
  });

  it("Linux 独立任务固定使用当前 Node 24 worker 和白名单安装环境", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-update-manager-launch-"));
    directories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(join(directory, "public.pem"), publicKey.export({ format: "pem", type: "spki" }));
    const manifest = Buffer.from(JSON.stringify({ version: "1.1.0", archive: "release.tgz", sha256: "a".repeat(64) }));
    const signature = sign("sha256", manifest, privateKey);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(url.endsWith(".sig") ? signature : manifest, { status: 200 }))));
    const launched: Array<{ command: string; args: readonly string[] }> = [];
    const spawnProcess = ((command: string, args: readonly string[]) => {
      launched.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    }) as unknown as typeof spawn;
    const manager = new UpdateManager(config(directory), pino({ level: "silent" }), {
      platform: "linux",
      nodeExecutable: "/opt/node24/bin/node",
      spawnProcess,
    });

    const action = await manager.install("1.1.0", { chatId: 10, messageId: 20 });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.command).toBe("systemd-run");
    expect(launched[0]?.args).toContain("/opt/node24/bin/node");
    expect(launched[0]?.args.some((value) => value.replaceAll("\\", "/").endsWith("/dist/update/worker.js"))).toBe(true);
    expect(action.command.environment).toMatchObject({
      CTB_NODE_BIN: "/opt/node24/bin/node",
      CTB_CODEX_BIN: "/opt/codex/bin/codex",
      CTB_INSTALL_ROOT: join(directory, "install"),
      CTB_CONFIG_FILE: join(directory, "config", "config.json"),
      CTB_STATE_DIR: join(directory, "state"),
    });
    await expect(manager.pendingActions()).resolves.toEqual([expect.objectContaining({
      actionId: action.actionId,
      status: "pending",
      chatId: 10,
      messageId: 20,
    })]);
    await writeUpdateAction(updateActionFile(config(directory).stateDirectory, action.actionId), {
      ...action,
      status: "succeeded",
      updatedAt: action.updatedAt + 1_000,
      result: { exitCode: 0, reason: "健康检查通过" },
    });
    await expect(manager.waitForTerminal(action.actionId)).resolves.toMatchObject({ status: "succeeded" });
    await manager.markNotified(action.actionId);
    await expect(manager.pendingActions()).resolves.toEqual([]);
  });
});
