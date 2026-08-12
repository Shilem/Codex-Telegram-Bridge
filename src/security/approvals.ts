import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { BridgeDatabase } from "../storage/database.js";

export type ApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";

export interface ApprovalBinding {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

interface ApprovalRow {
  action_id: string;
  request_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  nonce_hash: string;
  expires_at: number;
  decision: ApprovalDecision | null;
}

export class ApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRejectedError";
  }
}

export class ApprovalManager {
  constructor(
    private readonly database: BridgeDatabase,
    private readonly signingKey: Buffer,
  ) {
    if (signingKey.length < 32) throw new Error("Approval signing key must contain at least 32 bytes");
  }

  create(binding: ApprovalBinding, expiresAt: number, now = Date.now()): string {
    if (expiresAt <= now) throw new Error("Approval expiry must be in the future");
    const actionId = randomBytes(12).toString("base64url");
    const signature = this.sign(actionId);
    const token = `${actionId}.${signature}`;
    this.database.connection
      .prepare(
        `INSERT INTO approvals(action_id, request_id, thread_id, turn_id, item_id, nonce_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        binding.requestId,
        binding.threadId,
        binding.turnId,
        binding.itemId,
        hashToken(token),
        expiresAt,
        now,
      );
    return token;
  }

  consume(
    token: string,
    binding: ApprovalBinding,
    decision: ApprovalDecision,
    now = Date.now(),
  ): ApprovalDecision {
    if (!this.hasValidSignature(token)) throw new ApprovalRejectedError("Approval action signature is invalid");
    return this.database.connection.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT * FROM approvals WHERE nonce_hash = ?")
        .get(hashToken(token)) as ApprovalRow | undefined;
      if (row === undefined) throw new ApprovalRejectedError("Approval action does not exist");
      if (row.decision !== null) throw new ApprovalRejectedError("Approval action has already been used");
      if (row.expires_at <= now) throw new ApprovalRejectedError("Approval action has expired");
      if (
        row.request_id !== binding.requestId ||
        row.thread_id !== binding.threadId ||
        row.turn_id !== binding.turnId ||
        row.item_id !== binding.itemId
      ) {
        throw new ApprovalRejectedError("Approval action is bound to a different request");
      }
      const changes = this.database.connection
        .prepare(
          "UPDATE approvals SET decision = ?, decided_at = ? WHERE action_id = ? AND decision IS NULL",
        )
        .run(decision, now, row.action_id).changes;
      if (changes !== 1) throw new ApprovalRejectedError("Approval action was consumed concurrently");
      return decision;
    })();
  }

  consumeAction(
    token: string,
    decision: ApprovalDecision,
    now = Date.now(),
  ): ApprovalBinding & { decision: ApprovalDecision } {
    if (!this.hasValidSignature(token)) throw new ApprovalRejectedError("Approval action signature is invalid");
    return this.database.connection.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT * FROM approvals WHERE nonce_hash = ?")
        .get(hashToken(token)) as ApprovalRow | undefined;
      if (row === undefined) throw new ApprovalRejectedError("Approval action does not exist");
      if (row.decision !== null) throw new ApprovalRejectedError("Approval action has already been used");
      if (row.expires_at <= now) throw new ApprovalRejectedError("Approval action has expired");
      const changes = this.database.connection
        .prepare("UPDATE approvals SET decision = ?, decided_at = ? WHERE action_id = ? AND decision IS NULL")
        .run(decision, now, row.action_id).changes;
      if (changes !== 1) throw new ApprovalRejectedError("Approval action was consumed concurrently");
      return {
        requestId: row.request_id,
        threadId: row.thread_id,
        turnId: row.turn_id,
        itemId: row.item_id,
        decision,
      };
    })();
  }

  private sign(actionId: string): string {
    return createHmac("sha256", this.signingKey).update(actionId, "utf8").digest().subarray(0, 16).toString("base64url");
  }

  private hasValidSignature(token: string): boolean {
    const separator = token.indexOf(".");
    if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return false;
    const actionId = token.slice(0, separator);
    const actual = Buffer.from(token.slice(separator + 1));
    const expected = Buffer.from(this.sign(actionId));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
