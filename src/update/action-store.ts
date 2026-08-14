import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

const updateActionSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().regex(/^ctb-update-[0-9a-f-]+$/),
  currentVersion: z.string().min(1),
  expectedVersion: z.string().min(1),
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "running", "succeeded", "failed", "rolled_back"]),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    environment: z.record(z.string(), z.string()),
  }),
  result: z.object({
    exitCode: z.number().int().nullable(),
    reason: z.string().min(1),
  }).optional(),
});

export type UpdateAction = z.infer<typeof updateActionSchema>;
export type TerminalUpdateAction = UpdateAction & {
  status: "succeeded" | "failed" | "rolled_back";
  result: NonNullable<UpdateAction["result"]>;
};

export function updateActionDirectory(stateDirectory: string): string {
  return join(stateDirectory, "update-actions");
}

export function updateActionFile(stateDirectory: string, actionId: string): string {
  if (!/^ctb-update-[0-9a-f-]+$/.test(actionId)) throw new Error("更新动作 ID 无效");
  return join(updateActionDirectory(stateDirectory), `${actionId}.json`);
}

export async function readUpdateAction(filePath: string): Promise<UpdateAction> {
  return updateActionSchema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeUpdateAction(filePath: string, action: UpdateAction): Promise<void> {
  const validated = updateActionSchema.parse(action);
  const directory = dirname(resolve(filePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export function isTerminalUpdateAction(action: UpdateAction): action is TerminalUpdateAction {
  return action.result !== undefined && ["succeeded", "failed", "rolled_back"].includes(action.status);
}
