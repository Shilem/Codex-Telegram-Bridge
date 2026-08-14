#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { z } from "zod";

import { loadConfig, readBotToken } from "./core/config.js";
import { errorMessage } from "./core/types.js";
import { RuntimeSettings } from "./runtime/settings.js";
import { PairingService, ProjectRegistry } from "./security/index.js";
import { shortProjectId } from "./security/projects.js";
import { BridgeDatabase } from "./storage/index.js";

const VERSION = "1.1.0";
process.umask(0o077);

async function openDatabase(): Promise<{ database: BridgeDatabase; config: Awaited<ReturnType<typeof loadConfig>> }> {
  const config = await loadConfig();
  return { database: new BridgeDatabase(join(config.stateDirectory, "bridge.db")), config };
}

function runBundledScript(name: string, args: string[]): never {
  const script = process.env.CTB_SCRIPT_ROOT
    ? join(process.env.CTB_SCRIPT_ROOT, name)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", name);
  if (!existsSync(script)) throw new Error(`找不到发布脚本：${script}`);
  const command = process.platform === "win32" ? "powershell.exe" : "bash";
  const commandArgs = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]
    : [script, ...args];
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const program = new Command()
  .name("ctb")
  .description("Codex Telegram Bridge 主机管理工具")
  .version(VERSION);

program.command("pair")
  .argument("<code>", "Telegram /start 返回的十分钟配对码")
  .description("在本机确认唯一所有者")
  .action(async (code: string) => {
    const { database } = await openDatabase();
    try {
      const owner = new PairingService(database).confirmCode(code);
      process.stdout.write(`配对完成：owner=${owner.id}\n`);
    } finally {
      database.close();
    }
  });

const project = program.command("project").description("管理本机预注册项目");
project.command("add")
  .argument("<path>")
  .requiredOption("--name <name>")
  .description("注册项目根目录")
  .action(async (path: string, options: { name: string }) => {
    const { database } = await openDatabase();
    try {
      const added = new ProjectRegistry(database).register(path, options.name);
      const settings = new RuntimeSettings(database);
      if (!settings.get("active_project_id")) settings.set("active_project_id", added.id);
      process.stdout.write(`${shortProjectId(added.id)}\t${added.name}\t${added.normalizedRoot}\n`);
    } finally {
      database.close();
    }
  });
project.command("list")
  .option("--all", "同时显示已禁用项目")
  .description("列出注册项目")
  .action(async (options: { all?: boolean }) => {
    const { database } = await openDatabase();
    try {
      const rows = database.connection.prepare(`SELECT id, name, normalized_root, enabled FROM projects ${options.all ? "" : "WHERE enabled = 1"} ORDER BY name`).all() as Array<{ id: string; name: string; normalized_root: string; enabled: number }>;
      for (const row of rows) process.stdout.write(`${shortProjectId(row.id)}\t${row.enabled ? "enabled" : "disabled"}\t${row.name}\t${row.normalized_root}\n`);
    } finally {
      database.close();
    }
  });
project.command("disable")
  .argument("<id>")
  .description("禁用项目，不删除历史")
  .action(async (id: string) => {
    const { database } = await openDatabase();
    try {
      const projects = new ProjectRegistry(database);
      const resolvedId = projects.resolveId(id);
      projects.disable(resolvedId);
      process.stdout.write(`项目已禁用：${shortProjectId(resolvedId)}\n`);
    } finally {
      database.close();
    }
  });
project.command("remove")
  .argument("<id>")
  .description("移除无历史引用的已禁用项目")
  .action(async (id: string) => {
    const { database } = await openDatabase();
    try {
      const projects = new ProjectRegistry(database);
      const resolvedId = projects.resolveId(id);
      projects.remove(resolvedId);
      process.stdout.write(`项目已移除：${shortProjectId(resolvedId)}\n`);
    } finally {
      database.close();
    }
  });

program.command("doctor")
  .description("检查 Node、Codex App Server、配置、数据库、项目和磁盘")
  .action(async () => {
    const checks: Array<[string, boolean, string]> = [];
    checks.push(["Node.js", Number(process.versions.node.split(".")[0]) === 24, process.version]);
    const { database, config } = await openDatabase();
    try {
      try {
        await readBotToken(config);
        checks.push(["Bot Token", true, "格式与权限正常"]);
      } catch (error) {
        checks.push(["Bot Token", false, errorMessage(error)]);
      }
      const codex = spawnSync(config.codexExecutable, ["app-server", "--help"], { encoding: "utf8", timeout: 10_000 });
      checks.push(["Codex App Server", codex.status === 0, codex.status === 0 ? "能力探测通过" : codex.stderr.trim() || "探测失败"]);
      const quickCheck = database.connection.pragma("quick_check", { simple: true });
      checks.push(["SQLite", quickCheck === "ok", String(quickCheck)]);
      const projects = database.connection.prepare("SELECT COUNT(*) AS count FROM projects WHERE enabled = 1").get() as { count: number };
      checks.push(["项目", true, projects.count > 0 ? `${projects.count} 个可用项目` : "待设置：请运行 ctb project add"]);
      const owner = new PairingService(database).activeOwner();
      checks.push(["所有者", true, owner ? "已完成本机配对" : "待设置：等待 /start 与 ctb pair"]);
    } finally {
      database.close();
    }
    for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? "✓" : "✗"} ${name}：${detail}\n`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  });

const migrate = program.command("migrate").description("导入旧版桥接数据");
migrate.command("legacy")
  .requiredOption("--report <path>")
  .description("从脱敏迁移报告导入工作目录与 Telegram offset")
  .action(async (options: { report: string }) => {
    const schema = z.object({
      schemaVersion: z.literal(1),
      legacy: z.object({ chatId: z.string().min(1), workdir: z.string().min(1), telegramOffset: z.number().int().nonnegative() }),
      requiresLocalPairing: z.literal(true),
    });
    const report = schema.parse(JSON.parse(await readFile(options.report, "utf8")) as unknown);
    const { database } = await openDatabase();
    try {
      const projects = new ProjectRegistry(database);
      const existing = database.connection.prepare("SELECT id FROM projects WHERE normalized_root = ?").get(resolve(report.legacy.workdir)) as { id: string } | undefined;
      const registered = existing ? projects.require(existing.id) : projects.register(report.legacy.workdir, "迁移的默认项目");
      const settings = new RuntimeSettings(database);
      settings.set("active_project_id", registered.id);
      settings.set("telegram_offset", String(report.legacy.telegramOffset));
      settings.set("legacy_chat_id_fingerprint", report.legacy.chatId.slice(-4));
      process.stdout.write(`迁移报告已导入；项目=${registered.id}，offset=${report.legacy.telegramOffset}。仍需本机配对。\n`);
    } finally {
      database.close();
    }
  });

program.command("update")
  .requiredOption("--manifest <url>")
  .requiredOption("--signature <url>")
  .requiredOption("--archive <url>")
  .requiredOption("--public-key <path>")
  .description("下载并验证签名版本后原子升级")
  .action((options: { manifest: string; signature: string; archive: string; publicKey: string }) => runBundledScript(
    process.platform === "win32" ? "update.ps1" : "update.sh",
    process.platform === "win32"
      ? ["-Manifest", options.manifest, "-Signature", options.signature, "-Archive", options.archive, "-PublicKey", options.publicKey]
      : ["--manifest", options.manifest, "--signature", options.signature, "--archive", options.archive, "--public-key", options.publicKey],
  ));
program.command("rollback").argument("[version]").description("回滚到上一版本或指定版本").action((version?: string) => runBundledScript(process.platform === "win32" ? "rollback-version.ps1" : "rollback-version.sh", version ? [version] : []));
program.command("uninstall").option("--purge-data", "同时删除本地数据").description("卸载服务，默认保留数据").action((options: { purgeData?: boolean }) => runBundledScript(process.platform === "win32" ? "uninstall.ps1" : "uninstall.sh", options.purgeData ? [process.platform === "win32" ? "-PurgeData" : "--purge-data"] : []));

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`ctb 失败：${errorMessage(error)}\n`);
  if (process.env.CTB_DEBUG === "1") process.stderr.write(`${error instanceof Error ? error.stack : ""}\n`);
  process.exitCode = 1;
});
