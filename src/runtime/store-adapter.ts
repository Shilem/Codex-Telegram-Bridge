import { randomUUID } from "node:crypto";

import type { PermissionProfile, ProjectRecord, TaskRecord, TaskStatus } from "../core/types.js";
import type { RuntimeStore } from "../orchestrator/app-task-executor.js";
import type { SchedulableTaskStore } from "../scheduler/task-scheduler.js";
import { PermissionLeaseManager, ProjectRegistry } from "../security/index.js";
import { TaskLedger, ThreadRepository } from "../storage/index.js";
import type {
  BridgeDatabase,
  PermissionProfile as StoragePermissionProfile,
  ProjectRecord as StorageProjectRecord,
  TaskRecord as StorageTaskRecord,
} from "../storage/index.js";

function mapPermission(value: StoragePermissionProfile): PermissionProfile {
  return value;
}

function mapProject(project: StorageProjectRecord): ProjectRecord {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.normalizedRoot,
    defaultModel: project.defaultModel,
    defaultEffort: project.reasoningEffort,
    serviceTier: project.serviceTier,
    permissionProfile: mapPermission(project.permissionProfile),
    enabled: project.enabled,
  };
}

function mapTask(task: StorageTaskRecord): TaskRecord {
  return {
    id: task.id,
    telegramUpdateId: task.sourceUpdateId,
    sourceMessageId: task.sourceMessageId,
    projectId: task.projectId,
    threadId: task.threadId,
    turnId: task.turnId,
    status: task.state,
    collaborationMode: task.collaborationMode,
    prompt: task.body,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class RuntimeStoreAdapter implements RuntimeStore, SchedulableTaskStore {
  readonly tasks: TaskLedger;
  readonly projects: ProjectRegistry;
  readonly threads: ThreadRepository;
  readonly leases: PermissionLeaseManager;
  #ownerId: number | null = null;

  public constructor(public readonly database: BridgeDatabase) {
    this.tasks = new TaskLedger(database);
    this.projects = new ProjectRegistry(database);
    this.threads = new ThreadRepository(database);
    this.leases = new PermissionLeaseManager(database);
  }

  public setOwnerId(ownerId: number): void {
    this.#ownerId = ownerId;
  }

  public getTask(taskId: string): TaskRecord | null {
    const exists = this.database.connection.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
    return exists ? mapTask(this.tasks.requireTask(taskId)) : null;
  }

  public listQueuedTasks(): TaskRecord[] {
    return this.tasks.listQueued().map(mapTask);
  }

  public transitionTask(
    taskId: string,
    status: TaskStatus,
    fields: { error?: string | null; threadId?: string; turnId?: string } = {},
  ): TaskRecord {
    if (fields.threadId && fields.turnId) this.tasks.bindCodexContext(taskId, fields.threadId, fields.turnId);
    return mapTask(this.tasks.transition(taskId, status, fields.error ?? null));
  }

  public project(projectId: string): ProjectRecord {
    return mapProject(this.projects.require(projectId));
  }

  public codexThreadId(projectId: string, permission: PermissionProfile): string | null {
    const row = this.database.connection
      .prepare(
        `SELECT codex_thread_id FROM threads
         WHERE project_id = ? AND permission_profile = ? AND closed_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(projectId, permission) as { codex_thread_id: string } | undefined;
    return row?.codex_thread_id ?? null;
  }

  public saveThread(
    projectId: string,
    codexThreadId: string,
    permission: PermissionProfile,
    replacedCodexThreadId?: string,
  ): void {
    this.database.connection.transaction(() => {
      if (replacedCodexThreadId) {
        this.database.connection
          .prepare(
            `UPDATE threads SET closed_at = ?, updated_at = ?
             WHERE project_id = ? AND codex_thread_id = ? AND permission_profile = ? AND closed_at IS NULL`,
          )
          .run(Date.now(), Date.now(), projectId, replacedCodexThreadId, permission);
      }
      this.threads.upsert(projectId, codexThreadId, permission);
    })();
  }

  public bindTask(taskId: string, threadId: string, turnId: string): void {
    const row = this.database.connection
      .prepare("SELECT id FROM threads WHERE codex_thread_id = ?")
      .get(threadId) as { id: string } | undefined;
    const localThreadId = row?.id ?? randomUUID();
    if (!row) {
      const task = this.tasks.requireTask(taskId);
      const project = this.projects.require(task.projectId);
      this.database.connection
        .prepare(
          `INSERT INTO threads(id, project_id, codex_thread_id, permission_profile, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(localThreadId, task.projectId, threadId, project.permissionProfile, Date.now(), Date.now());
    }
    this.tasks.bindCodexContext(taskId, localThreadId, turnId);
  }

  public appendTaskEvent(taskId: string, sequence: number, eventType: string, payload: unknown): void {
    this.tasks.appendEvent(taskId, sequence, eventType, payload);
  }

  public dangerLeaseActive(projectId: string): boolean {
    if (this.#ownerId === null) {
      const owner = this.database.connection
        .prepare("SELECT id FROM owners WHERE revoked_at IS NULL LIMIT 1")
        .get() as { id: number } | undefined;
      this.#ownerId = owner?.id ?? null;
    }
    return this.#ownerId !== null && this.leases.isActive(projectId, this.#ownerId);
  }

  public disarmPlanMode(projectId: string): void {
    this.database.connection
      .prepare("DELETE FROM runtime_settings WHERE key = ?")
      .run(`plan_mode:${projectId}`);
  }
}
