export const TASK_STATES = [
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

export type TaskState = (typeof TASK_STATES)[number];

export const TELEGRAM_UPDATE_STATES = [
  "received",
  "submitted",
  "committed",
  "failed",
  "unknown",
] as const;

export type TelegramUpdateState = (typeof TELEGRAM_UPDATE_STATES)[number];

export const PERMISSION_PROFILES = [
  "read-only",
  "workspace-write + on-request",
  "danger-full-access",
] as const;

export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export interface TaskRecord {
  readonly id: string;
  readonly sourceUpdateId: number;
  readonly sourceMessageId: number;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly state: TaskState;
  readonly body: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly codexThreadId: string;
  readonly permissionProfile: PermissionProfile;
  readonly closedAt: number | null;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly normalizedRoot: string;
  readonly defaultModel: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionProfile: PermissionProfile;
  readonly enabled: boolean;
}
