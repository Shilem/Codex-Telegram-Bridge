import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { BridgeError } from "./types.js";

const configSchema = z.object({
  botTokenFile: z.string().min(1),
  stateDirectory: z.string().min(1),
  artifactDirectory: z.string().min(1),
  codexExecutable: z.string().min(1).default("codex"),
  allowDangerFullAccess: z.boolean().default(false),
  inboundFileLimitBytes: z.number().int().positive().default(20 * 1024 * 1024),
  outboundFileLimitBytes: z.number().int().positive().default(50 * 1024 * 1024),
  maxUpdateAgeMinutes: z.number().positive().default(10),
  attachmentRetentionHours: z.number().positive().default(24),
  taskRetentionDays: z.number().positive().default(7),
  auditRetentionDays: z.number().positive().default(30),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  updateManifestUrl: z.url().optional(),
  updateSignatureUrl: z.url().optional(),
  updateArchiveUrl: z.url().optional(),
  updatePublicKeyFile: z.string().optional(),
});

export type BridgeConfig = z.infer<typeof configSchema>;

export interface RuntimePaths {
  configFile: string;
  dataDirectory: string;
}

function platformDirectories(): RuntimePaths {
  const home = homedir();
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return {
      configFile: join(appData, "CodexTelegramBridge", "config.json"),
      dataDirectory: join(localData, "CodexTelegramBridge"),
    };
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateHome = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return {
    configFile: join(configHome, "codex-telegram-bridge", "config.json"),
    dataDirectory: join(stateHome, "codex-telegram-bridge"),
  };
}

export function defaultRuntimePaths(): RuntimePaths {
  const defaults = platformDirectories();
  const configFile = process.env.CTB_CONFIG_FILE
    ? resolve(process.env.CTB_CONFIG_FILE)
    : defaults.configFile;
  return { configFile, dataDirectory: defaults.dataDirectory };
}

async function assertSecretFileMode(path: string): Promise<void> {
  if (platform() === "win32") return;
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new BridgeError(
      `密钥文件权限不安全：${path}，请执行 chmod 600`,
      "INSECURE_SECRET_FILE",
    );
  }
}

export async function loadConfig(configFile = defaultRuntimePaths().configFile): Promise<BridgeConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configFile, "utf8")) as unknown;
  } catch (error) {
    throw new BridgeError(`无法读取配置文件：${configFile}`, "CONFIG_READ_FAILED", error);
  }
  const defaults = defaultRuntimePaths();
  const parsed = configSchema.safeParse({
    stateDirectory: defaults.dataDirectory,
    artifactDirectory: join(defaults.dataDirectory, "artifacts"),
    ...((value !== null && typeof value === "object") ? value : {}),
  });
  if (!parsed.success) {
    throw new BridgeError(
      `配置格式错误：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "CONFIG_INVALID",
    );
  }
  const config = {
    ...parsed.data,
    botTokenFile: resolve(dirname(configFile), parsed.data.botTokenFile),
    stateDirectory: resolve(parsed.data.stateDirectory),
    artifactDirectory: resolve(parsed.data.artifactDirectory),
    ...(parsed.data.updatePublicKeyFile
      ? { updatePublicKeyFile: resolve(dirname(configFile), parsed.data.updatePublicKeyFile) }
      : {}),
  };
  await assertSecretFileMode(config.botTokenFile);
  return config;
}

export async function readBotToken(config: BridgeConfig): Promise<string> {
  await assertSecretFileMode(config.botTokenFile);
  const token = (await readFile(config.botTokenFile, "utf8")).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new BridgeError("Bot Token 文件内容格式无效", "BOT_TOKEN_INVALID");
  }
  return token;
}
