import { describe, it, expect, vi } from "vitest";
import { resolveEntryAttachments } from "../attachments/entry-resolve";
import type { AttachmentResolverPorts } from "../attachments/resolve-attachments";
import type { LlmAttachmentRef } from "../types";

// Shared orchestration-entry attachment resolution step. Load-bearing: no
// attachments leaves the system prompt unchanged and omits resolvedAttachments.
// Missing resolver ports with attachments, or non-ingestible attachments,
// prepend a manifest to the system prompt and are never silently dropped.

const SYS = "you are a helpful assistant";

function ref(mime: string, extra?: Partial<LlmAttachmentRef>): LlmAttachmentRef {
  return {
    artifactId: "art1",
    representationRevisionId: "ver1",
    digest: "sha256:abc",
    mime,
    originKind: "upload",
    ...extra,
  };
}

function ports(overrides?: Partial<AttachmentResolverPorts>): AttachmentResolverPorts {
  return {
    cacheGet: vi.fn(async () => null),
    providerUpload: vi.fn(async () => ({
      providerFileId: "file_uploaded",
      mime: "application/pdf",
      sizeBytes: 4096,
    })),
    cachePut: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("resolveEntryAttachments", () => {
  it("no attachments → byte-identical no-op (system unchanged, no parts)", async () => {
    const out = await resolveEntryAttachments({
      attachments: undefined,
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out).toEqual({ system: SYS });
    expect("resolvedAttachments" in out).toBe(false);
  });

  it("attachments present but NO ports → MANIFEST PREPENDED", async () => {
    // No ports means the entry point cannot resolve refs (e.g. bridge
    // could not bind a request to a run.orgId). The attachment signal
    // must NOT be silently dropped — the model is told the file exists
    // and is not readable.
    const out = await resolveEntryAttachments({
      attachments: [
        ref("application/pdf", { title: "needed.pdf" }),
      ],
      ports: undefined,
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.resolvedAttachments).toBeUndefined();
    expect(out.system).not.toBe(SYS);
    expect(out.system.startsWith("[ATTACHMENTS")).toBe(true);
    expect(out.system).toContain("resolver unavailable for this run");
    expect(out.system).toContain("needed.pdf");
    expect(out.system.endsWith(SYS)).toBe(true);
  });

  it("ingestible + cache MISS → upload + cachePut → native part, ref stripped", async () => {
    const p = ports();
    const out = await resolveEntryAttachments({
      attachments: [ref("application/pdf")],
      ports: p,
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.system).toBe(SYS); // no manifest — fully readable
    expect(out.resolvedAttachments).toEqual([
      {
        nativeKind: "openai_input_file",
        providerFileId: "file_uploaded",
        mime: "application/pdf",
      },
    ]);
    // The resolver's `ref` must NOT leak to the adapter triple.
    expect(out.resolvedAttachments?.[0]).not.toHaveProperty("ref");
    expect(p.providerUpload).toHaveBeenCalledTimes(1);
    expect(p.cachePut).toHaveBeenCalledTimes(1);
  });

  it("ingestible + cache HIT → no upload", async () => {
    const p = ports({
      cacheGet: vi.fn(async () => ({
        providerFileId: "file_cached",
        mime: "application/pdf",
        sizeBytes: 4096,
      })),
    });
    const out = await resolveEntryAttachments({
      attachments: [ref("application/pdf")],
      ports: p,
      provider: "anthropic",
      model: "claude-x",
      system: SYS,
    });
    expect(out.resolvedAttachments).toEqual([
      {
        nativeKind: "anthropic_document",
        providerFileId: "file_cached",
        mime: "application/pdf",
      },
    ]);
    expect(p.providerUpload).not.toHaveBeenCalled();
  });

  it("non-ingestible → manifest PREPENDED to system, no parts", async () => {
    const out = await resolveEntryAttachments({
      attachments: [ref("application/zip", { title: "bundle.zip" })],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.resolvedAttachments).toBeUndefined();
    expect(out.system).not.toBe(SYS);
    expect(out.system.startsWith("[ATTACHMENTS")).toBe(true);
    expect(out.system.endsWith(SYS)).toBe(true);
    expect(out.system).toContain("NOT readable");
  });

  it("mixed → readable becomes parts AND non-readable becomes manifest", async () => {
    const out = await resolveEntryAttachments({
      attachments: [
        ref("application/pdf", { filename: "ok.pdf" }),
        ref("application/zip", { filename: "no.zip", artifactId: "art2" }),
      ],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.resolvedAttachments).toHaveLength(1);
    expect(out.resolvedAttachments?.[0]?.nativeKind).toBe("openai_input_file");
    expect(out.system.startsWith("[ATTACHMENTS")).toBe(true);
    expect(out.system).toContain("no.zip");
  });
});

import { resolveStreamMessageAttachments } from "../attachments/entry-resolve";

describe("resolveStreamMessageAttachments", () => {
  it("no attachments anywhere → byte-identical (system unchanged, messages stripped of any caller-smuggled resolvedAttachments)", async () => {
    const out = await resolveStreamMessageAttachments({
      messages: [
        { role: "user", content: "hi" },
        // Caller-smuggled resolvedAttachments must be dropped even with no
        // attachments present.
        ({ role: "assistant", content: "hello", resolvedAttachments: [{
          nativeKind: "openai_input_file",
          providerFileId: "smuggled",
          mime: "application/pdf",
        }] } as { role: "assistant"; content: string }),
      ],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.system).toBe(SYS);
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(out.messages[1]).not.toHaveProperty("resolvedAttachments");
  });

  it("per-message resolution: EACH user turn with attachments gets its own resolvedAttachments", async () => {
    const out = await resolveStreamMessageAttachments({
      messages: [
        { role: "user", content: "turn 1", attachments: [ref("application/pdf", { artifactId: "a1" })] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "turn 2", attachments: [ref("application/pdf", { artifactId: "a2" })] },
      ],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    // Both user turns have resolved native parts; assistant unchanged.
    expect(out.messages[0]?.resolvedAttachments).toEqual([
      { nativeKind: "openai_input_file", providerFileId: "file_uploaded", mime: "application/pdf" },
    ]);
    expect(out.messages[1]?.resolvedAttachments).toBeUndefined();
    expect(out.messages[2]?.resolvedAttachments).toEqual([
      { nativeKind: "openai_input_file", providerFileId: "file_uploaded", mime: "application/pdf" },
    ]);
    expect(out.system).toBe(SYS); // every ref ingestible ⇒ no manifest
  });

  it("attachments + no ports → aggregated MANIFEST in system", async () => {
    const out = await resolveStreamMessageAttachments({
      messages: [
        { role: "user", content: "first", attachments: [ref("application/pdf", { title: "doc1.pdf" })] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second", attachments: [ref("application/pdf", { title: "doc2.pdf" })] },
      ],
      ports: undefined,
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    expect(out.system.startsWith("[ATTACHMENTS")).toBe(true);
    expect(out.system).toContain("doc1.pdf");
    expect(out.system).toContain("doc2.pdf");
    expect(out.system).toContain("resolver unavailable");
    // No silent native part emission.
    expect(out.messages[0]?.resolvedAttachments).toBeUndefined();
    expect(out.messages[2]?.resolvedAttachments).toBeUndefined();
  });

  it("MIXED turn [pdf, zip]: pdf emitted natively, ONLY zip in manifest", async () => {
    // The over-aggregation bug: showing the model "ok.pdf is not readable"
    // while ALSO emitting ok.pdf as a native part contradicts the attachment
    // contract. The manifest must list ONLY refs that genuinely
    // failed to ingest this turn.
    const out = await resolveStreamMessageAttachments({
      messages: [
        {
          role: "user",
          content: "look",
          attachments: [
            ref("application/pdf", { filename: "ok.pdf" }),
            ref("application/zip", { filename: "no.zip", artifactId: "art2" }),
          ],
        },
      ],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    // Native part for the pdf.
    expect(out.messages[0]?.resolvedAttachments).toEqual([
      { nativeKind: "openai_input_file", providerFileId: "file_uploaded", mime: "application/pdf" },
    ]);
    // Manifest mentions ONLY the zip — never the pdf.
    expect(out.system).toContain("no.zip");
    expect(out.system).not.toContain("ok.pdf");
  });

  it("caller-smuggled messages[].resolvedAttachments is DROPPED", async () => {
    const out = await resolveStreamMessageAttachments({
      messages: [
        ({
          role: "user",
          content: "hi",
          // Caller tries to smuggle a provider file id directly to the adapter.
          resolvedAttachments: [{
            nativeKind: "openai_input_file",
            providerFileId: "smuggled-file",
            mime: "application/pdf",
          }],
        } as { role: "user"; content: string }),
      ],
      ports: ports(),
      provider: "openai",
      model: "gpt-5.5",
      system: SYS,
    });
    // No attachments → resolvedAttachments stays undefined (the smuggled
    // field is NOT propagated, even when ports are available).
    expect(out.messages[0]?.resolvedAttachments).toBeUndefined();
  });
});
