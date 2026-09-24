/**
 * cinatra#3564 — the objects_update seam of the deterministic passthrough.
 *
 * The two blog publish packs write the published address back onto the post's
 * artifact through one ApiNode, `write_address`, which POSTs to
 * `{{CINATRA_BASE_URL}}/api/agents/passthrough` with this body (read verbatim at
 * both pack heads; the WordPress twin names `postArtifactId` in place of
 * `linkedinArtifactId`):
 *
 *   { "tool": "objects_update",
 *     "input": {
 *       "objectId": "{{ linkedinArtifactId }}",
 *       "data": "{# pyagentspec-input-hint: {{ addressPatch }} #}{{ addressPatch | tojson }}"
 *     },
 *     "agent_run_id": "{{ cinatra_run_id }}" }
 *
 * The runtime renders every leaf of an ApiNode's data as a string. The Jinja
 * comment carrying the input hint renders to nothing, and `tojson` writes the
 * patch as JSON text: keys sorted, `", "` and `": "` separators, and each of the
 * characters ampersand, less-than, greater-than and apostrophe written as a
 * six-character escape (backslash, u, then 0026, 003c, 003e or 0027). So every
 * fixture string below is the text that leaf renders to: the three-key patch in
 * sorted key order with those separators (the LinkedIn address carries an
 * ampersand, written in the fixture exactly as the leaf renders it), or `{}`
 * when nothing was published.
 *
 * The objects_update handler here is a spy that validates its input with the
 * REAL `objectsUpdateSchema`, so a `data` the route hands on as a string fails
 * exactly as the real handler's parse fails.
 *
 *   npx vitest run src/__tests__/passthrough-objects-update-json-text.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { objectsUpdateSchema } from "../../packages/objects/src/mcp/schemas";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  objectsUpdateHandlerMock,
  parsedInputs,
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
  objectsUpdateHandlerMock: vi.fn(),
  parsedInputs: [] as Array<Record<string, unknown>>,
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

import { POST } from "../app/api/agents/passthrough/route";

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
};

/** What the LinkedIn leaf renders: sorted keys, tojson separators, `&` as the escape \u0026. */
const LINKEDIN_RENDERED_DATA =
  '{"linkedinPublishedExternalId": "urn:li:share:7300000000000000001", ' +
  '"linkedinPublishedRevisionId": "rev-li-3", ' +
  '"linkedinPublishedUrl": "https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/?utm_source=share\\u0026utm_medium=member"}';
const LINKEDIN_PATCH = {
  linkedinPublishedExternalId: "urn:li:share:7300000000000000001",
  linkedinPublishedRevisionId: "rev-li-3",
  linkedinPublishedUrl:
    "https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/?utm_source=share&utm_medium=member",
};

/** What the WordPress leaf renders: sorted keys, tojson separators. */
const WORDPRESS_RENDERED_DATA =
  '{"wordpressPublishedExternalId": "4711", ' +
  '"wordpressPublishedRevisionId": "rev-wp-2", ' +
  '"wordpressPublishedUrl": "https://blog.example.com/2026/09/the-lighthouse/"}';
const WORDPRESS_PATCH = {
  wordpressPublishedExternalId: "4711",
  wordpressPublishedRevisionId: "rev-wp-2",
  wordpressPublishedUrl: "https://blog.example.com/2026/09/the-lighthouse/",
};

/** The leaf's own text, unrendered. */
const UNRENDERED_LEAF = "{# pyagentspec-input-hint: {{ addressPatch }} #}{{ addressPatch | tojson }}";

const named = (kind: string) =>
  `objects_update input.data must be a plain JSON object (got ${kind})`;

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function updateBody(input: Record<string, unknown>): Record<string, unknown> {
  return { tool: "objects_update", input, agent_run_id: "run-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  parsedInputs.length = 0;
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  objectsUpdateHandlerMock.mockImplementation(async (request: { input: unknown }) => {
    const parsed = objectsUpdateSchema.parse(request.input) as Record<string, unknown>;
    parsedInputs.push(parsed);
    return { ok: true, changeSetId: "cs-1" };
  });
  collectAllPrimitiveHandlersMock.mockResolvedValue({ objects_update: objectsUpdateHandlerMock });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@/lib/primitive-handlers");
  vi.doUnmock("@/lib/wayflow-bridge-auth");
  vi.doUnmock("@/lib/authz/bridge-run-binding");
  vi.doUnmock("@/lib/authz/build-actor-context-from-run");
  vi.doUnmock("@cinatra-ai/llm/actor-context");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("R1 — the packs' exact leaf, rendered", () => {
  it.each([
    ["LinkedIn", "art-li-1", LINKEDIN_RENDERED_DATA, LINKEDIN_PATCH],
    ["WordPress", "art-wp-1", WORDPRESS_RENDERED_DATA, WORDPRESS_PATCH],
  ])(
    "the %s patch as JSON text reaches the handler as its record",
    async (_pack, objectId, rendered, patch) => {
      const res = await POST(post(updateBody({ objectId, data: rendered })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, changeSetId: "cs-1" });
      expect(objectsUpdateHandlerMock).toHaveBeenCalledTimes(1);
      expect(parsedInputs).toHaveLength(1);
      expect(parsedInputs[0].objectId).toBe(objectId);
      expect(parsedInputs[0].data).toEqual(patch);
    },
  );
});

describe("R2 — the declined road", () => {
  it('"{}" reaches the handler as an empty record, which merges nothing', async () => {
    const res = await POST(post(updateBody({ objectId: "art-li-1", data: "{}" })));
    expect(res.status).toBe(200);
    expect(objectsUpdateHandlerMock).toHaveBeenCalledTimes(1);
    expect(parsedInputs[0].data).toEqual({});
  });
});

describe("R3 — the named refusal of a non-object string", () => {
  it.each([
    ["not json", "unparseable JSON text"],
    [UNRENDERED_LEAF, "unparseable JSON text"],
    ["[1,2]", "array"],
    ['"text"', "string"],
    ["42", "number"],
    ["true", "boolean"],
    ["null", "null"],
  ])("data %j answers 400 naming %s and never reaches the handler", async (data, kind) => {
    const res = await POST(post(updateBody({ objectId: "art-li-1", data })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: named(kind) });
    expect(objectsUpdateHandlerMock).not.toHaveBeenCalled();
  });
});

describe("R4 — a present non-object value that is not text", () => {
  it.each([
    [[], "array"],
    [null, "null"],
    [7, "number"],
  ])("data %j answers 400 naming %s and never reaches the handler", async (data, kind) => {
    const res = await POST(post(updateBody({ objectId: "art-li-1", data })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: named(kind) });
    expect(objectsUpdateHandlerMock).not.toHaveBeenCalled();
  });
});

describe("R5 — the named error itself", () => {
  it("shapeObjectsUpdateInput throws ObjectsUpdateDataNotAnObjectError for a non-object", async () => {
    const seamPath = "../app/api/agents/passthrough/objects-update-seam";
    const seam = (await import(/* @vite-ignore */ seamPath)) as {
      ObjectsUpdateDataNotAnObjectError: new (...args: never[]) => Error;
      shapeObjectsUpdateInput: (raw: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(typeof seam.ObjectsUpdateDataNotAnObjectError).toBe("function");
    expect(typeof seam.shapeObjectsUpdateInput).toBe("function");
    let thrown: unknown;
    try {
      seam.shapeObjectsUpdateInput({ objectId: "o1", data: "[1]" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(seam.ObjectsUpdateDataNotAnObjectError);
    expect((thrown as Error).name).toBe("ObjectsUpdateDataNotAnObjectError");
    expect((thrown as Error).message).toBe(named("array"));
  });
});

describe("G0 — what the seam must not change", () => {
  it("a native plain-object data reaches the handler as that same object", async () => {
    const data = { linkedinPublishedUrl: "https://example.com/a?b=1&c=2" };
    const res = await POST(post(updateBody({ objectId: "art-li-1", data })));
    expect(res.status).toBe(200);
    expect(parsedInputs[0].data).toEqual(data);
  });

  it("a call with no data (objectId and projectId only) reaches the handler with no data key", async () => {
    const res = await POST(post(updateBody({ objectId: "art-li-1", projectId: "proj-1" })));
    expect(res.status).toBe(200);
    expect(parsedInputs[0].objectId).toBe("art-li-1");
    expect(parsedInputs[0].projectId).toBe("proj-1");
    expect("data" in parsedInputs[0]).toBe(false);
  });

  it("a call with no objectId keeps the handler's own schema refusal", async () => {
    const input = { data: { linkedinPublishedUrl: "https://example.com/p" } };
    const expected = objectsUpdateSchema.safeParse(input);
    expect(expected.success).toBe(false);
    const res = await POST(post(updateBody(input)));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expected.error?.message });
    expect(parsedInputs).toHaveLength(0);
  });
});
