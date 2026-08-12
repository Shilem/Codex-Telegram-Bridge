import type { BridgeDatabase } from "../storage/index.js";

export class RuntimeSettings {
  public constructor(private readonly database: BridgeDatabase) {}

  public get(key: string): string | null {
    const row = this.database.connection
      .prepare("SELECT value FROM runtime_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  public set(key: string, value: string): void {
    this.database.connection
      .prepare(
        `INSERT INTO runtime_settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }
}
