import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertUpgradeOnly,
  verifySignedManifest,
} from "../../src/update/verifier.js";

describe("签名更新清单", () => {
  it("仅接受 Ed25519 正确签名", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify({
      version: "1.0.1",
      publishedAt: "2026-08-12T00:00:00.000Z",
      minimumDatabaseVersion: 1,
      artifacts: {
        "darwin-arm64": {
          url: "https://example.test/ctb.tgz",
          sha256: "a".repeat(64),
          size: 42,
        },
      },
    }));
    const envelope = {
      algorithm: "ed25519",
      payload: payload.toString("base64url"),
      signature: sign(null, payload, privateKey).toString("base64url"),
    };
    const manifest = verifySignedManifest(
      envelope,
      publicKey.export({ format: "pem", type: "spki" }).toString(),
    );
    expect(manifest.version).toBe("1.0.1");
    expect(() => verifySignedManifest({ ...envelope, payload: `${envelope.payload}x` }, publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow("签名无效");
  });

  it("拒绝同版本和降级", () => {
    expect(() => { assertUpgradeOnly("1.2.3", "1.2.3"); }).toThrow("并不高于");
    expect(() => { assertUpgradeOnly("1.2.3", "1.2.2"); }).toThrow("拒绝");
    expect(() => { assertUpgradeOnly("1.2.3", "1.3.0"); }).not.toThrow();
  });
});
