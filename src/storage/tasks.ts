import { randomUUID } from "node:crypto";

import type { BridgeDatabase } from "./database.js";
import type { TaskRecord, TaskState } from "./types.js";

const transitions: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  received: new Set(["queued", "failed", "cancelled"]),
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["waiting_input", "waiting_approval", "completed", "failed", "cancelled", "unknown"]),
  waiting_input: new Set(["running", "failed", "cancelled", "unknown"]),
  waiting_approval: new Set(["running", "failed", "cancelled", "unknown"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  unknown: new Set(["queued", "completed", "failed", "cancelled"]),
};

interface TaskRow {
  id: string;
  source_update_id: number;
  source_message_id: number;
  project_id: string;
  thread_id: string | null;
  turn_id: string | null;
  state: TaskState;
  body: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface TelegramTaskInput {
  readonly updateId: number;
  readonly messageId: number;
  readonly projectId: string;
  readonly body: string;
  readonly taskId?: string;
}

export interface IngestResult {
  readonly task: TaskRecord;
  readonly duplicate: boolean;
}

export class TaskLedger {
  constructor(private readonly database: BridgeDatabase) {}

  ingestTelegramTask(input: TelegramTaskInput, now = Date.now()): IngestResult {
    return this.database.connection.transaction(() => {
      const previous = this.database.connection
        .prepare("SELECT task_id FROM telegram_updates WHERE update_id = ?")
        .get(input.updateId) as { task_id: string | null } | undefined;
      if (previous !== undefined) {
        if (previous.task_id === null) {
          throw new Error(`Telegram update ${String(input.updateId)} exists without a committed task`);
        }
        return { task: this.requireTask(previous.task_id), duplicate: true };
      }

      const taskId = input.taskId ?? randomUUID();
      this.database.connection
        .prepare(
          "INSERT INTO telegram_updates(update_id, status, task_id, received_at, updated_at) VALUES (?, 'received', NULL, ?, ?)",
        )
        .run(input.updateId, now, now);
      this.database.connection
        .prepare(
          `INSERT INTO tasks(id, source_update_id, source_message_id, project_id, state, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'received', ?, ?, ?)`,
        )
        .run(taskId, input.updateId, input.messageId, input.projectId, input.body, now, now);
      this.transitionInTransaction(taskId, "queued", null, now);
      this.database.connection
        .prepare("UPDATE telegram_updates SET task_id = ?, status = 'committed', updated_at = ? WHERE update_id = ?")
        .run(taskId, now, input.updateId);
      return { task: this.requireTask(taskId), duplicate: false };
    })();
  }

  transition(taskId: string, next: TaskState, error: string | null = null, now = Date.now()): TaskRecord {
    return this.database.connection.transaction(() => {
      this.transitionInTransaction(taskId, next, error, now);
      return this.requireTask(taskId);
    })();
  }

  claimNextQueued(now = Date.now()): TaskRecord | null {
    return this.database.connection.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT id FROM tasks WHERE state = 'queued' ORDER BY created_at, id LIMIT 1")
        .get() as { id: string } | undefined;
      if (row === undefined) return null;
      this.transitionInTransaction(row.id, "running", null, now);
      return this.requireTask(row.id);
    })();
  }

  bindCodexContext(taskId: string, threadId: string, turnId: string, now = Date.now()): TaskRecord {
    const changes = this.database.connection
      .prepare("UPDATE tasks SET thread_id = ?, turn_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, turnId, now, taskId).changes;
    if (changes !== 1) throw new Error(`Task not found: ${taskId}`);
    return this.requireTask(taskId);
  }

  listQueued(limit = 100): TaskRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.connection
      .prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at, id LIMIT ?")
      .all(safeLimit) as TaskRow[];
    return rows.map(mapTask);
  }

  listTasks(states: readonly TaskState[] = [], limit = 100): TaskRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows =
      states.length === 0
        ? (this.database.connection
            .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?")
            .all(safeLimit) as TaskRow[])
        : (this.database.connection
            .prepare(
              `SELECT * FROM tasks WHERE state IN (${states.map(() => "?").join(",")})
               ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(...states, safeLimit) as TaskRow[]);
    return rows.map(mapTask);
  }

  getNextTelegramOffset(initialOffset = 0): number {
    const row = this.database.connection
      .prepare("SELECT MAX(update_id) AS maximum FROM telegram_updates")
      .get() as { maximum: number | null };
    return row.maximum === null ? initialOffset : row.maximum + 1;
  }

  recordNonTaskUpdate(
    updateId: number,
    outcome: "committed" | "failed",
    resultCode: string,
    now = Date.now(),
  ): boolean {
    return this.database.connection.transaction(() => {
      const result = this.database.connection
        .prepare(
          `INSERT INTO telegram_updates(update_id, status, result_code, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(update_id) DO NOTHING`,
        )
        .run(updateId, outcome, resultCode, now, now);
      return result.changes === 1;
    })();
  }

  appendEvent(taskId: string, sequence: number, eventType: string, payload: unknown, now = Date.now()): void {
    const payloadJson = JSON.stringify(payload);
    this.database.connection
      .prepare(
        "INSERT INTO task_events(task_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, sequence, eventType, payloadJson, now);
  }

  requireTask(taskId: string): TaskRecord {
    const row = this.database.connection.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (row === undefined) throw new Error(`Task not found: ${taskId}`);
    return mapTask(row);
  }

  private transitionInTransaction(taskId: string, next: TaskState, error: string | null, now: number): void {
    const current = this.requireTask(taskId);
    if (!transitions[current.state].has(next)) {
      throw new Error(`Illegal task transition: ${current.state} -> ${next}`);
    }
    const changes = this.database.connection
      .prepare("UPDATE tasks SET state = ?, error = ?, updated_at = ? WHERE id = ? AND state = ?")
      .run(next, error, now, taskId, current.state).changes;
    if (changes !== 1) throw new Error(`Concurrent task transition detected: ${taskId}`);
  }
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    sourceUpdateId: row.source_update_id,
    sourceMessageId: row.source_message_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    state: row.state,
    body: row.body,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
