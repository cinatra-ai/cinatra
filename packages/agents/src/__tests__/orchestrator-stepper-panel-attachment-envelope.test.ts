/**
 * Unit tests for the pure attachment-envelope helpers extracted from
 * `orchestrator-stepper-panel.tsx`. The pair mirrors the server-side
 * precedence in `review-task-actions.ts:255`
 * (userResponse → approvalNote → default) before the wrap.
 *
 * Regression coverage: using `userResponse-or-default` for the wrap base
 * silently clobbers renderer-authored `approvalNote` by injecting
 * `"[Approved by operator]"` into a field of higher server precedence.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-attachment-envelope.test.ts
 */
import { describe, it, expect } from "vitest";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import {
  pickLegacyResumeText,
  applyAttachmentEnvelope,
} from "../attachment-envelope-payload";

const att: LlmAttachmentRef = {
  artifactId: "art-1",
  representationRevisionId: "rep-1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload",
  filename: "deck.pdf",
  title: "deck.pdf",
  size: 3,
};

describe("pickLegacyResumeText", () => {
  it("prefers a non-empty userResponse over approvalNote", () => {
    expect(
      pickLegacyResumeText({
        userResponse: '{"foo":1}',
        approvalNote: "do not use me",
      }),
    ).toBe('{"foo":1}');
  });

  it("falls through whitespace-only userResponse to approvalNote", () => {
    expect(
      pickLegacyResumeText({
        userResponse: "   \t\n  ",
        approvalNote: "the real note",
      }),
    ).toBe("the real note");
  });

  it("trims approvalNote on fallback", () => {
    expect(
      pickLegacyResumeText({
        approvalNote: "  legacy resume text  ",
      }),
    ).toBe("legacy resume text");
  });

  it("falls through whitespace-only approvalNote to the [Approved by operator] default", () => {
    expect(
      pickLegacyResumeText({
        userResponse: "",
        approvalNote: "   ",
      }),
    ).toBe("[Approved by operator]");
  });

  it("returns the default when both keys are missing", () => {
    expect(pickLegacyResumeText({})).toBe("[Approved by operator]");
  });

  it("ignores non-string values for either key", () => {
    expect(
      pickLegacyResumeText({
        userResponse: 42,
        approvalNote: { foo: "bar" },
      } as Record<string, unknown>),
    ).toBe("[Approved by operator]");
  });
});

describe("applyAttachmentEnvelope", () => {
  it("returns the payload unchanged when no attachments are pending", () => {
    const payload = { userResponse: "u", approvalNote: "n", approved: true };
    expect(applyAttachmentEnvelope(payload, [])).toBe(payload);
  });

  it("wraps an existing userResponse and preserves other payload keys", () => {
    const wrapped = applyAttachmentEnvelope(
      { userResponse: '{"x":1}', approved: true, approvedAt: "t" },
      [att],
    );
    expect(wrapped.approved).toBe(true);
    expect(wrapped.approvedAt).toBe("t");
    const decoded = JSON.parse(wrapped.userResponse as string) as {
      text: string;
      attachments: LlmAttachmentRef[];
    };
    expect(decoded.text).toBe('{"x":1}');
    expect(decoded.attachments).toEqual([att]);
  });

  it("uses approvalNote when userResponse is empty (server precedence regression)", () => {
    const wrapped = applyAttachmentEnvelope(
      { approvalNote: '{"offeringCompanyWebsite":"https://example.com"}' },
      [att],
    );
    const decoded = JSON.parse(wrapped.userResponse as string) as {
      text: string;
      attachments: LlmAttachmentRef[];
    };
    // PRECEDENCE FIX: text is the renderer-authored approvalNote, NOT the default.
    expect(decoded.text).toBe(
      '{"offeringCompanyWebsite":"https://example.com"}',
    );
    expect(decoded.attachments).toEqual([att]);
    // The approvalNote stays on the payload — server keeps backward
    // compat for any consumer that still reads it.
    expect(wrapped.approvalNote).toBe(
      '{"offeringCompanyWebsite":"https://example.com"}',
    );
  });

  it("falls back to '[Approved by operator]' when both keys are absent", () => {
    const wrapped = applyAttachmentEnvelope({ approved: true }, [att]);
    const decoded = JSON.parse(wrapped.userResponse as string) as {
      text: string;
    };
    expect(decoded.text).toBe("[Approved by operator]");
  });
});
