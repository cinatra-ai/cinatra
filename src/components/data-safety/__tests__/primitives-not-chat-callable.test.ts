// The operational-visibility primitives must NOT be callable by
// delegated-chat assistants. The chat uses
// a strict ALLOWED_EXACT allowlist; a primitive absent from it is deny-by-
// default. This pins that absence (the actual enforcement) so a future edit
// can't accidentally add these to the chat allowlist.

import { describe, expect, it } from "vitest";
import { isDelegatedChatMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

describe("operational primitives are NOT delegated-chat callable", () => {
  for (const name of [
    "freshness_check_for_change_set",
    "remote_effect_attempts_list_for_change_set",
    "remote_effect_attempt_retry",
  ]) {
    it(`${name} is absent from the delegated-chat allowlist`, () => {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(false);
    });
  }
});
