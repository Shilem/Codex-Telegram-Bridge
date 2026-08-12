export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RequestId = string | number;

export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
    extensions?: Record<string, JsonValue> | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  allowProviderModelFallback?: boolean;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  experimentalRawEvents?: boolean;
}

export interface ThreadResumeParams {
  threadId: string;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  excludeTurns?: boolean;
}

export interface TextUserInput {
  type: "text";
  text: string;
  text_elements: never[];
}

export type UserInput =
  | TextUserInput
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  permissions?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: ReasoningSummary | null;
  outputSchema?: JsonValue | null;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface AppServerThread {
  id: string;
  cwd: string;
  preview: string;
  turns: AppServerTurn[];
  [key: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items: unknown[];
  error: unknown;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: AppServerThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  [key: string]: unknown;
}

export interface ThreadResumeResponse extends ThreadStartResponse {
  initialTurnsPage: unknown;
  turnsBackwardsCursor: string | null;
  itemsBackwardsCursor: string | null;
}

export interface TurnStartResponse {
  turn: AppServerTurn;
}

export type CommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = CommandApprovalDecision;

export interface CommandApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  availableDecisions?: unknown[] | null;
}

export interface FileChangeApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface RequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
}

export interface ServerRequest<P = unknown> {
  id: RequestId;
  method: string;
  params: P;
}

export interface ServerNotification<P = unknown> {
  method: string;
  params: P;
  emittedAtMs?: number;
}

export type KnownServerRequest =
  | ServerRequest<CommandApprovalRequest> & { method: "item/commandExecution/requestApproval" }
  | ServerRequest<FileChangeApprovalRequest> & { method: "item/fileChange/requestApproval" }
  | ServerRequest<RequestUserInputParams> & { method: "item/tool/requestUserInput" };

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}
