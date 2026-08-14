export const TASK_STATUSES = [
  "received",
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type CollaborationMode = "default" | "plan";

export const PERMISSION_PROFILES = [
  "read-only",
  "workspace-write + on-request",
  "danger-full-access",
] as const;

export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  serviceTier: string | null;
  permissionProfile: PermissionProfile;
  enabled: boolean;
}

export interface TaskRecord {
  id: string;
  telegramUpdateId: number;
  sourceMessageId: number;
  projectId: string;
  threadId: string | null;
  turnId: string | null;
  status: TaskStatus;
  collaborationMode: CollaborationMode;
  prompt: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerIdentity {
  telegramUserId: number;
  privateChatId: number;
}

export interface HealthComponent {
  ok: boolean;
  detail: string;
}

export interface HealthSnapshot {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  appServer: HealthComponent;
  codexLogin: HealthComponent;
  database: HealthComponent;
  projects: HealthComponent;
  disk: HealthComponent;
  recentError: string | null;
}

export class BridgeError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly causeDetail?: unknown,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
