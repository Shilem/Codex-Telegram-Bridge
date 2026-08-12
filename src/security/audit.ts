import { createHash } from "node:crypto";

import type { BridgeDatabase } from "../storage/database.js";

const sensitiveKey = /(token|secret|password|prompt|body|command|diff|content|path|chat|user)/iu;

export class AuditLog {
  constructor(
    private readonly database: BridgeDatabase,
    private readonly fingerprintSalt: Buffer,
  ) {
    if (fingerprintSalt.length < 16) throw new Error("Audit fingerprint salt must contain at least 16 bytes");
  }

  record(input: {
    readonly eventType: string;
    readonly outcome: string;
    readonly projectId?: string;
    readonly actorId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly now?: number;
  }): void {
    const actorFingerprint =
      input.actorId === undefined
        ? null
        : createHash("sha256").update(this.fingerprintSalt).update(input.actorId, "utf8").digest("hex");
    const metadata = redact(input.metadata ?? {});
    this.database.connection
      .prepare(
        `INSERT INTO audit_events(event_type, outcome, project_id, actor_fingerprint, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventType,
        input.outcome,
        input.projectId ?? null,
        actorFingerprint,
        JSON.stringify(metadata),
        input.now ?? Date.now(),
      );
  }
}

function redact(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  if (typeof value === "string" && value.length > 256) return `${value.slice(0, 256)}…`;
  return value;
}
