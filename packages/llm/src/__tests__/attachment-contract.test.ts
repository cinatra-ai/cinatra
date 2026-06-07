import { describe, expect, it } from "vitest";
import type {
  LlmMessage,
  GenerateInput,
  StreamInput,
  LlmAttachmentRef,
  LlmAttachmentManifest,
  AdapterAttachmentPart,
} from "../types";

// The attachment contract is ADDITIVE: `content` stays a plain string;
// attachments are optional everywhere; a text-only caller compiles and behaves
// byte-for-byte as before. tsgo is the real gate for these type-level
// guarantees; this asserts the shapes exist and are optional at runtime
// construction.

const ref: LlmAttachmentRef = {
  artifactId: "a1",
  representationRevisionId: "v1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload",
};

describe("additive attachment contract", () => {
  it("LlmMessage stays text-only by default; attachments optional", () => {
    const textOnly: LlmMessage = { role: "user", content: "hi" };
    expect(textOnly.attachments).toBeUndefined();
    const withAtt: LlmMessage = {
      role: "user",
      content: "see attached",
      attachments: [ref],
    };
    expect(withAtt.attachments?.[0]?.artifactId).toBe("a1");
  });

  it("LlmMessage carries optional per-turn resolvedAttachments", () => {
    // INTERNAL field set by the orchestration entry points; stream builders
    // prefer a user message's OWN resolvedAttachments over the request-level
    // input.resolvedAttachments. Type-level guarantee — tsgo is the real gate.
    const part: AdapterAttachmentPart = {
      nativeKind: "gemini_file_data",
      providerFileId: "https://generativelanguage.googleapis.com/v1beta/files/x",
      mime: "image/png",
    };
    const textOnly: LlmMessage = { role: "user", content: "hi" };
    expect(textOnly.resolvedAttachments).toBeUndefined();
    const withResolved: LlmMessage = {
      role: "user",
      content: "see attached",
      resolvedAttachments: [part],
    };
    expect(withResolved.resolvedAttachments?.[0]?.providerFileId).toMatch(
      /^https:\/\//,
    );
  });

  it("GenerateInput / StreamInput carry optional attachments without breaking text callers", () => {
    const g: GenerateInput = { system: "s", prompt: "p" }; // legacy, no attachments
    expect("attachments" in g).toBe(false);
    const g2: GenerateInput = { system: "s", prompt: "p", attachments: [ref] };
    expect(g2.attachments).toHaveLength(1);
    const s: StreamInput = {
      system: "s",
      messages: [{ role: "user", content: "x" }],
      attachments: [ref],
      onTextDelta: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onStepStart: () => {},
      onStepEnd: () => {},
      onError: () => {},
    };
    expect(s.attachments?.[0]?.mime).toBe("application/pdf");
  });

  it("LlmAttachmentManifest is structured (anti-hallucination), not UI copy", () => {
    const m: LlmAttachmentManifest = {
      attachedButNotReadable: [
        { ref, reason: "mime application/zip not natively ingestible" },
      ],
    };
    expect(m.attachedButNotReadable[0]?.reason).toMatch(/not natively/);
  });
});
