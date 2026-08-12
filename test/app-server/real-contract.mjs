import pino from "pino";
import process from "node:process";

import { AppServerClient } from "../../dist/app-server/client.js";

const client = new AppServerClient({ logger: pino({ level: "silent" }), requestTimeoutMs: 15_000 });
try {
  const initialized = await client.start();
  if (!initialized.userAgent || !initialized.platformOs) throw new Error("initialize 响应缺少关键字段");
  process.stdout.write(`App Server initialize 合约通过：${initialized.platformOs}\n`);
} finally {
  await client.close();
}
