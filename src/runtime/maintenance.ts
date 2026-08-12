import type { BridgeDatabase } from "../storage/index.js";

export function cleanupDatabase(
  database: BridgeDatabase,
  taskRetentionMs: number,
  auditRetentionMs: number,
  now = Date.now(),
): { taskBodies: number; taskEvents: number; auditEvents: number; expiredApprovals: number } {
  return database.connection.transaction(() => {
    const taskBodies = database.connection
      .prepare("UPDATE tasks SET body = NULL WHERE body IS NOT NULL AND created_at < ?")
      .run(now - taskRetentionMs).changes;
    const taskEvents = database.connection
      .prepare("DELETE FROM task_events WHERE created_at < ?")
      .run(now - taskRetentionMs).changes;
    const auditEvents = database.connection
      .prepare("DELETE FROM audit_events WHERE created_at < ?")
      .run(now - auditRetentionMs).changes;
    const expiredApprovals = database.connection
      .prepare("DELETE FROM approvals WHERE expires_at < ?")
      .run(now).changes;
    return { taskBodies, taskEvents, auditEvents, expiredApprovals };
  })();
}
