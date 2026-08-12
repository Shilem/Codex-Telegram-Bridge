const TELEGRAM_TEXT_LIMIT = 4096;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.6)) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < Math.floor(limit * 0.6)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function commandName(text: string): string | null {
  const token = text.trim().split(/\s+/, 1)[0];
  if (!token?.startsWith("/")) return null;
  return token.slice(1).split("@", 1)[0]?.toLowerCase() ?? null;
}
