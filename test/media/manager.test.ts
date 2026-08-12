import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { MediaManager } from "../../src/media/manager.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("媒体路径隔离", () => {
  it("允许项目内文件并拒绝符号链接逃逸", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctb-media-"));
    directories.push(root);
    const state = join(root, "state");
    const artifacts = join(root, "artifacts");
    const project = join(root, "project");
    await Promise.all([mkdir(project), mkdir(state), mkdir(artifacts)]);
    const allowed = join(project, "result.txt");
    const outside = join(root, "secret.txt");
    await writeFile(allowed, "ok");
    await writeFile(outside, "secret");
    await symlink(outside, join(project, "link.txt"));
    const manager = new MediaManager(
      state,
      artifacts,
      { attachmentRetentionMs: 1_000, artifactRetentionMs: 1_000 },
      pino({ level: "silent" }),
    );
    await manager.initialize();
    await expect(manager.assertOutboundFileAllowed(allowed, [project], 100)).resolves.toBe(await realpath(allowed));
    await expect(manager.assertOutboundFileAllowed(join(project, "link.txt"), [project], 100)).rejects.toThrow("未注册项目");
  });
});
