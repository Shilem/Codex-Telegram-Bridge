import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadOrCreateSecret(path: string, bytes: number): Promise<Buffer> {
  try {
    const encoded = (await readFile(path, "utf8")).trim();
    const value = Buffer.from(encoded, "base64url");
    if (value.length !== bytes) throw new Error(`密钥长度无效：${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(bytes);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${secret.toString("base64url")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return secret;
}
