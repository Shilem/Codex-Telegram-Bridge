import pino from "pino";
import { describe, expect, it } from "vitest";

import type { TaskRecord, TaskStatus } from "../../src/core/types.js";
import type { SchedulableTaskStore, TaskExecutor } from "../../src/scheduler/task-scheduler.js";
import { TaskScheduler } from "../../src/scheduler/task-scheduler.js";

function task(id: string, createdAt: number): TaskRecord {
  return { id, telegramUpdateId: createdAt, sourceMessageId: createdAt, projectId: "p", threadId: null, turnId: null, status: "queued", prompt: id, error: null, createdAt, updatedAt: createdAt };
}

class MemoryStore implements SchedulableTaskStore {
  public readonly tasks = [task("first", 1), task("second", 2)];
  public getTask(id: string): TaskRecord | null { return this.tasks.find((value) => value.id === id) ?? null; }
  public listQueuedTasks(): TaskRecord[] { return this.tasks.filter((value) => value.status === "queued"); }
  public transitionTask(id: string, status: TaskStatus, fields: { error?: string | null } = {}): TaskRecord {
    const current = this.getTask(id);
    if (!current) throw new Error("missing");
    const updated = { ...current, status, error: fields.error ?? current.error };
    this.tasks.splice(this.tasks.indexOf(current), 1, updated);
    return updated;
  }
}

describe("全局单任务调度器", () => {
  it("严格按 FIFO 串行执行任务", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const executor: TaskExecutor = {
      async execute(current) {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        order.push(current.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
      async cancel() {},
    };
    const scheduler = new TaskScheduler(store, executor, pino({ level: "silent" }));
    scheduler.wake();
    while (store.tasks.some((value) => !["completed", "failed"].includes(value.status))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await scheduler.stop();
    expect(order).toEqual(["first", "second"]);
    expect(maximumConcurrent).toBe(1);
  });

  it("取消排队任务时不会调用运行中断", async () => {
    const store = new MemoryStore();
    let cancelCalls = 0;
    const scheduler = new TaskScheduler(store, { execute: () => Promise.resolve(), cancel: () => { cancelCalls += 1; return Promise.resolve(); } }, pino({ level: "silent" }));
    await scheduler.cancel("second");
    expect(store.getTask("second")?.status).toBe("cancelled");
    expect(cancelCalls).toBe(0);
  });
});
