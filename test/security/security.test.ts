import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalManager } from "../../src/security/approvals.js";
import { AuditLog } from "../../src/security/audit.js";
import { DANGER_LEASE_TTL_MS, PermissionLeaseManager } from "../../src/security/leases.js";
import { PairingService } from "../../src/security/pairing.js";
import { ProjectRegistry } from "../../src/security/projects.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const databases: BridgeDatabase[] = [];

function database(): BridgeDatabase {
  const value = new BridgeDatabase(":memory:");
  databases.push(value);
  return value;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("owner pairing and authentication", () => {
  it("requires private chat, binds both identities, expires codes and closes pairing", () => {
    const service = new PairingService(database());
    expect(() => service.requestCode("10", "10", "group", 1)).toThrow("private chat");
    const expired = service.requestCode("10", "10", "private", 1);
    expect(() => service.confirmCode(expired, 10 * 60 * 1000 + 1)).toThrow("invalid or expired");

    const code = service.requestCode("10", "10", "private", 2_000_000);
    const owner = service.confirmCode(code, 2_000_001);
    expect(service.authenticate("10", "10", "private")).toEqual(owner);
    expect(() => service.authenticate("11", "10", "private")).toThrow("does not match");
    expect(() => service.authenticate("10", "10", "supergroup")).toThrow("private chats");
    expect(() => service.requestCode("10", "10", "private")).toThrow("Pairing is closed");
  });
});

describe("one-time signed approval actions", () => {
  const binding = { requestId: "r1", threadId: "th1", turnId: "tu1", itemId: "i1" } as const;

  it("rejects forgery, cross-turn reuse, expiry and duplicate clicks", () => {
    const manager = new ApprovalManager(database(), randomBytes(32));
    const token = manager.create(binding, 1000, 1);
    expect(() => manager.consume(`${token}x`, binding, "accept", 2)).toThrow("signature");
    expect(() => manager.consume(token, { ...binding, turnId: "other" }, "accept", 2)).toThrow(
      "different request",
    );
    expect(manager.consume(token, binding, "decline", 2)).toBe("decline");
    expect(() => manager.consume(token, binding, "accept", 3)).toThrow("already been used");

    const repeated = manager.create(binding, 1000, 3);
    expect(manager.consume(repeated, binding, "accept", 4)).toBe("accept");

    const expired = manager.create({ ...binding, requestId: "r2" }, 5, 1);
    expect(() => manager.consume(expired, { ...binding, requestId: "r2" }, "accept", 5)).toThrow("expired");
  });
});

describe("registered project boundary", () => {
  it("allows project files and rejects traversal plus symlink escape", () => {
    const base = mkdtempSync(path.join(tmpdir(), "ctb-project-"));
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(root, "inside.txt"), "ok");
    writeFileSync(path.join(outside, "secret.txt"), "no");
    symlinkSync(outside, path.join(root, "escape"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escaped-file"));

    const registry = new ProjectRegistry(database());
    const project = registry.register(root, "Test");
    expect(registry.assertExistingPath(project.id, path.join(root, "inside.txt"))).toBe(
      realpathSync.native(path.join(root, "inside.txt")),
    );
    expect(() => registry.assertExistingPath(project.id, path.join(root, "..", "outside", "secret.txt"))).toThrow(
      "escapes",
    );
    expect(() => registry.assertExistingPath(project.id, path.join(root, "escape", "secret.txt"))).toThrow("escapes");
    expect(() => registry.assertOutputPath(project.id, path.join(root, "escape", "new.txt"))).toThrow("escapes");
    expect(() => registry.assertOutputPath(project.id, path.join(root, "escaped-file"))).toThrow("escapes");
  });
});

describe("danger permission lease", () => {
  it("requires both host opt-in and Telegram confirmation and expires at 15 minutes", () => {
    const db = database();
    const pairing = new PairingService(db);
    const code = pairing.requestCode("10", "10", "private", 1);
    const owner = pairing.confirmCode(code, 2);
    const base = mkdtempSync(path.join(tmpdir(), "ctb-lease-"));
    const project = new ProjectRegistry(db).register(base, "Lease", 2);
    const leases = new PermissionLeaseManager(db);

    expect(() =>
      leases.grantDangerLease({
        projectId: project.id,
        ownerId: owner.id,
        hostAllowsDangerFullAccess: false,
        telegramConfirmed: true,
      }),
    ).toThrow("Host configuration");
    const lease = leases.grantDangerLease(
      {
        projectId: project.id,
        ownerId: owner.id,
        hostAllowsDangerFullAccess: true,
        telegramConfirmed: true,
      },
      100,
    );
    expect(lease.expiresAt).toBe(100 + DANGER_LEASE_TTL_MS);
    expect(leases.isActive(project.id, owner.id, lease.expiresAt - 1)).toBe(true);
    expect(leases.isActive(project.id, owner.id, lease.expiresAt)).toBe(false);
    expect(leases.expire(lease.expiresAt)).toBe(1);
  });
});

describe("redacted audit metadata", () => {
  it("never stores raw actor ids or sensitive fields", () => {
    const db = database();
    const audit = new AuditLog(db, randomBytes(16));
    audit.record({
      eventType: "authorization_rejected",
      outcome: "denied",
      actorId: "telegram-123",
      metadata: { reason: "foreign owner", botToken: "secret", nested: { command: "rm file" } },
      now: 1,
    });
    const row = db.connection.prepare("SELECT actor_fingerprint, metadata_json FROM audit_events").get() as {
      actor_fingerprint: string;
      metadata_json: string;
    };
    expect(row.actor_fingerprint).not.toContain("telegram-123");
    expect(row.metadata_json).toContain("[REDACTED]");
    expect(row.metadata_json).not.toContain("secret");
    expect(row.metadata_json).not.toContain("rm file");
  });
});
