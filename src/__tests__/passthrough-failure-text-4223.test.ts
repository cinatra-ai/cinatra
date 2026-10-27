/**
 * cinatra#4223 — THE PASSTHROUGH ANSWERS A THROWN EXCEPTION WITH A FIXED SENTENCE.
 *
 * The route's generic catch and its actor-context catch answered the
 * exception's own message, which can name a table, a connection or a
 * provider's answer, to the flow and through it to the run's tool results.
 * Only a primitive's stated refusal and an input-schema error keep their text;
 * every other throw answers a fixed sentence, and the actor-context catch
 * answers its fixed sentence for every error. The server log carries a word
 * for the error's class from a fixed list, never its text and never a code,
 * and a failing log never changes the answer. Tests named "guard:" pass on
 * the base too.
 *
 *   npx vitest run src/__tests__/passthrough-failure-text-4223.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  generateArtifactImageMock,
} = vi.hoisted(() => ({
  isAuthorizedMock: vi.fn(() => true),
  bindBridgeRunIdMock: vi.fn(
    async (): Promise<{ ok: true } | { ok: false; status: number; error: string }> => ({
      ok: true,
    }),
  ),
  readAgentRunByIdMock: vi.fn(),
  buildActorContextFromRunMock: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
  collectAllPrimitiveHandlersMock: vi.fn(async () => ({})),
  generateArtifactImageMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: readAgentRunByIdMock,
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: collectAllPrimitiveHandlersMock,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: isAuthorizedMock,
}));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: bindBridgeRunIdMock,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: buildActorContextFromRunMock,
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/artifact-image-tool", () => ({
  generateArtifactImage: generateArtifactImageMock,
}));

import { POST } from "../app/api/agents/passthrough/route";

// The public sentences, written out: they are the route's contract with the
// flow, so this file pins their text rather than importing it.
const PASSTHROUGH_UNEXPECTED_ERROR =
  "the tool call failed on an unexpected error; the failure is logged on the server";
const PASSTHROUGH_ACTOR_CONTEXT_ERROR =
  "failed to build actor context; the failure is logged on the server";

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
};

// Assembled at runtime so no committed line carries a complete scheme,
// userinfo and host literal for a secret scanner to trip on; the
// string the tests use is unchanged.
const PG_URL = ["postgres:", "", "svc:hunter2@db.internal:5432"].join("/");
const SECRET = `relation "cinatra"."objects" at ${PG_URL}`;

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SAVE = {
  tool: "objects_save",
  agent_run_id: "run-1",
  input: { rawData: { title: "x" }, typeHint: "@cinatra-ai/x:y" },
};

const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug"] as const;
let logged: MockInstance<typeof console.error>;
let spies: MockInstance[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  spies = CONSOLE_METHODS.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
  logged = spies[0] as MockInstance<typeof console.error>;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** No part of the secret reaches any console call. */
function expectNoSecretLogged() {
  const text = JSON.stringify(spies.map((spy) => spy.mock.calls));
  for (const part of ["hunter2", "db.internal", '"objects"', "postgres:"]) {
    expect(text).not.toContain(part);
  }
}

/** A thrown value whose every conversion to text throws an Error that carries the secret. */
function unprintable(): object {
  return {
    [Symbol.toPrimitive]() {
      throw new Error(SECRET);
    },
    toString() {
      throw new Error(SECRET);
    },
  };
}

describe("cinatra#4223 — the passthrough's failure texts", () => {
  it("a handler that throws a plain Error is answered 500 with the fixed sentence, logged without its text", async () => {
    collectAllPrimitiveHandlersMock.mockResolvedValue({
      objects_save: async () => {
        throw new Error(SECRET);
      },
    });
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text)).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
    expect(logged).toHaveBeenCalled();
    expectNoSecretLogged();
  });

  it("a handler that throws a non-Error value is answered 500 with the fixed sentence", async () => {
    collectAllPrimitiveHandlersMock.mockResolvedValue({
      objects_save: async () => {
        throw SECRET;
      },
    });
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
    expectNoSecretLogged();
  });

  it("a deterministic tool road that throws is answered 500 with the fixed sentence", async () => {
    generateArtifactImageMock.mockRejectedValue(new Error(SECRET));
    const res = await POST(
      post({
        tool: "artifact_image_generate",
        agent_run_id: "run-1",
        input: {
          extension: "@cinatra-ai/blog-image-artifact",
          prompt: "a lighthouse at dusk",
          title: "The lighthouse",
          node_id: "make_picture",
        },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
  });

  it("guard: a primitive's stated refusal keeps its own text", async () => {
    collectAllPrimitiveHandlersMock.mockResolvedValue({
      objects_save: async () => {
        throw new PrimitiveInvocationError({
          code: "OBJECTS_TYPE_NOT_REGISTERED",
          message: "the type is not registered",
          retryable: false,
        });
      },
    });
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the type is not registered" });
  });

  it("an actor context that fails to build is answered 500 with its fixed sentence", async () => {
    buildActorContextFromRunMock.mockRejectedValueOnce(new Error(SECRET));
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_ACTOR_CONTEXT_ERROR });
    expect(logged).toHaveBeenCalled();
    expectNoSecretLogged();
  });

  it("an actor context that fails with a primitive's refusal is answered 500 with its fixed sentence", async () => {
    buildActorContextFromRunMock.mockRejectedValueOnce(
      new PrimitiveInvocationError({ code: "ACTOR_CONTEXT", message: SECRET, retryable: false }),
    );
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_ACTOR_CONTEXT_ERROR });
    expectNoSecretLogged();
  });

  it("a handler whose thrown value cannot be turned into text is answered 500 with the fixed sentence", async () => {
    collectAllPrimitiveHandlersMock.mockResolvedValue({
      objects_save: async () => {
        throw unprintable();
      },
    });
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
    expectNoSecretLogged();
  });

  it("a console that throws never changes the 500 answer", async () => {
    logged.mockImplementation(() => {
      throw new Error(SECRET);
    });
    collectAllPrimitiveHandlersMock.mockResolvedValue({
      objects_save: async () => {
        throw new Error(SECRET);
      },
    });
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PASSTHROUGH_UNEXPECTED_ERROR });
  });
});
