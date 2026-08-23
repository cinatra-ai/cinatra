// The operational-visibility primitives must NOT be callable by
// delegated-chat assistants. The chat reaches only what the host has
// DECLARED and ADMITTED; a primitive with no admission record is deny-by-
// default. This pins that absence (the actual enforcement) so a future edit
// can't accidentally declare and admit these.

import { describe, expect, it } from "vitest";
import { isCoreDelegatedChatAdmitted } from "@cinatra-ai/mcp-server/core-delegated-chat-surface";

describe("operational primitives are NOT delegated-chat callable", () => {
  for (const name of [
    "freshness_check_for_change_set",
    "remote_effect_attempts_list_for_change_set",
    "remote_effect_attempt_retry",
  ]) {
    it(`${name} is absent from the delegated-chat allowlist`, () => {
      expect(isCoreDelegatedChatAdmitted(name)).toBe(false);
    });
  }
});
