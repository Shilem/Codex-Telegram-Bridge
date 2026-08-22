#!/usr/bin/env node
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AppServerClient, CodexModelStateProvider, CodexRateLimitProvider, ProcessAppServerTransport } from "./app-server/index.js";
import { defaultRuntimePaths, loadConfig, readBotToken } from "./core/config.js";
import { acquireInstanceLock } from "./core/instance-lock.js";
import { createLogger } from "./core/logger.js";
import { errorMessage } from "./core/types.js";
import { VERSION } from "./core/version.js";
import { MediaManager } from "./media/manager.js";
import { AppServerTaskExecutor } from "./orchestrator/app-task-executor.js";
import { RuntimeStoreAdapter } from "./runtime/store-adapter.js";
import { cleanupDatabase } from "./runtime/maintenance.js";
import { loadOrCreateSecret } from "./runtime/secrets.js";
import { RuntimeSettings } from "./runtime/settings.js";
import { TaskScheduler } from "./scheduler/task-scheduler.js";
import { ApprovalManager, AuditLog, PairingService } from "./security/index.js";
import { BridgeDatabase } from "./storage/index.js";
import { TelegramApi } from "./telegram/api.js";
import { TELEGRAM_COMMANDS } from "./telegram/commands.js";
import { TelegramController, type HealthProvider } from "./telegram/controller.js";
import { TelegramInteractiveGateway } from "./telegram/gateway.js";
import { UpdateManager } from "./update/manager.js";
import { RestartManager } from "./update/restart-manager.js";

process.umask(0o077);

function renderModelCatalogHealth(health: ReturnType<CodexModelStateProvider["health"]>): string {
  if (health.lastSuccessfulReadAt === null) return "尚未成功读取";
  const readAt = new Date(health.lastSuccessfulReadAt).toLocaleString("zh-CN", { hour12: false });
  if (health.lastRefreshWarningAt === null) return `正常（最后读取 ${readAt}）`;
  const warningAt = new Date(health.lastRefreshWarningAt).toLocaleString("zh-CN", { hour12: false });
  return `可用但刷新有告警（最后读取 ${readAt}，告警 ${warningAt}）`;
}

async function main(): Promise<void> {
  const runtimePaths = defaultRuntimePaths();
  const config = await loadConfig(runtimePaths.configFile);
  const logger = createLogger(config.logLevel);
  const releaseLock = await acquireInstanceLock(join(config.stateDirectory, "service.lock"));
  const database = new BridgeDatabase(join(config.stateDirectory, "bridge.db"));
  const recovery = database.recoverInterruptedWork();
  if (recovery.tasks || recovery.updates) {
    logger.warn(recovery, "检测到上次崩溃，未完成工作已标记为 unknown，禁止自动重放");
  }
  const runtimeStore = new RuntimeStoreAdapter(database);
  const pairing = new PairingService(database);
  const owner = pairing.activeOwner();
  if (owner) runtimeStore.setOwnerId(owner.id);
  const approvalKey = await loadOrCreateSecret(join(config.stateDirectory, "approval-key"), 32);
  const auditSalt = await loadOrCreateSecret(join(config.stateDirectory, "audit-salt"), 32);
  const approvals = new ApprovalManager(database, approvalKey);
  const audit = new AuditLog(database, auditSalt);
  const token = await readBotToken(config);
  const telegram = new TelegramApi(token, logger);
  void telegram.setCommands(TELEGRAM_COMMANDS).then(() => {
    logger.info({ commandCount: TELEGRAM_COMMANDS.length }, "Telegram 私聊命令菜单已同步");
  }).catch((error: unknown) => {
    logger.error({ error: errorMessage(error), commandCount: TELEGRAM_COMMANDS.length }, "Telegram 私聊命令菜单同步失败；核心服务继续运行，下次重启将重试");
  });
  const media = new MediaManager(
    config.stateDirectory,
    config.artifactDirectory,
    {
      attachmentRetentionMs: config.attachmentRetentionHours * 3_600_000,
      artifactRetentionMs: config.attachmentRetentionHours * 3_600_000,
    },
    logger,
  );
  await media.initialize();
  await media.cleanup();
  cleanupDatabase(database, config.taskRetentionDays * 86_400_000, config.auditRetentionDays * 86_400_000);
  const gateway = new TelegramInteractiveGateway(
    telegram,
    owner ? Number(owner.privateChatId) : 0,
    approvals,
    media,
    config.outboundFileLimitBytes,
    logger,
  );
  const appServer = new AppServerClient({
    logger,
    transport: new ProcessAppServerTransport({
      command: config.codexExecutable,
      args: ["app-server", "--listen", "stdio://"],
    }),
    clientInfo: { name: "codex-telegram-bridge", title: "Codex Telegram Bridge", version: VERSION },
  });
  await appServer.start();
  const models = new CodexModelStateProvider(appServer, logger);
  const quota = new CodexRateLimitProvider(appServer);
  void models.list().then((available) => {
    logger.info({ modelCount: available.length }, "Codex 本机模型目录读取成功");
  }).catch((error: unknown) => {
    logger.error({ error: errorMessage(error) }, "Codex 本机模型目录首次读取失败");
  });
  appServer.onFatal((error) => {
    logger.fatal({ error: error.message }, "App Server 已失效，退出并交由服务管理器重启");
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
  const executor = new AppServerTaskExecutor(appServer, runtimeStore, gateway, logger);
  const scheduler = new TaskScheduler(runtimeStore, executor, logger);
  scheduler.wake();

  const startedAt = Date.now();
  const health: HealthProvider = {
    async render(): Promise<string> {
      const projectCount = database.connection.prepare("SELECT COUNT(*) AS count FROM projects WHERE enabled = 1").get() as { count: number };
      const disk = await statfs(config.stateDirectory);
      const freeBytes = disk.bavail * disk.bsize;
      const databaseOk = database.connection.pragma("quick_check", { simple: true }) === "ok";
      let loginDetail = "未检查";
      let loggedIn = false;
      try {
        const account = await appServer.request<{ account: object | null; requiresOpenaiAuth: boolean }>("account/read", {});
        loggedIn = account.account !== null || !account.requiresOpenaiAuth;
        loginDetail = loggedIn ? "已登录" : "需要在主机完成 Codex 登录";
      } catch (error) {
        loginDetail = `检查失败：${errorMessage(error)}`;
      }
      return [
        `<b>健康检查 ${databaseOk && loggedIn && projectCount.count > 0 ? "正常" : "异常"}</b>`,
        `版本：${VERSION}`,
        `服务：运行 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`,
        `App Server：${appServer.state}`,
        `Codex 登录：${loginDetail}`,
        `数据库：${databaseOk ? "quick_check 通过" : "损坏"}`,
        `项目：${projectCount.count} 个可用`,
        `模型目录：${renderModelCatalogHealth(models.health())}`,
        `状态盘剩余：${Math.floor(freeBytes / 1024 / 1024)} MB`,
      ].join("\n");
    },
  };
  const updates = config.updateManifestUrl && config.updateSignatureUrl && config.updateArchiveUrl && config.updatePublicKeyFile
    ? new UpdateManager((() => {
        const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const inferredInstallRoot = basename(dirname(packageRoot)) === "versions"
          ? resolve(packageRoot, "..", "..")
          : packageRoot;
        const installRoot = process.env.CTB_INSTALL_ROOT ?? inferredInstallRoot;
        const binDirectory = process.env.CTB_BIN_DIR ?? (process.platform === "win32" ? installRoot : join(homedir(), ".local", "bin"));
        return {
        currentVersion: VERSION,
        manifestUrl: config.updateManifestUrl,
        signatureUrl: config.updateSignatureUrl,
        archiveUrl: config.updateArchiveUrl,
        publicKeyFile: config.updatePublicKeyFile,
          stateDirectory: config.stateDirectory,
          configFile: runtimePaths.configFile,
          codexExecutable: config.codexExecutable,
          installRoot,
          binDirectory,
        };
      })(), logger)
    : null;
  const restarts = new RestartManager({ stateDirectory: config.stateDirectory }, logger);
  const controller = new TelegramController(
    telegram,
    database,
    runtimeStore.tasks,
    pairing,
    runtimeStore.projects,
    runtimeStore.leases,
    approvals,
    audit,
    scheduler,
    media,
    gateway,
    health,
    quota,
    models,
    updates,
    config,
    logger,
    restarts,
  );
  void controller.resumePendingUpdateNotifications().catch((error: unknown) => {
    logger.error({ error: errorMessage(error) }, "恢复更新终态通知失败；动作文件已保留供下次启动重试");
  });
  const settings = new RuntimeSettings(database);
  const abortController = new AbortController();
  const cleanupTimer = setInterval(() => {
    void media.cleanup().catch((error: unknown) => { logger.error({ error: errorMessage(error) }, "定时清理失败"); });
    try {
      cleanupDatabase(database, config.taskRetentionDays * 86_400_000, config.auditRetentionDays * 86_400_000);
    } catch (error) {
      logger.error({ error: errorMessage(error) }, "定时数据库清理失败");
    }
  }, 3_600_000);
  const leaseTimer = setInterval(() => {
    const expiredProjects = database.connection
      .prepare("SELECT DISTINCT project_id FROM permission_leases WHERE revoked_at IS NULL AND expires_at <= ?")
      .all(Date.now()) as Array<{ project_id: string }>;
    runtimeStore.leases.expire();
    for (const { project_id: projectId } of expiredProjects) {
      database.connection.transaction(() => {
        database.connection.prepare("UPDATE projects SET permission_profile = 'workspace-write + on-request', updated_at = ? WHERE id = ? AND permission_profile = 'danger-full-access'").run(Date.now(), projectId);
        database.connection.prepare("UPDATE threads SET closed_at = ?, updated_at = ? WHERE project_id = ? AND permission_profile = 'danger-full-access' AND closed_at IS NULL").run(Date.now(), Date.now(), projectId);
      })();
      audit.record({ eventType: "danger_lease", outcome: "expired", projectId });
    }
  }, 60_000);
  cleanupTimer.unref();
  leaseTimer.unref();

  const shutdown = (): void => { abortController.abort(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  logger.info({ version: VERSION, paired: owner !== null }, "Codex Telegram Bridge 已启动");
  try {
    while (!abortController.signal.aborted) {
      try {
        const migratedOffset = Number(settings.get("telegram_offset") ?? "0");
        const offset = Math.max(runtimeStore.tasks.getNextTelegramOffset(), Number.isFinite(migratedOffset) ? migratedOffset : 0);
        const updates = await telegram.getUpdates(offset, 30, abortController.signal);
        for (const update of updates) {
          try {
            await controller.handle(update);
            settings.set("telegram_offset", String(update.update_id + 1));
            await controller.launchRestartAfterUpdateCommitted(update.update_id);
          } catch (error) {
            logger.error({ updateId: update.update_id, error: errorMessage(error) }, "Telegram update 处理失败");
          }
        }
      } catch (error) {
        // AbortSignal can change while getUpdates is awaiting network I/O.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (abortController.signal.aborted) break;
        logger.error({ error: errorMessage(error) }, "Telegram 长轮询失败");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }
  } finally {
    clearInterval(cleanupTimer);
    clearInterval(leaseTimer);
    await Promise.race([
      scheduler.stop(),
      new Promise<void>((_, reject) => setTimeout(() => {
        reject(new Error("任务调度器停止超时"));
      }, 10_000)),
    ]).catch((error: unknown) => {
      logger.error({ error: errorMessage(error) }, "停止任务调度器失败，继续释放其余资源");
    });
    try {
      executor.dispose();
    } catch (error) {
      logger.error({ error: errorMessage(error) }, "释放 App Server 执行器失败");
    }
    models.dispose();
    await appServer.close().catch((error: unknown) => {
      logger.error({ error: errorMessage(error) }, "关闭 App Server 失败");
    });
    try {
      database.close();
    } catch (error) {
      logger.error({ error: errorMessage(error) }, "关闭数据库失败");
    }
    await releaseLock().catch((error: unknown) => {
      logger.error({ error: errorMessage(error) }, "释放单实例锁失败");
    });
    logger.info("Codex Telegram Bridge 已停止");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Codex Telegram Bridge 启动失败：${errorMessage(error)}\n`);
  process.exitCode = 1;
});
