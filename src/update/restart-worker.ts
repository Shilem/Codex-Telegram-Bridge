#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../core/types.js";
import { readRestartAction, writeRestartAction, type RestartAction } from "./restart-action-store.js";

const MAX_DIAGNOSTIC_CHARS = 8_000;

function appendDiagnostic(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

function extractReason(diagnostic: string, exitCode: number | null): string {
  const lines = diagnostic.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? `独立重启任务异常退出（exit ${String(exitCode)}）`).slice(0, 500);
}

async function persistTerminal(
  filePath: string,
  action: RestartAction,
  exitCode: number | null,
  reason: string,
): Promise<void> {
  await writeRestartAction(filePath, {
    ...action,
    status: exitCode === 0 ? "succeeded" : "failed",
    updatedAt: Date.now(),
    result: { exitCode, reason },
  });
}

async function runCommand(
  command: RestartAction["commands"][number],
  environment: RestartAction["environment"],
): Promise<{ exitCode: number | null; diagnostic: string }> {
  let diagnostic = "";
  const child = spawn(command.executable, command.args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => {
    diagnostic = appendDiagnostic(diagnostic, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = appendDiagnostic(diagnostic, chunk);
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", resolveChild);
  });
  return { exitCode, diagnostic };
}

export async function runRestartWorker(filePath: string): Promise<number> {
  let action = await readRestartAction(filePath);
  action = { ...action, status: "running", updatedAt: Date.now() };
  await writeRestartAction(filePath, action);
  try {
    for (const command of action.commands) {
      const { exitCode, diagnostic } = await runCommand(command, action.environment);
      if (exitCode !== 0) {
        const reason = extractReason(diagnostic, exitCode);
        await persistTerminal(filePath, action, exitCode, reason);
        return exitCode ?? 1;
      }
    }
    await persistTerminal(filePath, action, 0, "Bridge 服务已由服务管理器重启");
    return 0;
  } catch (error) {
    await persistTerminal(filePath, action, null, errorMessage(error));
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const actionFile = process.argv[2];
  if (!actionFile) {
    process.stderr.write("重启 worker 缺少动作文件\n");
    process.exitCode = 2;
  } else {
    void runRestartWorker(actionFile)
      .then((exitCode) => { process.exitCode = exitCode; })
      .catch((error: unknown) => {
        process.stderr.write(`重启 worker 失败：${errorMessage(error)}\n`);
        process.exitCode = 1;
      });
  }
}
