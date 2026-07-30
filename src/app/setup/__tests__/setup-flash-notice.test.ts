// cinatra#2094 F9 — the setup wizard's PARTIAL-SUCCESS flash channel.
//
// The OpenAI key save can now succeed while the connection-service copy does not
// (see the F9 note in openai-connector `actions-core.saveConnection`). That is
// neither an error nor a clean success: the step's own "OpenAI connection saved"
// alert reads off DB readiness and is genuinely true, so without a distinct flash
// the partial state would be visible only in the notification centre.
//
// The connector rides the outcome on `?notice=<code>` of the SUCCESS target. This
// pins that the code it emits is (a) mapped here, (b) mapped on the `notice`
// param — not `error` — and (c) rendered as a WARNING, so the tone matches "saved
// and usable, but incomplete". The literal below is drift-pinned to the
// connector's `OPENAI_PARTIAL_SAVE_NOTICE_CODE`; core cannot import from an
// extension, and a drift means the toast silently stops firing, which is what this
// test exists to catch.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SETUP_ERROR_MESSAGES, SETUP_FLASH_TOASTS, SETUP_NOTICE_MESSAGES } from "../setup-flash";
import {
  OPENAI_PARTIAL_SAVE_NOTICE_CODE as CORE_CODE,
  OPENAI_PARTIAL_SAVE_NOTICE_MESSAGE,
} from "@/lib/openai-partial-save-notice";

const OPENAI_PARTIAL_SAVE_NOTICE_CODE = "openai-connection-service-not-synced";

describe("setup flash — the notice (partial-success) channel", () => {
  it("maps the connector's partial-save code", () => {
    expect(Object.keys(SETUP_NOTICE_MESSAGES)).toContain(OPENAI_PARTIAL_SAVE_NOTICE_CODE);
  });

  it("renders it on `notice` as a WARNING, never on the `error` channel", () => {
    const entry = SETUP_FLASH_TOASTS.find((t) => t.value === OPENAI_PARTIAL_SAVE_NOTICE_CODE);
    expect(entry).toBeDefined();
    expect(entry?.param).toBe("notice");
    expect(entry?.variant).toBe("warning");
    expect(Object.keys(SETUP_ERROR_MESSAGES)).not.toContain(OPENAI_PARTIAL_SAVE_NOTICE_CODE);
  });

  it("keeps the codes-only protocol: every entry carries a STATIC non-empty message", () => {
    expect(SETUP_FLASH_TOASTS.length).toBe(
      Object.keys(SETUP_ERROR_MESSAGES).length + Object.keys(SETUP_NOTICE_MESSAGES).length,
    );
    for (const entry of SETUP_FLASH_TOASTS) {
      expect(entry.message.trim().length, entry.value).toBeGreaterThan(0);
      expect(["error", "notice"]).toContain(entry.param);
      expect(entry.param === "error" ? "error" : "warning").toBe(entry.variant);
    }
  });

  it("core's own literal matches the connector's", () => {
    expect(CORE_CODE).toBe(OPENAI_PARTIAL_SAVE_NOTICE_CODE);
  });
});

// The connector's degraded save redirects to whatever `redirectTo` the FORM sent.
// The setup wizard sends `/setup/ai`; the LLM admin modal sends
// `/configuration/llm?modal=openai` and posts to the PLAIN server action (not the
// schema-config `runWrite` path that maps the outcome to a banner). So the admin
// page needs its own `?notice=` entry, or the partial save reads there as a clean
// success and survives only in the notification centre — the silent success this
// whole outcome channel exists to prevent.
describe("the LLM admin surface renders the same partial-save notice", () => {
  const source = readFileSync(
    path.join(__dirname, "../../configuration/llm/apis-page.tsx"),
    "utf8",
  );

  it("mounts a `notice` toast for the partial-save code", () => {
    expect(source).toContain("OPENAI_PARTIAL_SAVE_NOTICE_CODE");
    expect(source).toMatch(/param:\s*"notice"/);
  });

  it("renders it as a WARNING, with the shared static message", () => {
    expect(source).toContain("OPENAI_PARTIAL_SAVE_NOTICE_MESSAGE");
    expect(source).toMatch(/variant:\s*"warning"/);
    // Codes-only: the message is the shared constant, never URL-derived text.
    expect(OPENAI_PARTIAL_SAVE_NOTICE_MESSAGE.trim().length).toBeGreaterThan(0);
  });

  it("keeps the pre-existing `saved` flash", () => {
    expect(source).toMatch(/param:\s*"saved"/);
  });
});
