import { spawn } from "node:child_process";
import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { z } from "zod";

import { BridgeError } from "../core/types.js";
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
}

function requireHttps(value: string): void {
  if (!value.startsWith("https://")) throw new BridgeError("更新地址必须使用 HTTPS", "UPDATE_URL_INSECURE");
}

export class UpdateManager {
  public constructor(
    private readonly config: UpdateManagerConfig,
    private readonly logger: Logger,
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

  public async install(expectedVersion: string): Promise<void> {
    const current = await this.check();
    if (current.version !== expectedVersion) {
      throw new BridgeError("更新按钮已过期，远端最新版本已变化", "UPDATE_ACTION_STALE");
    }
    const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
    const windows = process.platform === "win32";
    const script = resolve(scriptRoot, windows ? "update.ps1" : "update.sh");
    const args = windows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Manifest", this.config.manifestUrl, "-Signature", this.config.signatureUrl, "-Archive", this.config.archiveUrl, "-PublicKey", this.config.publicKeyFile]
      : [script, "--manifest", this.config.manifestUrl, "--signature", this.config.signatureUrl, "--archive", this.config.archiveUrl, "--public-key", this.config.publicKeyFile];
    const actionId = `ctb-update-${Date.now()}`;
    let command: string;
    let commandArgs: string[];
    if (process.platform === "linux") {
      command = "systemd-run";
      commandArgs = ["--user", `--unit=${actionId}`, "--collect", "--", "bash", ...args];
    } else if (process.platform === "darwin") {
      command = "launchctl";
      commandArgs = ["submit", "-l", `com.shilem.${actionId}`, "--", "bash", ...args];
    } else if (windows) {
      const start = new Date(Date.now() + 60_000);
      const startTime = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      command = "schtasks.exe";
      commandArgs = ["/Create", "/SC", "ONCE", "/ST", startTime, "/TN", actionId, "/TR", ["powershell.exe", ...args].map(quoteWindowsTaskArgument).join(" "), "/F"];
    } else {
      throw new BridgeError("当前平台不支持独立更新任务", "UPDATE_PLATFORM_UNSUPPORTED");
    }
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    await new Promise<void>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new BridgeError(`创建独立更新任务失败：exit ${String(code)}`, "UPDATE_JOB_CREATE_FAILED"));
      });
    });
    if (windows) {
      const starter = spawn("schtasks.exe", ["/Run", "/TN", actionId], { detached: true, stdio: "ignore" });
      starter.once("error", (error) => {
        this.logger.error({ error: error.message, version: expectedVersion }, "启动 Windows 更新任务失败");
      });
      starter.unref();
    }
    this.logger.info({ version: expectedVersion }, "已持久化一次性更新动作并启动签名更新");
  }
}

function quoteWindowsTaskArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
