import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeDatabase } from "../../src/storage/database.js";
import { migrations } from "../../src/storage/schema.js";
import { TaskLedger } from "../../src/storage/tasks.js";
import { ThreadRepository } from "../../src/storage/threads.js";
import { PERMISSION_PROFILES } from "../../src/storage/types.js";

const databases: BridgeDatabase[] = [];

function database(): BridgeDatabase {
  const value = new BridgeDatabase(":memory:");
  databases.push(value);
  return value;
}

function addProject(db: BridgeDatabase, id = "project-1"): void {
  db.connection
    .prepare(
      "INSERT INTO projects(id, name, normalized_root, created_at, updated_at) VALUES (?, 'Test', ?, 1, 1)",
    )
    .run(id, `/tmp/${id}`);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("BridgeDatabase", () => {
  it("enables durable SQLite safety pragmas and applies migrations once", () => {
    const db = database();
    expect(db.connection.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(db.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.connection.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 4 });
    expect(
      (db.connection.pragma("table_info(tasks)") as Array<{ name: string }>).some((column) => column.name === "turn_id"),
    ).toBe(true);
  });

  it("upgrades a version 1 database through all later migrations transactionally", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ctb-migration-"));
    const filename = path.join(directory, "bridge.db");
    const legacy = new Sqlite(filename);
    const firstMigration = migrations[0];
    if (firstMigration === undefined) throw new Error("Initial migration is missing");
    legacy.exec(firstMigration.sql);
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(firstMigration.version, firstMigration.name, 1);
    legacy.close();

    const upgraded = new BridgeDatabase(filename);
    databases.push(upgraded);
    expect(upgraded.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(
      (upgraded.connection.pragma("table_info(tasks)") as Array<{ name: string }>).some(
        (column) => column.name === "turn_id",
      ),
    ).toBe(true);
  });

  it("fixes permission profiles to the three documented values", () => {
    expect(PERMISSION_PROFILES).toEqual([
      "read-only",
      "workspace-write + on-request",
      "danger-full-access",
    ]);
    const db = database();
    expect(() =>
      db.connection
        .prepare(
          `INSERT INTO projects(id, name, normalized_root, permission_profile, created_at, updated_at)
           VALUES ('bad', 'Bad', '/tmp/bad', 'silent-auto-approve', 1, 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("atomically ingests an update and suppresses duplicates", () => {
    const db = database();
    addProject(db);
    const ledger = new TaskLedger(db);
    const first = ledger.ingestTelegramTask({
      updateId: 42,
      messageId: 7,
      projectId: "project-1",
      body: "inspect",
      taskId: "task-1",
    });
    const duplicate = ledger.ingestTelegramTask({
      updateId: 42,
      messageId: 7,
      projectId: "project-1",
      body: "must not replace original",
    });
    expect(first.duplicate).toBe(false);
    expect(first.task.state).toBe("queued");
    expect(duplicate).toEqual({ task: first.task, duplicate: true });
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
  });

  it("rolls the update back when task creation fails at the transaction boundary", () => {
    const db = database();
    const ledger = new TaskLedger(db);
    expect(() =>
      ledger.ingestTelegramTask({
        updateId: 1,
        messageId: 1,
        projectId: "missing",
        body: "fail",
      }),
    ).toThrow();
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM telegram_updates").get()).toEqual({ count: 0 });
    expect(db.connection.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
  });

  it("marks only interrupted running and submitted work unknown after a crash", () => {
    const db = database();
    addProject(db);
    const ledger = new TaskLedger(db);
    ledger.ingestTelegramTask({ updateId: 1, messageId: 1, projectId: "project-1", body: "a", taskId: "a" });
    ledger.ingestTelegramTask({ updateId: 2, messageId: 2, projectId: "project-1", body: "b", taskId: "b" });
    ledger.transition("a", "running");
    db.connection.prepare("UPDATE telegram_updates SET status = 'submitted' WHERE update_id = 1").run();

    expect(db.recoverInterruptedWork(100)).toEqual({ tasks: 1, updates: 1 });
    expect(ledger.requireTask("a").state).toBe("unknown");
    expect(ledger.requireTask("b").state).toBe("queued");
  });
});

describe("TaskLedger state machine", () => {
  it("accepts documented transitions and rejects terminal-state reuse", () => {
    const db = database();
    addProject(db);
    const ledger = new TaskLedger(db);
    ledger.ingestTelegramTask({ updateId: 1, messageId: 1, projectId: "project-1", body: "a", taskId: "a" });
    expect(ledger.transition("a", "running").state).toBe("running");
    expect(ledger.transition("a", "waiting_approval").state).toBe("waiting_approval");
    expect(ledger.transition("a", "running").state).toBe("running");
    expect(ledger.transition("a", "completed").state).toBe("completed");
    expect(() => ledger.transition("a", "running")).toThrow("Illegal task transition: completed -> running");
  });

  it("allows an unknown task to be explicitly queued, completed, failed or cancelled", () => {
    const db = database();
    addProject(db);
    const ledger = new TaskLedger(db);
    ledger.ingestTelegramTask({ updateId: 1, messageId: 1, projectId: "project-1", body: "a", taskId: "a" });
    ledger.transition("a", "running");
    ledger.transition("a", "unknown");
    expect(ledger.transition("a", "queued").state).toBe("queued");
  });

  it("claims one global queued task and binds its thread and turn", () => {
    const db = database();
    addProject(db);
    const ledger = new TaskLedger(db);
    ledger.ingestTelegramTask({ updateId: 10, messageId: 10, projectId: "project-1", body: "first", taskId: "a" }, 10);
    ledger.ingestTelegramTask({ updateId: 11, messageId: 11, projectId: "project-1", body: "second", taskId: "b" }, 11);
    const thread = new ThreadRepository(db).upsert(
      "project-1",
      "codex-thread-1",
      "workspace-write + on-request",
      12,
    );

    expect(ledger.claimNextQueued(13)?.id).toBe("a");
    const bound = ledger.bindCodexContext("a", thread.id, "codex-turn-1", 14);
    expect(bound.threadId).toBe(thread.id);
    expect(bound.turnId).toBe("codex-turn-1");
    expect(ledger.listQueued().map((task) => task.id)).toEqual(["b"]);
    expect(ledger.getNextTelegramOffset()).toBe(12);
  });

  it("records non-task updates idempotently for polling offset advancement", () => {
    const ledger = new TaskLedger(database());
    expect(ledger.recordNonTaskUpdate(50, "committed", "ping", 1)).toBe(true);
    expect(ledger.recordNonTaskUpdate(50, "failed", "must_not_overwrite", 2)).toBe(false);
    expect(ledger.getNextTelegramOffset()).toBe(51);
  });
});
