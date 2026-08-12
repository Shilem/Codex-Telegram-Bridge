import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "botToken",
  "token",
  "authorization",
  "headers.authorization",
  "config.botToken",
  "prompt",
  "message.text",
  "update.message.text",
] as const;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "codex-telegram-bridge" },
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
