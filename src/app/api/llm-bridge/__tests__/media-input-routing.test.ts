/**
 * /api/llm-bridge media-input branch routing.
 *
 * Covers 10 media-input routing scenarios:
 *
 *   1. YOUTUBE-PATH                  — host-detected (www.youtube.com).
 *   2. YOUTUBE-PATH-MUSIC-HOST       — host-detected (music.youtube.com).
 *   3. YOUTUBE-PATH-SHORT-DOMAIN     — host-detected (youtu.be).
 *   4. AUDIO-FILE-PATH               — fetch → uploadFile → generateFromMediaFile.
 *   5. VIDEO-FILE-PATH-ALLOWLISTED   — video/webm via Content-Type header.
 *   6. UNSUPPORTED-MIME-400          — application/pdf → MEDIA-MIME-UNSUPPORTED.
 *   7. OVERSIZED-VIA-STREAM          — no Content-Length, 11 MB streamed → MEDIA-SIZE-EXCEEDED.
 *   8. OVERSIZED-VIA-CONTENT-LENGTH  — fast-path Content-Length > 10 MB → 413.
 *   9. EMPTY-KIND-NORMALIZES         — kind:"" → undefined → file branch runs.
 *  10. CAPABILITY-MISMATCH-IGNORES-MEDIA — non-media_input capability silently
 *      drops body.media; text dispatch runs.
 *
 * Mock topology mirrors cinatra-llm-routing.test.ts:
 *   - vi.hoisted handles for every entry point the route imports.
 *   - vi.mock("@cinatra-ai/llm", ...) provides the 5 functions the
 *     route names, PLUS resolveProviderAdapter returning an adapter stub with
 *     uploadFile / generateFromMediaFile / deleteFile / generate spies.
 *   - vi.mock("@cinatra-ai/metric-usage-api", ...) provides the telemetry spy.
 *   - SKILL.md is NOT mocked at fs level; instead the test passes a real
 *     skill_source_path under process.cwd()/src/app/api/llm-bridge/__tests__/
 *     fixtures/media-skill.md, which contains the sentinel string
 *     `SPEAKER_LABEL_FIXTURE` that we assert flows into adapter.generate /
 *     adapter.generateFromMediaFile's `system` argument.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";

type LlmProviderId = "openai" | "anthropic" | "gemini";

// ---------------------------------------------------------------------------
// Hoisted mock handles (must be available before any vi.mock factory runs).
// ---------------------------------------------------------------------------

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapterMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  setRunContextMock,
  clearRunContextMock,
  emitUsageEventMock,
  consoleWarnSpy,
  adapterMock,
} = vi.hoisted(() => {
  const adapter = {
    provider: "gemini" as const,
    uploadFile: vi.fn(async (_input: unknown) => ({
      id: "files/abc123",
      provider: "gemini" as const,
    })),
    generateFromMediaFile: vi.fn(async (_input: unknown) => ({
      text: "transcript-from-file",
      status: "completed",
      incompleteReason: null,
      rawBody: "{}",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    })),
    deleteFile: vi.fn(async (_ref: unknown) => undefined),
    generate: vi.fn(async (_input: unknown) => ({
      text: "transcript-from-youtube",
      status: "completed",
      incompleteReason: null,
      rawBody: "{}",
      usage: {
        inputTokens: 80,
        outputTokens: 40,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    })),
  };
  return {
    runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async (_input: unknown) => ({
      text: "ok",
      artifacts: [],
    })),
    resolveProviderAdapterMock: vi.fn(async (provider: LlmProviderId) =>
      provider === "gemini" ? adapter : { provider },
    ),
    resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
      runtime: { provider: "openai" },
      agentId: "test",
      deterministic: false,
    })),
    getLlmMcpCredentialsMock: vi.fn((): { clientId: string; clientSecret: string } | null => null),
    setRunContextMock: vi.fn(),
    clearRunContextMock: vi.fn(),
    emitUsageEventMock: vi.fn(),
    consoleWarnSpy: vi.spyOn(console, "warn").mockImplementation(() => {}),
    adapterMock: adapter,
  };
});

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapter: resolveProviderAdapterMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  createLocalSkillShellTool: vi.fn(() => null),
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
    requestedProvider: string;
    reason: string;
    constructor(requestedProvider: string, reason: string) {
      super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
      this.requestedProvider = requestedProvider;
      this.reason = reason;
    }
  },
}));

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: emitUsageEventMock,
}));

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
}));

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z
          .enum(["media_input", "function_tools", "native_mcp"])
          .optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai", "anthropic", "gemini"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
      anthropic: [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "claude-3-7-sonnet-latest",
        "claude-3-5-haiku-latest",
      ],
      gemini: [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-1.5-pro",
      ],
    },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";

// SKILL.md fixture — absolute path under cwd; the route's path-traversal guard
// requires this exact shape (path.relative(cwd, resolvedPath) must not start
// with "..", must not be absolute) AND must end with the basename "SKILL.md".
const SKILL_FIXTURE_PATH = path.join(
  process.cwd(),
  "src",
  "app",
  "api",
  "llm-bridge",
  "__tests__",
  "fixtures",
  "SKILL.md",
);

function makeReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Build a Response whose body is a true ReadableStream emitting the given
 * chunk sizes (each chunk is a Uint8Array of that many bytes). Used to drive
 * `streamFetchWithSizeCap` chunk-by-chunk so we can assert the streaming
 * size-cap behavior.
 */
function streamingResponse(
  chunkSizes: number[],
  headers: Record<string, string>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunkSizes) {
        controller.enqueue(new Uint8Array(size));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

/**
 * Wait one microtask + setImmediate so the route's best-effort
 * `adapter.deleteFile(...).catch(...)` settles before the test asserts.
 */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  consoleWarnSpy.mockClear();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;

  // Re-bind adapter spy defaults after clearAllMocks resets implementations.
  adapterMock.uploadFile.mockResolvedValue({
    id: "files/abc123",
    provider: "gemini",
  });
  adapterMock.generateFromMediaFile.mockResolvedValue({
    text: "transcript-from-file",
    status: "completed",
    incompleteReason: null,
    rawBody: "{}",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  adapterMock.deleteFile.mockResolvedValue(undefined);
  adapterMock.generate.mockResolvedValue({
    text: "transcript-from-youtube",
    status: "completed",
    incompleteReason: null,
    rawBody: "{}",
    usage: {
      inputTokens: 80,
      outputTokens: 40,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  resolveProviderAdapterMock.mockImplementation(async (provider: LlmProviderId) =>
    provider === "gemini" ? adapterMock : { provider },
  );
  resolveConfiguredLlmRuntimeMock.mockResolvedValue({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "legacy-text-output",
    artifacts: [],
  });

  const mod = await import("../route");
  POST = mod.POST;
});

describe("/api/llm-bridge media-input branch", () => {
  // -------------------------------------------------------------------------
  // 1. YOUTUBE-PATH
  // -------------------------------------------------------------------------
  it("YOUTUBE-PATH: youtube.com URL routes to adapter.generate with SKILL+system; emits LlmUsageEvent", async () => {
    const res = await POST(
      makeReq({
        user: "transcribe",
        cinatra_llm: {
          preferredProvider: "gemini",
          capabilityRequired: "media_input",
        },
        media: { url: "https://www.youtube.com/watch?v=abc" },
        agent_id: "media-transcript-agent",
        skill_source_path: SKILL_FIXTURE_PATH,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBe("transcript-from-youtube");

    expect(adapterMock.generate).toHaveBeenCalledTimes(1);
    expect(adapterMock.uploadFile).not.toHaveBeenCalled();
    expect(adapterMock.generateFromMediaFile).not.toHaveBeenCalled();

    const generateArg = adapterMock.generate.mock.calls[0]?.[0] as {
      prompt: string;
      system: string;
    };
    expect(generateArg.prompt).toBe("https://www.youtube.com/watch?v=abc");
    // SKILL fixture content must flow into `system`.
    expect(generateArg.system).toContain("SPEAKER_LABEL_FIXTURE");

    // emitUsageEvent fires once with the verified shape.
    expect(emitUsageEventMock).toHaveBeenCalledTimes(1);
    const usagePayload = emitUsageEventMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(usagePayload).toMatchObject({
      source: "llm",
      provider: "gemini",
      operation: "generate",
      agentLabel: "media-transcript-agent",
      skillLabel: null,
      effectiveProvider: "gemini",
    });
    expect(usagePayload.requestedProvider).toBe("gemini");
    expect(typeof usagePayload.model).toBe("string");
    expect(typeof usagePayload.inputTokens).toBe("number");
    expect(typeof usagePayload.outputTokens).toBe("number");
    expect(typeof usagePayload.cachedInputTokens).toBe("number");
    expect(typeof usagePayload.reasoningOutputTokens).toBe("number");
    expect(typeof usagePayload.idempotencyKey).toBe("string");
    expect(typeof usagePayload.occurredAt).toBe("string");
    // Invented usage payload fields MUST NOT be present.
    expect(usagePayload).not.toHaveProperty("agentRunId");
    expect(usagePayload).not.toHaveProperty("agentId");
    expect(usagePayload).not.toHaveProperty("tokensIn");
    expect(usagePayload).not.toHaveProperty("tokensOut");
    expect(usagePayload).not.toHaveProperty("kind");
  });

  // -------------------------------------------------------------------------
  // 2. YOUTUBE-PATH-MUSIC-HOST
  // -------------------------------------------------------------------------
  it("YOUTUBE-PATH-MUSIC-HOST: music.youtube.com is detected", async () => {
    const res = await POST(
      makeReq({
        user: "transcribe",
        cinatra_llm: {
          preferredProvider: "gemini",
          capabilityRequired: "media_input",
        },
        media: { url: "https://music.youtube.com/watch?v=abc" },
      }),
    );

    expect(res.status).toBe(200);
    expect(adapterMock.generate).toHaveBeenCalledTimes(1);
    expect(adapterMock.uploadFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. YOUTUBE-PATH-SHORT-DOMAIN
  // -------------------------------------------------------------------------
  it("YOUTUBE-PATH-SHORT-DOMAIN: youtu.be is detected", async () => {
    const res = await POST(
      makeReq({
        user: "transcribe",
        cinatra_llm: {
          preferredProvider: "gemini",
          capabilityRequired: "media_input",
        },
        media: { url: "https://youtu.be/abc" },
      }),
    );

    expect(res.status).toBe(200);
    expect(adapterMock.generate).toHaveBeenCalledTimes(1);
    expect(adapterMock.uploadFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. AUDIO-FILE-PATH
  // -------------------------------------------------------------------------
  it("AUDIO-FILE-PATH: audio/mpeg fetches → uploads → generateFromMediaFile with SKILL+system; emits LlmUsageEvent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([512, 512], { "content-type": "audio/mpeg" }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/clip.mp3" },
          agent_id: "media-transcript-agent",
          skill_source_path: SKILL_FIXTURE_PATH,
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.text).toBe("transcript-from-file");

      expect(adapterMock.uploadFile).toHaveBeenCalledTimes(1);
      const uploadArg = adapterMock.uploadFile.mock.calls[0]?.[0] as {
        mimeType: string;
        filename: string;
        content: Uint8Array;
      };
      expect(uploadArg.mimeType).toBe("audio/mpeg");
      expect(uploadArg.filename).toBe("clip.mp3");

      expect(adapterMock.generateFromMediaFile).toHaveBeenCalledTimes(1);
      const genArg = adapterMock.generateFromMediaFile.mock.calls[0]?.[0] as {
        mediaFileUri: string;
        mimeType: string;
        system: string;
      };
      // uploadResult.id flows directly as mediaFileUri.
      expect(genArg.mediaFileUri).toBe("files/abc123");
      expect(genArg.mimeType).toBe("audio/mpeg");
      // SKILL content flows into `system`.
      expect(genArg.system).toContain("SPEAKER_LABEL_FIXTURE");

      // Best-effort deleteFile fires; wait for the next microtask.
      await flushPromises();
      expect(adapterMock.deleteFile).toHaveBeenCalledTimes(1);

      // emitUsageEvent has the verified shape.
      expect(emitUsageEventMock).toHaveBeenCalledTimes(1);
      const usagePayload = emitUsageEventMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(usagePayload).toMatchObject({
        source: "llm",
        provider: "gemini",
        operation: "generate",
        agentLabel: "media-transcript-agent",
        skillLabel: null,
        effectiveProvider: "gemini",
      });
      expect(usagePayload.requestedProvider).toBe("gemini");
      expect(typeof usagePayload.model).toBe("string");
      expect(typeof usagePayload.inputTokens).toBe("number");
      expect(typeof usagePayload.outputTokens).toBe("number");
      expect(typeof usagePayload.cachedInputTokens).toBe("number");
      expect(typeof usagePayload.reasoningOutputTokens).toBe("number");
      expect(typeof usagePayload.idempotencyKey).toBe("string");
      expect(typeof usagePayload.occurredAt).toBe("string");
      expect(usagePayload).not.toHaveProperty("agentRunId");
      expect(usagePayload).not.toHaveProperty("agentId");
      expect(usagePayload).not.toHaveProperty("tokensIn");
      expect(usagePayload).not.toHaveProperty("tokensOut");
      expect(usagePayload).not.toHaveProperty("kind");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 5. VIDEO-FILE-PATH-ALLOWLISTED
  // -------------------------------------------------------------------------
  it("VIDEO-FILE-PATH-ALLOWLISTED: video/webm is accepted via Content-Type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([512, 512], { "content-type": "video/webm" }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/clip.webm" },
        }),
      );

      expect(res.status).toBe(200);
      expect(adapterMock.uploadFile).toHaveBeenCalledTimes(1);
      const uploadArg = adapterMock.uploadFile.mock.calls[0]?.[0] as {
        mimeType: string;
      };
      expect(uploadArg.mimeType).toBe("video/webm");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 6. UNSUPPORTED-MIME-400
  // -------------------------------------------------------------------------
  it("UNSUPPORTED-MIME-400: application/pdf → MEDIA-MIME-UNSUPPORTED", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([512], { "content-type": "application/pdf" }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/doc.pdf" },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("MEDIA-MIME-UNSUPPORTED");
      expect(Array.isArray(body.allowlist)).toBe(true);
      expect((body.allowlist as string[]).length).toBe(16);

      expect(adapterMock.uploadFile).not.toHaveBeenCalled();
      expect(adapterMock.generateFromMediaFile).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 7. OVERSIZED-VIA-STREAM
  // -------------------------------------------------------------------------
  it("OVERSIZED-VIA-STREAM: 11 MB streamed (no Content-Length) → MEDIA-SIZE-EXCEEDED", async () => {
    // 11 chunks × 1 MB = 11 MB, no content-length header → fast path
    // skips, stream reader trips the size cap mid-flight.
    const oneMB = 1024 * 1024;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse(
        new Array(11).fill(oneMB),
        { "content-type": "audio/mpeg" },
      ),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/big.mp3" },
        }),
      );

      expect(res.status).toBe(413);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("MEDIA-SIZE-EXCEEDED");
      // streamFetchWithSizeCap returns bytesSeen — must be > MAX (10 MB)
      // when the cap fires; the cap fires the first time bytesSeen passes
      // 10 MB so the first overrun is 11 MB (the 11th chunk).
      expect(typeof body.bytesSeen).toBe("number");
      expect(body.bytesSeen).toBeGreaterThan(10 * 1024 * 1024);

      expect(adapterMock.uploadFile).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 8. OVERSIZED-VIA-CONTENT-LENGTH
  // -------------------------------------------------------------------------
  it("OVERSIZED-VIA-CONTENT-LENGTH: Content-Length 11 MB → MEDIA-SIZE-EXCEEDED fast path", async () => {
    // Fast path — Content-Length header reads as 11 MB, route short-circuits
    // before streaming. Body content doesn't matter (stream reader never runs).
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([1024], {
        "content-type": "audio/mpeg",
        "content-length": "11534336",
      }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/big.mp3" },
        }),
      );

      expect(res.status).toBe(413);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("MEDIA-SIZE-EXCEEDED");
      expect(body.contentLength).toBe(11534336);

      expect(adapterMock.uploadFile).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 9. EMPTY-KIND-NORMALIZES
  // -------------------------------------------------------------------------
  it("EMPTY-KIND-NORMALIZES: kind:\"\" normalized to undefined → file branch runs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([512], { "content-type": "audio/mpeg" }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "transcribe",
          cinatra_llm: {
            preferredProvider: "gemini",
            capabilityRequired: "media_input",
          },
          media: { url: "https://example.com/clip.mp3", kind: "" },
        }),
      );

      // If the empty kind blew up the Zod schema → 400; the test would fail
      // here. A successful 200 + uploadFile invocation proves preprocess
      // normalized "" → undefined and the file branch ran (kind !== 'youtube',
      // host is not YouTube, → file path).
      expect(res.status).toBe(200);
      expect(adapterMock.uploadFile).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 10. CAPABILITY-MISMATCH-IGNORES-MEDIA
  // -------------------------------------------------------------------------
  it("CAPABILITY-MISMATCH-IGNORES-MEDIA: function_tools capability silently drops body.media; text dispatch runs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamingResponse([512], { "content-type": "audio/mpeg" }),
    );

    try {
      const res = await POST(
        makeReq({
          user: "hello",
          cinatra_llm: {
            preferredProvider: "openai",
            capabilityRequired: "function_tools",
          },
          media: { url: "https://example.com/clip.mp3" },
        }),
      );

      expect(res.status).toBe(200);

      // Text dispatch path ran.
      expect(runResolvedSkillAwareDeterministicLlmTaskMock).toHaveBeenCalledTimes(1);

      // Media branch did NOT run — no fetch, no upload, no media-branch
      // telemetry. (The orchestration layer's own usage emit fires inside the
      // mocked runResolvedSkillAwareDeterministicLlmTask, but our
      // emitUsageEventMock spy is for the bridge's direct call from the
      // media branch — that call did not happen.)
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(adapterMock.uploadFile).not.toHaveBeenCalled();
      expect(adapterMock.generateFromMediaFile).not.toHaveBeenCalled();
      expect(adapterMock.generate).not.toHaveBeenCalled();
      expect(emitUsageEventMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
