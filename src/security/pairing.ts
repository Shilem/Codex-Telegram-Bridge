import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { BridgeDatabase } from "../storage/database.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;

interface PairingRow {
  id: number;
  code_hash: string;
  telegram_user_id: string;
  private_chat_id: string;
  expires_at: number;
  used_at: number | null;
}

export interface OwnerIdentity {
  readonly id: number;
  readonly telegramUserId: string;
  readonly privateChatId: string;
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class PairingService {
  constructor(private readonly database: BridgeDatabase) {}

  requestCode(telegramUserId: string, privateChatId: string, chatType: string, now = Date.now()): string {
    if (chatType !== "private") throw new AccessDeniedError("Pairing is only available in a private chat");
    if (this.activeOwner() !== null) throw new AccessDeniedError("Pairing is closed because an owner already exists");

    const code = randomBytes(8).toString("hex").toUpperCase();
    const codeHash = hashSecret(code);
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare("DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?")
        .run(now);
      this.database.connection
        .prepare("DELETE FROM pairing_codes WHERE telegram_user_id = ? OR private_chat_id = ?")
        .run(telegramUserId, privateChatId);
      this.database.connection
        .prepare(
          `INSERT INTO pairing_codes(code_hash, telegram_user_id, private_chat_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(codeHash, telegramUserId, privateChatId, now + PAIRING_TTL_MS, now);
    })();
    return code;
  }

  confirmCode(code: string, now = Date.now()): OwnerIdentity {
    return this.database.connection.transaction(() => {
      if (this.activeOwner() !== null) throw new AccessDeniedError("Pairing is already complete");
      const rows = this.database.connection
        .prepare("SELECT * FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?")
        .all(now) as PairingRow[];
      const wanted = Buffer.from(hashSecret(code));
      const match = rows.find((row) => {
        const stored = Buffer.from(row.code_hash);
        return stored.length === wanted.length && timingSafeEqual(stored, wanted);
      });
      if (match === undefined) throw new AccessDeniedError("Pairing code is invalid or expired");

      const result = this.database.connection
        .prepare(
          `INSERT INTO owners(telegram_user_id, private_chat_id, paired_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(match.telegram_user_id, match.private_chat_id, now, now, now);
      this.database.connection.prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ?").run(now, match.id);
      return {
        id: Number(result.lastInsertRowid),
        telegramUserId: match.telegram_user_id,
        privateChatId: match.private_chat_id,
      };
    })();
  }

  authenticate(telegramUserId: string, privateChatId: string, chatType: string): OwnerIdentity {
    if (chatType !== "private") throw new AccessDeniedError("Only private chats are accepted");
    const owner = this.activeOwner();
    if (
      owner === null ||
      owner.telegramUserId !== telegramUserId ||
      owner.privateChatId !== privateChatId
    ) {
      throw new AccessDeniedError("Telegram sender or private chat does not match the paired owner");
    }
    return owner;
  }

  activeOwner(): OwnerIdentity | null {
    const row = this.database.connection
      .prepare(
        "SELECT id, telegram_user_id, private_chat_id FROM owners WHERE revoked_at IS NULL LIMIT 1",
      )
      .get() as { id: number; telegram_user_id: string; private_chat_id: string } | undefined;
    return row === undefined
      ? null
      : { id: row.id, telegramUserId: row.telegram_user_id, privateChatId: row.private_chat_id };
  }
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
