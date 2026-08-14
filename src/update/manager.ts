import { spawn } from "node:child_process";
import { verify } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { z } from "zod";

import { BridgeError } from "../core/types.js";
import {
  isTerminalUpdateAction,
  readUpdateAction,
  updateActionDirectory,
  updateActionFile,
  writeUpdateAction,
  type TerminalUpdateAction,
  type UpdateAction,
} from "./action-store.js";
import { assertUpgradeOnly } from "./verifier.js";

const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  archive: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export interface UpdateCandidate {
  version: string;
  archive: string;
  sha256: string;
}

export interface UpdateManagerConfig {
  currentVersion: string;
  manifestUrl: string;
  signatureUrl: string;
  archiveUrl: string;
  publicKeyFile: string;
  stateDirectory: string;
  configFile: string;
  codexExecutable: string;
  installRoot: string;
  binDirectory: string;
}

export interface UpdateNotificationTarget {
  chatId: number;
  messageId: number;
}

interface UpdateManagerRuntime {
  platform: NodeJS.Platform;
  nodeExecutable: string;
  spawnProcess: typeof spawn;
}

const TERMINAL_WAIT_MS = 30 * 60_000;

function requireHttps(value: string): void {
  if (!value.startsWith("https://")) throw new BridgeError("更新地址必须使用 HTTPS", "UPDATE_URL_INSECURE");
}

export class UpdateManager {
  public constructor(
    private readonly config: UpdateManagerConfig,
    private readonly logger: Logger,
    private readonly runtime: UpdateManagerRuntime = {
      platform: process.platform,
      nodeExecutable: process.execPath,
      spawnProcess: spawn,
    },
  ) {
    requireHttps(config.manifestUrl);
    requireHttps(config.signatureUrl);
    requireHttps(config.archiveUrl);
  }

  public async check(): Promise<UpdateCandidate> {
    const [manifestResponse, signatureResponse, publicKey] = await Promise.all([
      fetch(this.config.manifestUrl),
      fetch(this.config.signatureUrl),
      readFile(this.config.publicKeyFile),
    ]);
    if (!manifestResponse.ok || !signatureResponse.ok) {
      throw new BridgeError("无法下载更新清单或签名", "UPDATE_METADATA_DOWNLOAD_FAILED");
    }
    const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
    const signature = Buffer.from(await signatureResponse.arrayBuffer());
    if (!verify("sha256", manifestBytes, publicKey, signature)) {
      throw new BridgeError("更新清单签名无效", "UPDATE_SIGNATURE_INVALID");
    }
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    assertUpgradeOnly(this.config.currentVersion, manifest.version);
    const archiveName = new URL(this.config.archiveUrl).pathname.split("/").at(-1);
    if (archiveName !== manifest.archive) {
      throw new BridgeError("更新产物名称与签名清单不一致", "UPDATE_ARCHIVE_MISMATCH");
    }
    return manifest;
  }

  public async install(expectedVersion: string, target: UpdateNotificationTarget): Promise<UpdateAction> {
    const activeAction = (await this.pendingActions()).find((action) => action.status === "pending" || action.status === "running");
    if (activeAction) {
      throw new BridgeError(`已有 ${activeAction.expectedVersion} 更新正在执行`, "UPDATE_ALREADY_RUNNING");
    }
    const current = await this.check();
    if (current.version !== expectedVersion) {
      throw new BridgeError("更新按钮已过期，远端最新版本已变化", "UPDATE_ACTION_STALE");
    }
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const scriptRoot = resolve(packageRoot, "scripts");
    const windows = this.runtime.platform === "win32";
    const script = resolve(scriptRoot, windows ? "update.ps1" : "update.sh");
    const args = windows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Manifest", this.config.manifestUrl, "-Signature", this.config.signatureUrl, "-Archive", this.config.archiveUrl, "-PublicKey", this.config.publicKeyFile, "-InstallRoot", this.config.installRoot, "-ConfigDir", dirname(this.config.configFile), "-StateDir", this.config.stateDirectory, "-NodePath", this.runtime.nodeExecutable, "-CodexPath", this.config.codexExecutable]
      : [script, "--manifest", this.config.manifestUrl, "--signature", this.config.signatureUrl, "--archive", this.config.archiveUrl, "--public-key", this.config.publicKeyFile];
    const actionId = `ctb-update-${randomUUID()}`;
    const actionFile = updateActionFile(this.config.stateDirectory, actionId);
    const environment = this.#workerEnvironment();
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const action: UpdateAction = {
      schemaVersion: 1,
      actionId,
      currentVersion: this.config.currentVersion,
      expectedVersion,
      chatId: target.chatId,
      messageId: target.messageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      command: {
        executable: windows ? powershell : "/bin/bash",
        args,
        environment,
      },
    };
    await writeUpdateAction(actionFile, action);
    const worker = resolve(packageRoot, "dist", "update", "worker.js");
    let command: string;
    let commandArgs: string[];
    if (this.runtime.platform === "linux") {
      command = "systemd-run";
      commandArgs = ["--user", `--unit=${actionId}`, "--collect", "--", this.runtime.nodeExecutable, worker, actionFile];
    } else if (this.runtime.platform === "darwin") {
      command = "launchctl";
      commandArgs = ["submit", "-l", `com.shilem.${actionId}`, "--", this.runtime.nodeExecutable, worker, actionFile];
    } else if (windows) {
      const start = new Date(Date.now() + 60_000);
      const startTime = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      command = "schtasks.exe";
      commandArgs = ["/Create", "/SC", "ONCE", "/ST", startTime, "/TN", actionId, "/TR", [this.runtime.nodeExecutable, worker, actionFile].map(quoteWindowsTaskArgument).join(" "), "/F"];
    } else {
      throw new BridgeError("当前平台不支持独立更新任务", "UPDATE_PLATFORM_UNSUPPORTED");
    }
    try {
      await this.#runLauncher(command, commandArgs);
      if (windows) await this.#runLauncher("schtasks.exe", ["/Run", "/TN", actionId]);
    } catch (error) {
      const failed: UpdateAction = {
        ...action,
        status: "failed",
        updatedAt: Date.now(),
        result: { exitCode: null, reason: `创建独立更新任务失败：${error instanceof Error ? error.message : String(error)}` },
      };
      await writeUpdateAction(actionFile, failed);
      this.logger.error({ actionId, version: expectedVersion, error: failed.result?.reason }, "创建独立更新任务失败");
      return failed;
    }
    this.logger.info({ actionId, version: expectedVersion }, "已持久化一次性更新动作并启动签名更新");
    return action;
  }

  public async pendingActions(): Promise<UpdateAction[]> {
    let entries: string[];
    try {
      entries = await readdir(updateActionDirectory(this.config.stateDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const actions: UpdateAction[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filePath = join(updateActionDirectory(this.config.stateDirectory), entry);
      try {
        actions.push(await readUpdateAction(filePath));
      } catch (error) {
        this.logger.error({ file: entry, error: error instanceof Error ? error.message : String(error) }, "读取更新动作失败，保留文件等待人工检查");
      }
    }
    return actions;
  }

  public async waitForTerminal(actionId: string): Promise<TerminalUpdateAction> {
    const filePath = updateActionFile(this.config.stateDirectory, actionId);
    const deadline = Date.now() + TERMINAL_WAIT_MS;
    while (Date.now() < deadline) {
      const action = await readUpdateAction(filePath);
      if (isTerminalUpdateAction(action)) return action;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    const action = await readUpdateAction(filePath);
    const timedOut: TerminalUpdateAction = {
      ...action,
      status: "failed",
      updatedAt: Date.now(),
      result: { exitCode: null, reason: "独立更新任务超过三十分钟未返回结果" },
    };
    await writeUpdateAction(filePath, timedOut);
    return timedOut;
  }

  public async markNotified(actionId: string): Promise<void> {
    await rm(updateActionFile(this.config.stateDirectory, actionId), { force: true });
  }

  async #runLauncher(command: string, args: string[]): Promise<void> {
    const child = this.runtime.spawnProcess(command, args, { stdio: "ignore" });
    await new Promise<void>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new BridgeError(`exit ${String(code)}`, "UPDATE_JOB_CREATE_FAILED"));
      });
    });
  }

  #workerEnvironment(): Record<string, string> {
    const inheritedKeys = ["HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA"];
    const inherited = Object.fromEntries(inheritedKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
    const systemPath = process.env.PATH ?? process.env.Path ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const path = [dirname(this.runtime.nodeExecutable), dirname(this.config.codexExecutable), systemPath].join(delimiter);
    return {
      ...inherited,
      PATH: path,
      CTB_NODE_BIN: this.runtime.nodeExecutable,
      CTB_CODEX_BIN: this.config.codexExecutable,
      CTB_INSTALL_ROOT: this.config.installRoot,
      CTB_BIN_DIR: this.config.binDirectory,
      CTB_CONFIG_DIR: dirname(this.config.configFile),
      CTB_CONFIG_FILE: this.config.configFile,
      CTB_STATE_DIR: this.config.stateDirectory,
    };
  }
}

function quoteWindowsTaskArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
