import type { ServerNotification } from "./types.js";

const PRIVATE_NOTIFICATION_METHODS = new Set([
  "item/reasoning/textDelta",
  "rawResponseItem/completed",
  "rawResponse/completed",
]);

/**
 * 上层只有在此函数返回 true 时才能把事件转换成用户可见 Telegram 内容。
 * 推理摘要是 App Server 的公开摘要，可以展示；原始推理和原始 Responses 事件不可展示。
 */
export function isPublicAppServerNotification(notification: ServerNotification): boolean {
  return !PRIVATE_NOTIFICATION_METHODS.has(notification.method);
}

