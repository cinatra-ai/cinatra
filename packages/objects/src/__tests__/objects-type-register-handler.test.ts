// Handler-level contract tests for objects_type_register.
// Mirrors the vi.mock + lazy-import pattern from mcp-primitives.test.ts so the
// real auto-registrar / dual-write modules never load in node test context.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Typed loosely as `(input: any) => Promise<void>` so `mock.calls[0][0]`
// doesn't infer to a zero-length tuple — vitest narrows from the no-arg
// implementation otherwise.
const ensureSpy = vi.fn<(input: unknown) => Promise<void>>(async () => undefined);
const readAllSpy = vi.fn(async () => [] as Array<{ type: string; status: string }>);

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: ensureSpy,
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: readAllSpy,
}));

// Mock unrelated dependencies that handlers.ts pulls in transitively so the
// node test runner can load the module without touching the real DB / dual-
// write / classifier modules.
vi.mock("@/lib/objects-dual-write", () => ({ shadowUpsertObject: vi.fn() }));
vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));
// The classifier module transitively pulls in @cinatra-ai/llm,
// which imports app-internal aliases (@/lib/mcp-self-client) that the node
// test runner cannot resolve. Stub the classifier surface — this handler
// (objects_type_register) never calls classifyObject.
vi.mock("../classifier", () => ({
  classifyObject: vi.fn(),
}));

// Standardize the actor + request shape used across tests. We cast to the
// handler's expected request type via a Parameters lookup so we don't need to
// re-import the full PrimitiveInvocationRequest type.
function makeRequest(input: unknown) {
  return {
    primitiveName: "objects_type_register",
    input,
    actor: {
      actorType: "model",
      source: "agent",
      userId: "user-1",
    },
    mode: "agentic",
  } as unknown as Parameters<
    Awaited<ReturnType<typeof getHandlers>>["objects_type_register"]
  >[0];
}

async function getHandlers() {
  const mod = await import("../mcp/handlers");
  return mod.createObjectsPrimitiveHandlers();
}

describe("objects_type_register handler", () => {
  beforeEach(() => {
    ensureSpy.mockClear();
    readAllSpy.mockClear();
  });

  it("inserts a row with status=active and source=mcp", async () => {
    readAllSpy.mockResolvedValueOnce([
      { type: "@cinatra-ai/dynamic:test-type", status: "active" } as never,
    ]);
    const handlers = await getHandlers();

    const result = await handlers.objects_type_register(
      makeRequest({
        typeId: "@cinatra-ai/dynamic:test-type",
        displayName: "Test Type",
        category: "report",
      }),
    );

    expect(result).toMatchObject({
      type: "@cinatra-ai/dynamic:test-type",
      status: "active",
    });
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    const args = ensureSpy.mock.calls[0][0];
    expect(args).toMatchObject({
      type: "@cinatra-ai/dynamic:test-type",
      inferredName: "Test Type",
      inferredCategory: "report",
      source: "mcp",
      status: "active",
    });
  });

  it("is idempotent on repeat with the same typeId", async () => {
    readAllSpy.mockResolvedValue([
      { type: "@cinatra-ai/dynamic:repeat-type", status: "active" } as never,
    ]);
    const handlers = await getHandlers();

    const a = await handlers.objects_type_register(
      makeRequest({
        typeId: "@cinatra-ai/dynamic:repeat-type",
        displayName: "Repeat",
        category: "report",
      }),
    );
    const b = await handlers.objects_type_register(
      makeRequest({
        typeId: "@cinatra-ai/dynamic:repeat-type",
        displayName: "Repeat",
        category: "report",
      }),
    );

    expect(a).toEqual(b);
    // Idempotency happens at the DB layer (onConflictDoNothing). The handler
    // calls ensureDynamicObjectType on every invocation; the second insert is
    // a no-op write at the DB.
    expect(ensureSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid namespace at Zod parse (no DB write)", async () => {
    const handlers = await getHandlers();

    await expect(
      handlers.objects_type_register(
        makeRequest({
          typeId: "not-a-valid-namespace",
          displayName: "x",
          category: "report",
        }),
      ),
    ).rejects.toThrow();
    // Pitfall §10 — namespace check belongs in Zod, not the handler body. If
    // the handler ever inserts before parse, this assertion fails.
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});
