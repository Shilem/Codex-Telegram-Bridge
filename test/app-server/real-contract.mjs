import pino from "pino";
import process from "node:process";

import { AppServerClient } from "../../dist/app-server/client.js";

const client = new AppServerClient({ logger: pino({ level: "silent" }), requestTimeoutMs: 15_000 });
try {
  const initialized = await client.start();
  if (!initialized.userAgent || !initialized.platformOs) throw new Error("initialize 响应缺少关键字段");
  const collaborationModes = await client.request("collaborationMode/list", {});
  const modes = new Set(collaborationModes.data?.map((entry) => entry.mode));
  if (!modes.has("plan") || !modes.has("default")) {
    throw new Error("collaborationMode/list 未返回 Plan 与 Default 预设");
  }
  process.stdout.write(`App Server initialize 合约通过：${initialized.platformOs}\n`);
  process.stdout.write("App Server collaborationMode/list 合约通过：Plan, Default\n");
} finally {
  await client.close();
}
