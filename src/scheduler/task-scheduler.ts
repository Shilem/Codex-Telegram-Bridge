import { EventEmitter } from "node:events";

import type { Logger } from "pino";

import type { TaskRecord, TaskStatus } from "../core/types.js";
import { BridgeError, errorMessage } from "../core/types.js";

export interface SchedulableTaskStore {
  getTask(taskId: string): TaskRecord | null;
  listQueuedTasks(): TaskRecord[];
  transitionTask(taskId: string, status: TaskStatus, fields?: { error?: string | null; threadId?: string; turnId?: string }): TaskRecord;
}

export interface TaskExecutor {
  execute(task: TaskRecord): Promise<void>;
  cancel(task: TaskRecord): Promise<void>;
}

export interface TaskSchedulerEvents {
  status: [task: TaskRecord];
}

export class TaskScheduler extends EventEmitter<TaskSchedulerEvents> {
  #runningTask: TaskRecord | null = null;
  #drainPromise: Promise<void> | null = null;
  #stopping = false;

  public constructor(
    private readonly store: SchedulableTaskStore,
    private readonly executor: TaskExecutor,
    private readonly logger: Logger,
  ) {
    super();
  }

  public get currentTask(): TaskRecord | null {
    return this.#runningTask;
  }

  public queuePosition(taskId: string): number | null {
    const position = this.store.listQueuedTasks().findIndex((task) => task.id === taskId);
    return position < 0 ? null : position + (this.#runningTask ? 1 : 0);
  }

  public wake(): void {
    if (!this.#drainPromise) {
      this.#drainPromise = this.#drain().finally(() => {
        this.#drainPromise = null;
        if (!this.#stopping && this.store.listQueuedTasks().length > 0) this.wake();
      });
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      const task = this.store.listQueuedTasks()[0];
      if (!task) return;
      this.#runningTask = this.store.transitionTask(task.id, "running");
      this.emit("status", this.#runningTask);
      try {
        await this.executor.execute(this.#runningTask);
        const latest = this.store.getTask(task.id);
        if (latest?.status === "running") {
          this.#runningTask = this.store.transitionTask(task.id, "completed");
          this.emit("status", this.#runningTask);
        }
      } catch (error) {
        const latest = this.store.getTask(task.id);
        if (latest && !["cancelled", "unknown"].includes(latest.status)) {
          this.#runningTask = this.store.transitionTask(task.id, "failed", { error: errorMessage(error) });
          this.emit("status", this.#runningTask);
        }
        this.logger.error({ taskId: task.id, error: errorMessage(error) }, "任务执行失败");
      } finally {
        this.#runningTask = null;
      }
    }
  }

  public async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.store.getTask(taskId);
    if (!task) throw new BridgeError("任务不存在", "TASK_NOT_FOUND");
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      throw new BridgeError("任务已结束，无法取消", "TASK_ALREADY_FINISHED");
    }
    const cancelled = this.store.transitionTask(task.id, "cancelled");
    this.emit("status", cancelled);
    if (this.#runningTask?.id === task.id) await this.executor.cancel(cancelled);
    return cancelled;
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#runningTask) {
      const current = this.store.getTask(this.#runningTask.id);
      if (current && ["running", "waiting_input", "waiting_approval"].includes(current.status)) {
        const interrupted = this.store.transitionTask(current.id, "unknown", {
          error: "服务停止时任务仍在运行，需要人工确认状态",
        });
        this.emit("status", interrupted);
        await this.executor.cancel(interrupted);
      }
    }
    await this.#drainPromise;
  }
}
