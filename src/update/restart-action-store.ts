import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

const restartCommandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()),
});

const restartActionSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().regex(/^ctb-restart-[0-9a-f-]+$/),
  sourceUpdateId: z.number().int().nonnegative().optional(),
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "launching", "running", "succeeded", "failed"]),
  commands: z.array(restartCommandSchema).min(1),
  environment: z.record(z.string(), z.string()),
  result: z.object({
    exitCode: z.number().int().nullable(),
    reason: z.string().min(1),
  }).optional(),
});

export type RestartAction = z.infer<typeof restartActionSchema>;
export type TerminalRestartAction = RestartAction & {
  status: "succeeded" | "failed";
  result: NonNullable<RestartAction["result"]>;
};

export function restartActionDirectory(stateDirectory: string): string {
  return join(stateDirectory, "restart-actions");
}

export function restartActionFile(stateDirectory: string, actionId: string): string {
  if (!/^ctb-restart-[0-9a-f-]+$/.test(actionId)) throw new Error("重启动作 ID 无效");
  return join(restartActionDirectory(stateDirectory), `${actionId}.json`);
}

export async function readRestartAction(filePath: string): Promise<RestartAction> {
  return restartActionSchema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeRestartAction(filePath: string, action: RestartAction): Promise<void> {
  const validated = restartActionSchema.parse(action);
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

export function isTerminalRestartAction(action: RestartAction): action is TerminalRestartAction {
  return action.result !== undefined && ["succeeded", "failed"].includes(action.status);
}
