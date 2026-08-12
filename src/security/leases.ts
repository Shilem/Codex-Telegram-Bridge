import { randomUUID } from "node:crypto";

import type { BridgeDatabase } from "../storage/database.js";

export const DANGER_LEASE_TTL_MS = 15 * 60 * 1000;

export interface DangerLeaseRequest {
  readonly projectId: string;
  readonly ownerId: number;
  readonly hostAllowsDangerFullAccess: boolean;
  readonly telegramConfirmed: boolean;
}

export class PermissionLeaseManager {
  constructor(private readonly database: BridgeDatabase) {}

  grantDangerLease(request: DangerLeaseRequest, now = Date.now()): { id: string; expiresAt: number } {
    if (!request.hostAllowsDangerFullAccess) throw new Error("Host configuration forbids danger-full-access");
    if (!request.telegramConfirmed) throw new Error("Telegram second confirmation is required");
    const id = randomUUID();
    const expiresAt = now + DANGER_LEASE_TTL_MS;
    this.database.connection.transaction(() => {
      const owner = this.database.connection
        .prepare("SELECT 1 FROM owners WHERE id = ? AND revoked_at IS NULL")
        .get(request.ownerId);
      if (owner === undefined) throw new Error("Active owner not found");
      const project = this.database.connection
        .prepare("SELECT 1 FROM projects WHERE id = ? AND enabled = 1")
        .get(request.projectId);
      if (project === undefined) throw new Error("Enabled project not found");
      this.database.connection
        .prepare(
          "UPDATE permission_leases SET revoked_at = ? WHERE project_id = ? AND owner_id = ? AND revoked_at IS NULL",
        )
        .run(now, request.projectId, request.ownerId);
      this.database.connection
        .prepare(
          `INSERT INTO permission_leases(id, project_id, owner_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, request.projectId, request.ownerId, expiresAt, now);
    })();
    return { id, expiresAt };
  }

  isActive(projectId: string, ownerId: number, now = Date.now()): boolean {
    return (
      this.database.connection
        .prepare(
          `SELECT 1 FROM permission_leases
           WHERE project_id = ? AND owner_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
        )
        .get(projectId, ownerId, now) !== undefined
    );
  }

  expire(now = Date.now()): number {
    return this.database.connection
      .prepare("UPDATE permission_leases SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at <= ?")
      .run(now, now).changes;
  }
}
