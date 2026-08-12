import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { BridgeError } from "../core/types.js";

const payloadSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  publishedAt: z.iso.datetime(),
  minimumDatabaseVersion: z.number().int().nonnegative(),
  artifacts: z.record(
    z.string(),
    z.object({
      url: z.url(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().positive(),
    }),
  ),
});

const signedManifestSchema = z.object({
  algorithm: z.literal("ed25519"),
  payload: z.string().min(1),
  signature: z.string().min(1),
});

export type UpdateManifest = z.infer<typeof payloadSchema>;

export function verifySignedManifest(rawManifest: unknown, publicKeyPem: string): UpdateManifest {
  const envelope = signedManifestSchema.parse(rawManifest);
  const payloadBytes = Buffer.from(envelope.payload, "base64url");
  const signature = Buffer.from(envelope.signature, "base64url");
  const key = createPublicKey(publicKeyPem);
  if (!verify(null, payloadBytes, key, signature)) {
    throw new BridgeError("更新清单签名无效", "UPDATE_SIGNATURE_INVALID");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new BridgeError("更新清单载荷不是有效 JSON", "UPDATE_PAYLOAD_INVALID", error);
  }
  return payloadSchema.parse(payload);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(Buffer.from(chunk as Uint8Array));
  return hash.digest("hex");
}

export async function verifyArtifact(
  filePath: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== expectedSize) {
    throw new BridgeError("更新产物大小与签名清单不一致", "UPDATE_SIZE_MISMATCH");
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new BridgeError("更新产物 SHA-256 与签名清单不一致", "UPDATE_HASH_MISMATCH");
  }
}

export function assertUpgradeOnly(currentVersion: string, candidateVersion: string): void {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    if (!match) throw new BridgeError(`版本号无效：${value}`, "VERSION_INVALID");
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const current = parse(currentVersion);
  const candidate = parse(candidateVersion);
  for (let index = 0; index < 3; index += 1) {
    const candidatePart = candidate[index];
    const currentPart = current[index];
    if (candidatePart === undefined || currentPart === undefined) {
      throw new BridgeError("版本号缺少语义化版本段", "VERSION_INVALID");
    }
    if (candidatePart > currentPart) return;
    if (candidatePart < currentPart) {
      throw new BridgeError("拒绝通过旧按钮或旧清单降级", "UPDATE_DOWNGRADE_REJECTED");
    }
  }
  throw new BridgeError("候选版本并不高于当前版本", "UPDATE_NOT_NEWER");
}
