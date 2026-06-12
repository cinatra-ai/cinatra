import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Gemini's Files API returns BOTH a resource `name` (`files/<id>`) and a
// request `uri` (`https://…/v1beta/files/<id>`). A `fileData.fileUri` part
// REQUIRES the `uri`; emitting the resource `name` makes Gemini silently
// ignore the attachment. uploadFile() must return the URI (consumed verbatim
// by geminiUserParts) and deleteFile() must normalize a URI back to the
// resource name for the delete round-trip.
//
// Gemini's Files API accepts the upload before the file is usable; uploadFile()
// must poll until the resource transitions to ACTIVE (fail-closed on FAILED /
// timeout).

vi.mock("server-only", () => ({}));

const filesUploadMock = vi.fn();
const filesDeleteMock = vi.fn();
const filesGetMock = vi.fn();

vi.mock("@google/genai", async () => {
  // Real `FileState` enum is fine to import — it's a string enum, no
  // runtime side effects. Only the client class needs mocking.
  const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
  class MockGoogleGenAI {
    files = {
      upload: filesUploadMock,
      delete: filesDeleteMock,
      get: filesGetMock,
    };
    constructor(_config: unknown) {}
  }
  return { ...actual, GoogleGenAI: MockGoogleGenAI };
});

// The gemini `llm-provider-surface` (cinatra#151 Stage 2): the provider
// adapter resolves key/headers/log-writer through the capability resolver.
// (vi.hoisted: the mock factories below are hoisted above plain consts.)
const { geminiSurface } = vi.hoisted(() => ({
  geminiSurface: {
    providerId: "gemini",
    getConfiguredAPIKey: async () => "test-key",
    buildRequestHeaders: () => ({}),
    writeLogFile: async () => {},
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "gemini" ? geminiSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "gemini") return geminiSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [geminiSurface]),
}));

import { createGeminiProviderAdapter } from "../providers/gemini";
import { geminiUserParts } from "../attachments/provider-parts";

const NAME = "files/abc123";
const URI = "https://generativelanguage.googleapis.com/v1beta/files/abc123";

describe("Gemini attachment file URI handling", () => {
  beforeEach(() => {
    filesUploadMock.mockReset();
    filesDeleteMock.mockReset();
    filesGetMock.mockReset();
  });

  it("uploadFile returns the request URI, NOT the resource name", async () => {
    filesUploadMock.mockResolvedValue({ name: NAME, uri: URI, state: "ACTIVE" });
    const adapter = createGeminiProviderAdapter("k");
    const ref = await adapter.uploadFile!({
      content: new Uint8Array([1, 2, 3]),
      filename: "x.png",
      mimeType: "image/png",
    });
    expect(ref).toEqual({ id: URI, provider: "gemini" });
    expect(ref.id).not.toBe(NAME);
    // Round-trip: the value uploadFile returns is emitted VERBATIM as
    // fileData.fileUri — so it must already be a URI.
    const parts = geminiUserParts("look", [
      { nativeKind: "gemini_file_data", providerFileId: ref.id, mime: "image/png" },
    ]);
    expect(parts).toContainEqual({
      fileData: { mimeType: "image/png", fileUri: URI },
    });
    // ACTIVE on first response → no poll round-trip.
    expect(filesGetMock).not.toHaveBeenCalled();
  });

  it("uploadFile FAILS CLOSED when the SDK returns no uri (no name fallback)", async () => {
    // Emitting the bare resource name as fileData.fileUri silently fails. Throw
    // so the resolver degrades the attachment to the not-readable manifest
    // instead.
    filesUploadMock.mockResolvedValue({ name: NAME, state: "ACTIVE" });
    const adapter = createGeminiProviderAdapter("k");
    await expect(
      adapter.uploadFile!({
        content: new Uint8Array([1]),
        filename: "y.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow(/did not return a uri/);
  });

  it("deleteFile normalizes a URI back to the resource name", async () => {
    filesDeleteMock.mockResolvedValue(undefined);
    const adapter = createGeminiProviderAdapter("k");
    await adapter.deleteFile!({ id: URI, provider: "gemini" });
    expect(filesDeleteMock).toHaveBeenCalledWith({ name: NAME });
  });

  it("deleteFile still accepts a legacy resource-name id", async () => {
    filesDeleteMock.mockResolvedValue(undefined);
    const adapter = createGeminiProviderAdapter("k");
    await adapter.deleteFile!({ id: "files/legacy-9", provider: "gemini" });
    expect(filesDeleteMock).toHaveBeenCalledWith({ name: "files/legacy-9" });
  });
});

describe("Gemini PROCESSING→ACTIVE poll", () => {
  beforeEach(() => {
    filesUploadMock.mockReset();
    filesDeleteMock.mockReset();
    filesGetMock.mockReset();
    vi.useFakeTimers();
  });

  // Restore real timers via afterEach so a mid-test assertion failure cannot
  // leak fake timers to the next test. A manual end-of-test teardown is skipped
  // when an earlier expect throws.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("PROCESSING → ACTIVE: polls files.get until state flips, then returns URI", async () => {
    filesUploadMock.mockResolvedValue({ name: NAME, uri: URI, state: "PROCESSING" });
    // Two PROCESSING reads, then ACTIVE.
    filesGetMock
      .mockResolvedValueOnce({ name: NAME, uri: URI, state: "PROCESSING" })
      .mockResolvedValueOnce({ name: NAME, uri: URI, state: "PROCESSING" })
      .mockResolvedValueOnce({ name: NAME, uri: URI, state: "ACTIVE" });

    const adapter = createGeminiProviderAdapter("k");
    const promise = adapter.uploadFile!({
      content: new Uint8Array([1, 2, 3]),
      filename: "x.pdf",
      mimeType: "application/pdf",
    });
    // Advance through 3 poll iterations (500ms, 1000ms, 2000ms). The
    // total wallclock is <4s — well under the 60s deadline.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const ref = await promise;
    expect(ref).toEqual({ id: URI, provider: "gemini" });
    expect(filesGetMock).toHaveBeenCalledTimes(3);
    expect(filesGetMock).toHaveBeenLastCalledWith({ name: NAME });

  });

  it("FAILED state: throws with the error message (no retries past the FAILED read)", async () => {
    filesUploadMock.mockResolvedValue({ name: NAME, uri: URI, state: "PROCESSING" });
    filesGetMock.mockResolvedValueOnce({
      name: NAME,
      uri: URI,
      state: "FAILED",
      error: { message: "size limit exceeded", code: 9 },
    });

    const adapter = createGeminiProviderAdapter("k");
    const promise = adapter.uploadFile!({
      content: new Uint8Array([1]),
      filename: "x.mp4",
      mimeType: "video/mp4",
    });
    // Attach the rejection assertion before advancing timers so the
    // unhandled-rejection guard doesn't fire while the poll loop is
    // still mid-resolve.
    const expectation = expect(promise).rejects.toThrow(/FAILED.*size limit exceeded/);
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    expect(filesGetMock).toHaveBeenCalledTimes(1);

  });

  it("PROCESSING-only-forever: throws after 60s deadline (last state PROCESSING)", async () => {
    filesUploadMock.mockResolvedValue({ name: NAME, uri: URI, state: "PROCESSING" });
    filesGetMock.mockResolvedValue({ name: NAME, uri: URI, state: "PROCESSING" });

    const adapter = createGeminiProviderAdapter("k");
    const promise = adapter.uploadFile!({
      content: new Uint8Array([1]),
      filename: "x.mp4",
      mimeType: "video/mp4",
    });
    const expectation = expect(promise).rejects.toThrow(/did not reach ACTIVE within 60s/);
    // Crank past 60s in chunks (the loop backs off to 5s cap; advancing
    // a single big chunk here is fine because the polls return
    // PROCESSING regardless).
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await expectation;

  });

  it("PROCESSING with no resource name: throws fast (cannot poll)", async () => {
    filesUploadMock.mockResolvedValue({ uri: URI, state: "PROCESSING" });

    const adapter = createGeminiProviderAdapter("k");
    await expect(
      adapter.uploadFile!({
        content: new Uint8Array([1]),
        filename: "x.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow(/no resource name/);
    expect(filesGetMock).not.toHaveBeenCalled();

  });
});
