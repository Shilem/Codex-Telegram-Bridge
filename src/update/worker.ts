#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../core/types.js";
import { readUpdateAction, writeUpdateAction, type UpdateAction } from "./action-store.js";

const MAX_DIAGNOSTIC_CHARS = 8_000;

function appendDiagnostic(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

function extractReason(diagnostic: string, exitCode: number | null): string {
  const lines = diagnostic.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const explicit = [...lines].reverse().find((line) =>
    line.includes("[ctb] 错误：") ||
    line.includes("Codex Telegram Bridge：") ||
    line.includes("已回滚"),
  );
  return (explicit ?? `独立更新任务异常退出（exit ${String(exitCode)}）`).slice(0, 500);
}

async function persistTerminal(
  filePath: string,
  action: UpdateAction,
  status: "succeeded" | "failed" | "rolled_back",
  exitCode: number | null,
  reason: string,
): Promise<void> {
  await writeUpdateAction(filePath, {
    ...action,
    status,
    updatedAt: Date.now(),
    result: { exitCode, reason },
  });
}

export async function runUpdateWorker(filePath: string): Promise<number> {
  let action = await readUpdateAction(filePath);
  action = { ...action, status: "running", updatedAt: Date.now() };
  await writeUpdateAction(filePath, action);

  let diagnostic = "";
  try {
    const child = spawn(action.command.executable, action.command.args, {
      env: action.command.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      diagnostic = appendDiagnostic(diagnostic, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = appendDiagnostic(diagnostic, chunk);
      process.stderr.write(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (exitCode === 0) {
      await persistTerminal(filePath, action, "succeeded", exitCode, `已安装 ${action.expectedVersion} 并通过健康检查`);
      return 0;
    }
    const reason = extractReason(diagnostic, exitCode);
    await persistTerminal(filePath, action, reason.includes("已回滚") ? "rolled_back" : "failed", exitCode, reason);
    return exitCode ?? 1;
  } catch (error) {
    await persistTerminal(filePath, action, "failed", null, errorMessage(error));
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const actionFile = process.argv[2];
  if (!actionFile) {
    process.stderr.write("更新 worker 缺少动作文件\n");
    process.exitCode = 2;
  } else {
    void runUpdateWorker(actionFile)
      .then((exitCode) => { process.exitCode = exitCode; })
      .catch((error: unknown) => {
        process.stderr.write(`更新 worker 失败：${errorMessage(error)}\n`);
        process.exitCode = 1;
      });
  }
}
