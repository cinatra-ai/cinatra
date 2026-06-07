import { describe, expect, it, vi } from "vitest";
import {
  resolveAttachments,
  manifestToModelText,
} from "../attachments/resolve-attachments";
import type { LlmAttachmentRef } from "../types";

// Resolver and manifest degradation core.

const pdf: LlmAttachmentRef = {
  artifactId: "a-pdf",
  representationRevisionId: "v1",
  digest: "sha:1",
  mime: "application/pdf",
  originKind: "upload",
  title: "report.pdf",
};
const zip: LlmAttachmentRef = {
  artifactId: "a-zip",
  representationRevisionId: "v2",
  digest: "sha:2",
  mime: "application/zip",
  originKind: "upload",
  title: "bundle.zip",
};

describe("resolveAttachments", () => {
  it("no attachments → empty, no manifest", async () => {
    const r = await resolveAttachments({
      attachments: undefined,
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => null,
        providerUpload: async () => ({ providerFileId: "x", mime: "application/pdf", sizeBytes: 4096 }),
        cachePut: () => {},
      },
    });
    expect(r.readable).toHaveLength(0);
    expect(r.manifest).toBeNull();
  });

  it("legacy Gemini cache value `files/<id>` is treated as a MISS (self-heal)", async () => {
    const providerUpload = vi.fn(async () => ({ providerFileId: "https://gen/v1beta/files/fresh", mime: "application/pdf", sizeBytes: 4096 }));
    const cachePut = vi.fn(() => {});
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "gemini",
      model: "gemini-2.5-flash",
      ports: { cacheGet: () => ({ providerFileId: "files/legacy-bad", mime: "application/pdf", sizeBytes: 4096 }), providerUpload, cachePut },
    });
    // The bad bare resource name must NOT be emitted — re-upload instead.
    expect(providerUpload).toHaveBeenCalledTimes(1);
    expect(r.readable[0]).toMatchObject({
      nativeKind: "gemini_file_data",
      providerFileId: "https://gen/v1beta/files/fresh",
    });
  });

  it("a proper Gemini URI cache value is still honored (no re-upload)", async () => {
    const providerUpload = vi.fn(async () => ({ providerFileId: "should-not-be-called", mime: "application/pdf", sizeBytes: 4096 }));
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "gemini",
      model: "gemini-2.5-flash",
      ports: {
        cacheGet: () => ({ providerFileId: "https://generativelanguage.googleapis.com/v1beta/files/ok", mime: "application/pdf", sizeBytes: 4096 }),
        providerUpload,
        cachePut: () => {},
      },
    });
    expect(providerUpload).not.toHaveBeenCalled();
    expect(r.readable[0]?.providerFileId).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/ok",
    );
  });

  it("cache HIT with mime MISMATCH is treated as a miss → re-upload", async () => {
    const providerUpload = vi.fn(async () => ({ providerFileId: "fresh", mime: "application/pdf", sizeBytes: 4096 }));
    const r = await resolveAttachments({
      attachments: [pdf], // ref.mime = application/pdf
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => ({ providerFileId: "stale-id", mime: "application/zip", sizeBytes: 4096 }),
        providerUpload,
        cachePut: () => {},
      },
    });
    expect(providerUpload).toHaveBeenCalledTimes(1);
    expect(r.readable[0]?.providerFileId).toBe("fresh");
  });

  it("cache HIT exceeding cap.maxBytes is treated as a miss → re-upload", async () => {
    const providerUpload = vi.fn(async () => ({ providerFileId: "fresh-small", mime: "application/pdf", sizeBytes: 4096 }));
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "openai", // openai cap = 32 MB
      model: "gpt-5.5",
      ports: {
        cacheGet: () => ({ providerFileId: "stale-huge", mime: "application/pdf", sizeBytes: 99 * 1024 * 1024 }),
        providerUpload,
        cachePut: () => {},
      },
    });
    expect(providerUpload).toHaveBeenCalledTimes(1);
    expect(r.readable[0]?.providerFileId).toBe("fresh-small");
  });

  it("emitted readable[].mime is the AUTHORITATIVE one (cache row), NOT ref.mime", async () => {
    // The resolver should propagate the cache row's stored mime to the
    // adapter triple. If ref says X but the cache row says X too (a
    // legitimate hit), readable[].mime is X (and the test above proves
    // a mismatch forces re-upload — so by construction the emitted mime
    // is always authoritative).
    const providerUpload = vi.fn(async () => ({ providerFileId: "u", mime: "application/pdf", sizeBytes: 4096 }));
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => ({ providerFileId: "cached", mime: "application/pdf", sizeBytes: 4096 }),
        providerUpload,
        cachePut: () => {},
      },
    });
    expect(providerUpload).not.toHaveBeenCalled();
    expect(r.readable[0]?.mime).toBe("application/pdf");
  });

  it("cache MISS → upload + cachePut(ttl); native part", async () => {
    const cachePut = vi.fn();
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      ports: {
        cacheGet: () => null,
        providerUpload: async () => ({ providerFileId: "uploaded-1", mime: "application/pdf", sizeBytes: 4096 }),
        cachePut,
      },
    });
    // cachePut receives an authoritative value object {providerFileId,
    // mime, sizeBytes, ttlMs} sourced from the upload return — NEVER
    // ref.mime / ref.size.
    expect(cachePut).toHaveBeenCalledWith(pdf, "anthropic", {
      providerFileId: "uploaded-1",
      mime: "application/pdf",
      sizeBytes: 4096,
      ttlMs: expect.any(Number),
    });
    expect(r.readable[0]).toMatchObject({
      nativeKind: "anthropic_document",
      providerFileId: "uploaded-1",
    });
  });

  it("non-ingestible (zip) → manifest entry, never dropped, never readable", async () => {
    const r = await resolveAttachments({
      attachments: [pdf, zip],
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => ({ providerFileId: "c", mime: "application/pdf", sizeBytes: 4096 }),
        providerUpload: async () => ({ providerFileId: "u", mime: "application/pdf", sizeBytes: 4096 }),
        cachePut: () => {},
      },
    });
    expect(r.readable).toHaveLength(1); // pdf only
    expect(r.manifest?.attachedButNotReadable).toHaveLength(1);
    expect(r.manifest?.attachedButNotReadable[0]?.ref.artifactId).toBe("a-zip");
    expect(r.manifest?.attachedButNotReadable[0]?.reason).toMatch(/not natively ingestible/);
  });

  it("provider upload failure degrades that attachment to the manifest (turn proceeds)", async () => {
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "gemini",
      model: "gemini-2.5-flash",
      ports: {
        cacheGet: () => null,
        providerUpload: async () => {
          throw new Error("429 rate limited");
        },
        cachePut: () => {},
      },
    });
    expect(r.readable).toHaveLength(0);
    expect(r.manifest?.attachedButNotReadable[0]?.reason).toMatch(
      /provider upload failed: 429/,
    );
  });

  it("cacheGet outage is a MISS (upload proceeds) — NOT a manifest degradation", async () => {
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => {
          throw new Error("db cache read down");
        },
        providerUpload: async () => ({ providerFileId: "uploaded-after-cache-miss", mime: "application/pdf", sizeBytes: 4096 }),
        cachePut: () => {},
      },
    });
    expect(r.manifest).toBeNull();
    expect(r.readable[0]?.providerFileId).toBe("uploaded-after-cache-miss");
  });

  it("cachePut failure after a successful upload stays READABLE (best-effort)", async () => {
    const r = await resolveAttachments({
      attachments: [pdf],
      provider: "openai",
      model: "gpt-5.5",
      ports: {
        cacheGet: () => null,
        providerUpload: async () => ({ providerFileId: "uploaded-1", mime: "application/pdf", sizeBytes: 4096 }),
        cachePut: () => {
          throw new Error("cache write down");
        },
      },
    });
    expect(r.manifest).toBeNull();
    expect(r.readable[0]?.providerFileId).toBe("uploaded-1");
  });

  it("manifestToModelText is a structured system note (anti-hallucination)", () => {
    const text = manifestToModelText({
      attachedButNotReadable: [
        { ref: zip, title: "bundle.zip", size: 1234, reason: "mime application/zip not natively ingestible" },
      ],
    });
    expect(text).toMatch(/system note, not user text/);
    expect(text).toMatch(/Do not invent or assume their contents/);
    expect(text).toMatch(/bundle\.zip.*NOT readable/);
  });
});
