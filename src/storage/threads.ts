import { randomUUID } from "node:crypto";

import type { BridgeDatabase } from "./database.js";
import type { PermissionProfile, ThreadRecord } from "./types.js";

interface ThreadRow {
  id: string;
  project_id: string;
  codex_thread_id: string;
  permission_profile: PermissionProfile;
  closed_at: number | null;
}

export class ThreadRepository {
  constructor(private readonly database: BridgeDatabase) {}

  upsert(
    projectId: string,
    codexThreadId: string,
    permissionProfile: PermissionProfile,
    now = Date.now(),
  ): ThreadRecord {
    const current = this.database.connection
      .prepare("SELECT id, project_id FROM threads WHERE codex_thread_id = ?")
      .get(codexThreadId) as { id: string; project_id: string } | undefined;
    if (current !== undefined && current.project_id !== projectId) {
      throw new Error("A Codex thread cannot be moved to a different registered project");
    }
    const id = current?.id ?? randomUUID();
    this.database.connection
      .prepare(
        `INSERT INTO threads(id, project_id, codex_thread_id, permission_profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(codex_thread_id) DO UPDATE SET
           project_id = excluded.project_id,
           permission_profile = excluded.permission_profile,
           closed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(id, projectId, codexThreadId, permissionProfile, now, now);
    return this.require(id);
  }

  require(id: string): ThreadRecord {
    const row = this.database.connection.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    if (row === undefined) throw new Error(`Thread not found: ${id}`);
    return mapThread(row);
  }

  close(id: string, now = Date.now()): void {
    const changes = this.database.connection
      .prepare("UPDATE threads SET closed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id).changes;
    if (changes !== 1) throw new Error(`Thread not found: ${id}`);
  }
}

function mapThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    codexThreadId: row.codex_thread_id,
    permissionProfile: row.permission_profile,
    closedAt: row.closed_at,
  };
}
