import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

import { BridgeError } from "./types.js";

export async function acquireInstanceLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const handle = await open(lockPath, "a", 0o600);
  await handle.close();
  try {
    return await lockfile.lock(lockPath, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
  } catch (error) {
    throw new BridgeError("已有 Codex Telegram Bridge 实例正在运行", "INSTANCE_ALREADY_RUNNING", error);
  }
}
