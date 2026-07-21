import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "../attachments/capability-registry";

// cinatra#1891 DEFECT-3 — REAL-SURFACE contract for the attachment→File shape
// the OpenAI provider builds. NOT a hand-authored File: this drives the ACTUAL
// `createOpenAIProviderAdapter(...).uploadFile()` code path, which constructs
// `new File([bytes], input.filename, { type: input.mimeType })` (openai.ts) and
// hands it to `client.files.create`. Only the network transport (files.create)
// is stubbed — the File itself is built by the real provider. OpenAI's
// `input_file` / context-stuffing path derives the file FORMAT from the File's
// NAME extension, so an extensionless name is a deterministic 400 (the exact
// live-walk failure). This locks the shape hermetically; the opt-in
// live-provider smoke (matcher-live-provider.smoke.test.ts) + the staged walk
// prove it against the real OpenAI API.

vi.mock("server-only", () => ({}));

const filesCreateMock = vi.fn();
vi.mock("openai", () => {
  class MockOpenAI {
    files = { create: filesCreateMock };
    responses = { create: vi.fn() };
    constructor(_config: unknown) {}
  }
  return { default: MockOpenAI };
});

// openai.ts resolves logging/headers through the provider-surface capability
// resolver; stub it so the adapter module loads without app deps (it is not
// exercised by uploadFile).
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(() => {
    throw new Error("not installed");
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import { createOpenAIProviderAdapter } from "../providers/openai";

describe("OpenAI provider builds the input_file File with a provider-recognized name (cinatra#1891 DEFECT-3)", () => {
  beforeEach(() => {
    filesCreateMock.mockReset().mockResolvedValue({ id: "file_abc" });
  });

  it("uploadFile constructs a REAL File whose name+type come straight from the caller (the shape OpenAI's input_file path validates)", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "test" });
    const bytes = new TextEncoder().encode(
      "# Q3 Marketing Strategy\n\nPositioning, GTM motion, channel mix...",
    );
    // The matcher synthesizes `<artifactId><ext>` when there is no persisted
    // upload filename — derive the extension from the SAME capability authority
    // the matcher uses, so this contract tracks the real code, not a literal.
    const ext = extensionForIngestibleMime("text/markdown");
    expect(ext).toBe(".md");
    const filename = `169334fc-artifact${ext}`;

    const ref = await adapter.uploadFile!({
      content: bytes,
      filename,
      mimeType: "text/markdown",
    });
    expect(ref).toEqual({ id: "file_abc", provider: "openai" });

    // The provider built exactly ONE File and handed it to files.create.
    expect(filesCreateMock).toHaveBeenCalledTimes(1);
    const arg = filesCreateMock.mock.calls[0][0] as {
      file: File;
      purpose: string;
    };

    // A REAL Web File (the object OpenAI's SDK serializes) — its NAME is what the
    // input_file / context-stuffing path derives the format from.
    expect(arg.file).toBeInstanceOf(File);
    expect(arg.file.name).toBe("169334fc-artifact.md");
    expect(arg.file.type).toBe("text/markdown");
    expect(arg.purpose).toBe("user_data");

    // The DEFECT-3 contract: the File the provider built carries an extension
    // that MATCHES its mime (an extensionless — or mismatched — name is the 400
    // / mis-parse the walk + codex r2 caught).
    expect(filenameExtensionMatchesMime(arg.file.name, "text/markdown")).toBe(true);

    // Bytes are preserved intact through the File construction.
    expect(new Uint8Array(await arg.file.arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
  });

  it("a persisted upload filename with a good extension flows through to the File verbatim", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "test" });
    await adapter.uploadFile!({
      content: new TextEncoder().encode("plan"),
      filename: "marketing-strategy.md",
      mimeType: "text/markdown",
    });
    const arg = filesCreateMock.mock.calls[0][0] as { file: File };
    expect(arg.file.name).toBe("marketing-strategy.md");
    expect(filenameExtensionMatchesMime(arg.file.name, "text/markdown")).toBe(true);
  });

  it("REGRESSION anchor: the pre-fix bare-artifactId filename fails the mime-match contract", () => {
    // Pre-DEFECT-3 the matcher sent no filename and the resolver fell back to the
    // bare artifact UUID — extensionless → OpenAI 400. This documents the exact
    // condition the fix removes (the fix guarantees the branches above instead).
    expect(
      filenameExtensionMatchesMime("169334fc-1111-4000-8000-000000000000", "text/markdown"),
    ).toBe(false);
  });
});
