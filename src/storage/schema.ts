export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_security_and_task_ledger",
    sql: `
      CREATE TABLE owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT NOT NULL UNIQUE,
        private_chat_id TEXT NOT NULL UNIQUE,
        paired_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX owners_single_active
        ON owners ((1)) WHERE revoked_at IS NULL;

      CREATE TABLE pairing_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        telegram_user_id TEXT NOT NULL,
        private_chat_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_root TEXT NOT NULL UNIQUE,
        default_model TEXT,
        reasoning_effort TEXT,
        permission_profile TEXT NOT NULL DEFAULT 'workspace-write + on-request'
          CHECK (permission_profile IN ('read-only', 'workspace-write + on-request', 'danger-full-access')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        codex_thread_id TEXT NOT NULL UNIQUE,
        permission_profile TEXT NOT NULL,
        closed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE telegram_updates (
        update_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('received', 'submitted', 'committed', 'failed', 'unknown')),
        task_id TEXT,
        result_code TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        source_update_id INTEGER NOT NULL UNIQUE REFERENCES telegram_updates(update_id) ON DELETE RESTRICT,
        source_message_id INTEGER NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('received', 'queued', 'running', 'waiting_input', 'waiting_approval', 'completed', 'failed', 'cancelled', 'unknown')),
        body TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX tasks_state_created ON tasks (state, created_at);

      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (task_id, sequence)
      );

      CREATE TABLE approvals (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        decision TEXT CHECK (decision IN ('accept', 'accept_for_session', 'decline', 'cancel')),
        decided_at INTEGER,
        result_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX approvals_expiry ON approvals (expires_at, decided_at);

      CREATE TABLE permission_leases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX permission_leases_active
        ON permission_leases (project_id, owner_id, expires_at, revoked_at);

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        project_id TEXT,
        actor_fingerprint TEXT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX audit_events_created ON audit_events (created_at);

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TRIGGER telegram_updates_task_fk_insert
      BEFORE INSERT ON telegram_updates
      WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id)
      BEGIN SELECT RAISE(ABORT, 'telegram update task does not exist'); END;

      CREATE TRIGGER telegram_updates_task_fk_update
      BEFORE UPDATE OF task_id ON telegram_updates
      WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id)
      BEGIN SELECT RAISE(ABORT, 'telegram update task does not exist'); END;
    `,
  },
  {
    version: 2,
    name: "bind_tasks_to_codex_turns",
    sql: "ALTER TABLE tasks ADD COLUMN turn_id TEXT;",
  },
  {
    version: 3,
    name: "runtime_settings",
    sql: `
      CREATE TABLE runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: "approval_action_identity",
    sql: `
      ALTER TABLE approvals RENAME TO approvals_legacy;
      CREATE TABLE approvals (
        action_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        decision TEXT CHECK (decision IN ('accept', 'accept_for_session', 'decline', 'cancel')),
        decided_at INTEGER,
        result_json TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO approvals(action_id, request_id, thread_id, turn_id, item_id, nonce_hash, expires_at, decision, decided_at, result_json, created_at)
      SELECT nonce_hash, request_id, thread_id, turn_id, item_id, nonce_hash, expires_at, decision, decided_at, result_json, created_at
      FROM approvals_legacy;
      DROP TABLE approvals_legacy;
      CREATE INDEX approvals_expiry ON approvals (expires_at, decided_at);
      CREATE INDEX approvals_request ON approvals (request_id, thread_id, turn_id, item_id);
    `,
  },
];
