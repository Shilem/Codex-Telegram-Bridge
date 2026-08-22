import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";

import { BridgeError } from "../core/types.js";
import {
  isTerminalRestartAction,
  readRestartAction,
  restartActionDirectory,
  restartActionFile,
  type RestartAction,
  type TerminalRestartAction,
  writeRestartAction,
} from "./restart-action-store.js";

export interface RestartManagerConfig {
  stateDirectory: string;
}

export interface RestartNotificationTarget {
  chatId: number;
  messageId: number;
  sourceUpdateId: number;
}

interface RestartManagerRuntime {
  platform: NodeJS.Platform;
  nodeExecutable: string;
  spawnProcess: typeof spawn;
  userId: number | undefined;
}

const TERMINAL_WAIT_MS = 5 * 60_000;
const SERVICE_LABEL = "com.shilem.codex-telegram-bridge";
const SYSTEMD_UNIT = "codex-telegram-bridge.service";
const WINDOWS_TASK = "CodexTelegramBridge";

export class RestartManager {
  readonly #launchingActionIds = new Set<string>();

  public constructor(
    private readonly config: RestartManagerConfig,
    private readonly logger: Logger,
    private readonly runtime: RestartManagerRuntime = {
      platform: process.platform,
      nodeExecutable: process.execPath,
      spawnProcess: spawn,
      userId: process.getuid?.(),
    },
  ) {}

  public async request(target: RestartNotificationTarget): Promise<RestartAction> {
    const activeAction = (await this.pendingActions()).find((action) => ["pending", "launching", "running"].includes(action.status));
    if (activeAction) throw new BridgeError("已有 Bridge 重启动作正在执行", "RESTART_ALREADY_RUNNING");
    const actionId = `ctb-restart-${randomUUID()}`;
    const action: RestartAction = {
      schemaVersion: 1,
      actionId,
      sourceUpdateId: target.sourceUpdateId,
      chatId: target.chatId,
      messageId: target.messageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      commands: this.#serviceCommands(),
      environment: this.#workerEnvironment(),
    };
    await writeRestartAction(restartActionFile(this.config.stateDirectory, actionId), action);
    this.logger.info({ actionId }, "已持久化 Bridge 重启动作，等待 Telegram offset 落账");
    return action;
  }

  public async launchAfterUpdateCommitted(actionId: string): Promise<RestartAction> {
    if (this.#launchingActionIds.has(actionId)) {
      return readRestartAction(restartActionFile(this.config.stateDirectory, actionId));
    }
    this.#launchingActionIds.add(actionId);
    try {
      return await this.#launch(actionId);
    } finally {
      this.#launchingActionIds.delete(actionId);
    }
  }

  async #launch(actionId: string): Promise<RestartAction> {
    const filePath = restartActionFile(this.config.stateDirectory, actionId);
    let action = await readRestartAction(filePath);
    if (action.status !== "pending") return action;
    action = { ...action, status: "launching", updatedAt: Date.now() };
    await writeRestartAction(filePath, action);

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const worker = resolve(packageRoot, "dist", "update", "restart-worker.js");
    let command: string;
    let args: string[];
    if (this.runtime.platform === "linux") {
      command = "systemd-run";
      args = ["--user", `--unit=${actionId}`, "--collect", "--", this.runtime.nodeExecutable, worker, filePath];
    } else if (this.runtime.platform === "darwin") {
      command = "launchctl";
      args = ["submit", "-l", `com.shilem.${actionId}`, "--", this.runtime.nodeExecutable, worker, filePath];
    } else if (this.runtime.platform === "win32") {
      const start = new Date(Date.now() + 60_000);
      const startTime = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      command = "schtasks.exe";
      args = ["/Create", "/SC", "ONCE", "/ST", startTime, "/TN", actionId, "/TR", [this.runtime.nodeExecutable, worker, filePath].map(quoteWindowsTaskArgument).join(" "), "/F"];
    } else {
      return this.#failLaunch(filePath, action, "当前平台不支持独立重启动作");
    }
    try {
      await this.#runLauncher(command, args, action.environment);
      if (this.runtime.platform === "win32") await this.#runLauncher("schtasks.exe", ["/Run", "/TN", actionId]);
      this.logger.info({ actionId }, "Telegram update 已落账，已启动独立 Bridge 重启 worker");
      return action;
    } catch (error) {
      return this.#failLaunch(filePath, action, `创建独立重启任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async pendingActions(): Promise<RestartAction[]> {
    let entries: string[];
    try {
      entries = await readdir(restartActionDirectory(this.config.stateDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const actions: RestartAction[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filePath = join(restartActionDirectory(this.config.stateDirectory), entry);
      try {
        actions.push(await readRestartAction(filePath));
      } catch (error) {
        this.logger.error({ file: entry, error: error instanceof Error ? error.message : String(error) }, "读取重启动作失败，保留文件等待人工检查");
      }
    }
    return actions;
  }

  public async cancelUncommitted(actionId: string): Promise<TerminalRestartAction> {
    const filePath = restartActionFile(this.config.stateDirectory, actionId);
    const action = await readRestartAction(filePath);
    if (isTerminalRestartAction(action)) return action;
    if (action.status !== "pending") {
      throw new BridgeError("重启动作已进入执行阶段，不能按未落账动作取消", "RESTART_ACTION_NOT_PENDING");
    }
    const cancelled: TerminalRestartAction = {
      ...action,
      status: "failed",
      updatedAt: Date.now(),
      result: { exitCode: null, reason: "Telegram update 未完成落账，已取消重启动作以避免重放" },
    };
    await writeRestartAction(filePath, cancelled);
    this.logger.warn({ actionId }, "已取消未落账的 Bridge 重启动作");
    return cancelled;
  }

  public async waitForTerminal(actionId: string): Promise<TerminalRestartAction> {
    const filePath = restartActionFile(this.config.stateDirectory, actionId);
    const deadline = Date.now() + TERMINAL_WAIT_MS;
    while (Date.now() < deadline) {
      const action = await readRestartAction(filePath);
      if (isTerminalRestartAction(action)) return action;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    const action = await readRestartAction(filePath);
    const timedOut: TerminalRestartAction = {
      ...action,
      status: "failed",
      updatedAt: Date.now(),
      result: { exitCode: null, reason: "独立重启任务超过五分钟未返回结果" },
    };
    await writeRestartAction(filePath, timedOut);
    return timedOut;
  }

  public async markNotified(actionId: string): Promise<void> {
    await rm(restartActionFile(this.config.stateDirectory, actionId), { force: true });
  }

  async #failLaunch(filePath: string, action: RestartAction, reason: string): Promise<TerminalRestartAction> {
    const failed: TerminalRestartAction = {
      ...action,
      status: "failed",
      updatedAt: Date.now(),
      result: { exitCode: null, reason },
    };
    await writeRestartAction(filePath, failed);
    this.logger.error({ actionId: action.actionId, error: reason }, "创建独立 Bridge 重启任务失败");
    return failed;
  }

  async #runLauncher(command: string, args: string[], environment?: Record<string, string>): Promise<void> {
    const child = this.runtime.spawnProcess(command, args, { ...(environment ? { env: environment } : {}), stdio: "ignore" });
    await new Promise<void>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new BridgeError(`exit ${String(code)}`, "RESTART_JOB_CREATE_FAILED"));
      });
    });
  }

  #serviceCommands(): RestartAction["commands"] {
    if (this.runtime.platform === "linux") {
      return [{ executable: "systemctl", args: ["--user", "restart", SYSTEMD_UNIT] }];
    }
    if (this.runtime.platform === "darwin") {
      if (!Number.isInteger(this.runtime.userId) || this.runtime.userId === undefined || this.runtime.userId < 0) {
        throw new BridgeError("无法获取当前 macOS 用户 ID，拒绝执行重启", "RESTART_USER_ID_UNAVAILABLE");
      }
      return [{ executable: "launchctl", args: ["kickstart", "-k", `gui/${this.runtime.userId}/${SERVICE_LABEL}`] }];
    }
    if (this.runtime.platform === "win32") {
      return [
        { executable: "schtasks.exe", args: ["/End", "/TN", WINDOWS_TASK] },
        { executable: "schtasks.exe", args: ["/Run", "/TN", WINDOWS_TASK] },
      ];
    }
    throw new BridgeError("当前平台不支持 Bridge 重启", "RESTART_PLATFORM_UNSUPPORTED");
  }

  #workerEnvironment(): Record<string, string> {
    const inheritedKeys = ["HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SystemRoot", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA"];
    const inherited = Object.fromEntries(inheritedKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
    const systemPath = process.env.PATH ?? process.env.Path ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    return { ...inherited, PATH: [dirname(this.runtime.nodeExecutable), systemPath].join(delimiter) };
  }
}

function quoteWindowsTaskArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
