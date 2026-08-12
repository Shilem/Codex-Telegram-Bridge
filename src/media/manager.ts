import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

import type { Logger } from "pino";

import { BridgeError } from "../core/types.js";

export interface CleanupPolicy {
  attachmentRetentionMs: number;
  artifactRetentionMs: number;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

async function removeExpired(directory: string, cutoffMs: number): Promise<number> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await opendir(directory);
  let removed = 0;
  for await (const entry of entries) {
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.mtimeMs >= cutoffMs) continue;
    await rm(path, { recursive: entry.isDirectory(), force: true });
    removed += 1;
  }
  return removed;
}

export class MediaManager {
  readonly #attachmentDirectory: string;

  public constructor(
    stateDirectory: string,
    private readonly artifactDirectory: string,
    private readonly policy: CleanupPolicy,
    private readonly logger: Logger,
  ) {
    this.#attachmentDirectory = resolve(stateDirectory, "attachments");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#attachmentDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
  }

  public attachmentDirectoryFor(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      throw new BridgeError("任务 ID 格式无效", "TASK_ID_INVALID");
    }
    return resolve(this.#attachmentDirectory, taskId);
  }

  public async assertOutboundFileAllowed(
    filePath: string,
    projectRoots: readonly string[],
    maxBytes: number,
  ): Promise<string> {
    const canonical = await realpath(resolve(filePath));
    const allowedRoots = await Promise.all(
      [...projectRoots, this.artifactDirectory].map(async (root) => realpath(resolve(root))),
    );
    if (!allowedRoots.some((root) => isWithin(root, canonical))) {
      throw new BridgeError("拒绝回传未注册项目或产物目录之外的文件", "OUTBOUND_PATH_NOT_ALLOWED");
    }
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new BridgeError(`产物不是普通文件或超过 ${maxBytes} 字节限制`, "OUTBOUND_FILE_REJECTED");
    }
    return canonical;
  }

  public async isolateOutboundFile(
    filePath: string,
    projectRoots: readonly string[],
    maxBytes: number,
  ): Promise<string> {
    const canonical = await this.assertOutboundFileAllowed(filePath, projectRoots, maxBytes);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const isolated = resolve(
      this.artifactDirectory,
      `outbound-${Date.now()}-${randomUUID()}-${basename(canonical)}`,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maxBytes) {
        throw new BridgeError("待回传文件在打开后发生变化", "OUTBOUND_FILE_CHANGED");
      }
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        createWriteStream(isolated, { flags: "wx", mode: 0o600 }),
      );
      return isolated;
    } catch (error) {
      await rm(isolated, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  public async sniffMime(filePath: string): Promise<string> {
    const stream = createReadStream(filePath, { start: 0, end: 15 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const header = Buffer.concat(chunks);
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
    if (header.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
    if (header.subarray(0, 4).toString("ascii") === "PK\u0003\u0004") return "application/zip";
    return "application/octet-stream";
  }

  public async cleanup(now = Date.now()): Promise<{ attachments: number; artifacts: number }> {
    const attachments = await removeExpired(
      this.#attachmentDirectory,
      now - this.policy.attachmentRetentionMs,
    );
    const artifacts = await removeExpired(
      this.artifactDirectory,
      now - this.policy.artifactRetentionMs,
    );
    this.logger.info({ attachments, artifacts }, "媒体保留策略执行完成");
    return { attachments, artifacts };
  }
}
