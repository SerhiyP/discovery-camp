import type { MessageEntity } from "grammy/types";

/**
 * Re-bases the admin's own formatting onto the text `/broadcast` actually sends.
 *
 * `sendMessage(id, text)` with a bare string drops every entity, so a link the admin
 * typed arrives as dead plain text — which silently defused the 2026-08-04 phishing
 * drill, where the whole exercise is whether people tap the bait. `ctx.match` is a
 * suffix of the message text (grammY slices off the command and trimStart()s), so the
 * offset shift is just the length difference; Telegram entity offsets and JS string
 * indices are both UTF-16 code units, so no re-encoding is needed.
 *
 * Entities living entirely in the stripped `/broadcast ` prefix (the `bot_command`
 * itself) are dropped; one that straddles the boundary — the admin formatted the
 * command too — is clamped to the part that survives.
 */
export function broadcastEntities(
  fullText: string | undefined,
  match: string,
  entities: MessageEntity[] | undefined,
): MessageEntity[] {
  if (!fullText || !entities?.length) return [];
  const shift = fullText.length - match.length;
  const out: MessageEntity[] = [];
  for (const e of entities) {
    const end = e.offset + e.length;
    if (end <= shift) continue;
    const start = Math.max(e.offset, shift);
    out.push({ ...e, offset: start - shift, length: end - start });
  }
  return out;
}