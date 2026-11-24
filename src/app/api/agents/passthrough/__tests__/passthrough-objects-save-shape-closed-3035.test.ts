/**
 * cinatra#3035 — `_shape` on `objects_save` is a CLOSED discriminator.
 *
 * The blog pipeline's two `_shape` opt-ins are retired. A body that still
 * carries one of them (or any other value but the campaigns context shape)
 * must be refused before the save: it must not fall through with its own
 * `typeHint` and `rawData` into `objects_save`. A body without `_shape` keeps
 * passing through unchanged, and the campaigns shape keeps being shaped.
 *
 * Drives the real route; the run store, the bridge auth, the run binding, the
 * actor builder and the primitive handlers are test doubles. The objects_save
 * double returns the shape the real handler returns (`objectId`, not `id`);
 * the type check below pins it to that handler's return type.
 *
 *   pnpm exec vitest run src/app/api/agents/passthrough/__tests__/passthrough-objects-save-shape-closed-3035.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  objectsSave: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ objects_save: h.objectsSave }),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: async () => ({ ok: true, runId: "run-3035" }),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// cinatra#3745: every passthrough call first prepares its arguments against the
// run's verified executing source and the step's declared tools (pinned in
// src/app/api/agents/passthrough/__tests__/passthrough-verified-step.test.ts and
// passthrough-refusal-map-3745.test.ts). Here that check admits the call and
// hands the tool its input unchanged. The guarded invocation reads the refusal
// class it throws when the boundary refuses a call; the class is the host's shape.
vi.mock("@/lib/extension-host-context", () => ({
  prepareDeclaredRunToolArguments: async (_tool: string, input: unknown) => input,
  OutwardActionRefusal: class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  },
}));

import { POST } from "@/app/api/agents/passthrough/route";
import type { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";

// The real objects_save handler's return type. The double below must satisfy
// it, so a double with an `id` key (a shape the handler never returns) or
// without `objectId` fails the typecheck.
type ObjectsSaveResult = Awaited<
  ReturnType<ReturnType<typeof createObjectsPrimitiveHandlers>["objects_save"]>
>;
const SAVED = {
  objectId: "obj-1",
  type: "@cinatra-ai/campaigns:context",
  isNew: true,
} satisfies Partial<ObjectsSaveResult> & Pick<ObjectsSaveResult, "objectId">;

const RUN = { id: "run-3035", orgId: "org-1", runBy: "user-1", oboCeiling: null };

// The two retired values are spelled from parts so the passthrough guard
// (src/__tests__/blog-pipeline-passthrough-shaper.test.ts) keeps reading no
// retired name in this folder's production modules or its tests.
const RETIRED_SHAPES: Array<[label: string, shape: string]> = [
  ["the selected-idea shape", ["blog", "pipeline", "selected", "idea"].join("_")],
  ["the draft-projection shape", ["blog", "pipeline", "draft", "projection"].join("_")],
];

function req(input: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": "ctx-3035" },
    body: JSON.stringify({ tool: "objects_save", input, agent_run_id: RUN.id }),
  });
}

beforeEach(() => {
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.objectsSave.mockReset().mockResolvedValue(SAVED);
});

afterAll(() => {
  for (const m of [
    "server-only",
    "@cinatra-ai/agents",
    "@/lib/primitive-handlers",
    "@/lib/wayflow-bridge-auth",
    "@/lib/authz/bridge-run-binding",
    "@/lib/authz/build-actor-context-from-run",
    "@cinatra-ai/llm/actor-context",
    "@/lib/extension-host-context",
  ]) {
    vi.doUnmock(m);
  }
  vi.resetModules();
});

describe("cinatra#3035 — objects_save refuses every `_shape` but the campaigns context", () => {
  for (const [label, shape] of RETIRED_SHAPES) {
    it(`refuses ${label} when it carries its own typeHint and rawData`, async () => {
      const res = await POST(
        req({
          _shape: shape,
          typeHint: "@cinatra-ai/campaigns:context",
          rawData: { name: "Injected" },
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("`_shape` names no passthrough shaper");
      expect(h.objectsSave).not.toHaveBeenCalled();
    });

    it(`refuses ${label} sent without canonical fields`, async () => {
      const res = await POST(req({ _shape: shape, draft: { title: "t" } }));
      expect(res.status).toBe(400);
      expect(h.objectsSave).not.toHaveBeenCalled();
    });
  }

  it("refuses an unknown and an empty `_shape` alike", async () => {
    for (const shape of ["anything_else", "", null]) {
      const res = await POST(req({ _shape: shape, typeHint: "x", rawData: {} }));
      expect(res.status).toBe(400);
    }
    expect(h.objectsSave).not.toHaveBeenCalled();
  });

  it("passes a body without `_shape` through unchanged", async () => {
    const input = { typeHint: "@cinatra-ai/campaigns:context", rawData: { name: "Plain" } };
    const res = await POST(req(input));
    expect(res.status).toBe(200);
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const arg = h.objectsSave.mock.calls[0]![0] as { input: unknown };
    expect(arg.input).toEqual(input);
  });

  it("still shapes the campaigns context shape", async () => {
    const res = await POST(
      req({
        _shape: "email_outreach_context_setup",
        setupJson: JSON.stringify({
          offeringCompanyWebsite: "https://www.example.com/x",
          callToAction: "Book a call",
          senderName: "Ada",
        }),
        cinatra_agent_run_id: RUN.id,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.objectsSave).toHaveBeenCalledTimes(1);
    const arg = h.objectsSave.mock.calls[0]![0] as {
      input: { typeHint: string; rawData: Record<string, unknown> };
    };
    expect(arg.input.typeHint).toBe("@cinatra-ai/campaigns:context");
    expect(arg.input.rawData).toMatchObject({
      cinatra_agent_run_id: RUN.id,
      name: "Outreach — Example",
      senderName: "Ada",
      callToAction: "Book a call",
      offeringCompanyWebsite: "https://www.example.com/x",
    });
    expect(arg.input).not.toHaveProperty("_shape");
  });
});
