import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { migrations } from "./schema.js";

export class BridgeDatabase {
  readonly connection: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.connection = new Database(filename);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("synchronous = FULL");
    this.connection.pragma("busy_timeout = 5000");
    this.applyMigrations();
  }

  close(): void {
    this.connection.close();
  }

  recoverInterruptedWork(now = Date.now()): { tasks: number; updates: number } {
    return this.connection.transaction(() => {
      const tasks = this.connection
        .prepare("UPDATE tasks SET state = 'unknown', updated_at = ? WHERE state IN ('running', 'waiting_input', 'waiting_approval')")
        .run(now).changes;
      this.connection
        .prepare("UPDATE approvals SET decision = 'cancel', decided_at = ? WHERE decision IS NULL")
        .run(now);
      const updates = this.connection
        .prepare("UPDATE telegram_updates SET status = 'unknown', updated_at = ? WHERE status = 'submitted'")
        .run(now).changes;
      return { tasks, updates };
    })();
  }

  private applyMigrations(): void {
    const hasMigrationTable = this.connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    const applied = new Set<number>();
    if (hasMigrationTable !== undefined) {
      const rows = this.connection.prepare("SELECT version FROM schema_migrations").all() as Array<{
        version: number;
      }>;
      for (const row of rows) applied.add(row.version);
      const maximum = Math.max(0, ...applied);
      const supported = migrations.at(-1)?.version ?? 0;
      if (maximum > supported) {
        this.connection.close();
        throw new Error(`数据库版本 ${String(maximum)} 高于程序支持版本 ${String(supported)}，拒绝降级写入`);
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      })();
    }
  }
}
