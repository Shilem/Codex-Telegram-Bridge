import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateManager } from "../../src/update/manager.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("UpdateManager", () => {
  it("验证远端签名、版本递增和产物名称", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctb-update-manager-"));
    directories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(directory, "public.pem");
    await writeFile(keyFile, publicKey.export({ format: "pem", type: "spki" }));
    const manifest = Buffer.from(JSON.stringify({ version: "1.0.1", archive: "release.tgz", sha256: "a".repeat(64) }));
    const signature = sign("sha256", manifest, privateKey);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(
      url.endsWith(".sig") ? signature : manifest,
      { status: 200 },
    ))));
    const manager = new UpdateManager({
      currentVersion: "1.0.0",
      manifestUrl: "https://example.test/manifest.json",
      signatureUrl: "https://example.test/manifest.sig",
      archiveUrl: "https://example.test/release.tgz",
      publicKeyFile: keyFile,
    }, pino({ level: "silent" }));
    await expect(manager.check()).resolves.toMatchObject({ version: "1.0.1" });
  });

  it("拒绝明文更新地址", () => {
    expect(() => new UpdateManager({
      currentVersion: "1.0.0",
      manifestUrl: "http://example.test/manifest.json",
      signatureUrl: "https://example.test/manifest.sig",
      archiveUrl: "https://example.test/release.tgz",
      publicKeyFile: "/tmp/key",
    }, pino({ level: "silent" }))).toThrow("HTTPS");
  });
});
