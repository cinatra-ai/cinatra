// cinatra#1381 — the `memory_promote_request` MCP tool, and the scope it runs
// under.
//
// Two things matter here beyond "the tool calls the service":
//   1. the tool and the server action carry BYTE-IDENTICAL gates because they
//      are the same service call — proven by asserting the exact argument
//      object both build;
//   2. the tool inherits the shared A2A-precedence scope resolver, which is
//      FAIL-CLOSED (no org = throw) and never mixes an A2A identity with the
//      transport's organization. The lane brief calls out dev-bypass
//      relaxations specifically, so the structural pin at the bottom asserts
//      that NO module on this flow reads a bypass env var at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  requestMemoryPromotion: vi.fn(),
}));

vi.mock("@/lib/mcp-tool-scope", () => ({ resolveScope: mocks.resolveScope }));
// The SERVICE is mocked; its PAYLOAD SCHEMA is the real one, because that
// schema is the thing both request surfaces now share (review finding 9).
vi.mock("../memory-promotion-request", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    memoryPromotionRequestPayloadSchema: actual.memoryPromotionRequestPayloadSchema,
    requestMemoryPromotion: mocks.requestMemoryPromotion,
  };
});

import { registerMemoryPromotionPrimitives } from "../mcp";

type Handler = (input: unknown) => Promise<{ structuredContent: Record<string, unknown> }>;

function registered(): { name: string; meta: Record<string, unknown>; handler: Handler } {
  const tools: Array<{ name: string; meta: Record<string, unknown>; handler: Handler }> = [];
  registerMemoryPromotionPrimitives({
    registerTool: (name: string, meta: Record<string, unknown>, handler: Handler) =>
      tools.push({ name, meta, handler }),
  } as never);
  expect(tools).toHaveLength(1);
  return tools[0];
}

const actor = { principalId: "u-member" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveScope.mockReturnValue({ orgId: "org-1", userId: "u-member", actor });
  mocks.requestMemoryPromotion.mockResolvedValue({
    ok: true,
    request: {
      id: "req-1",
      objectId: "mem-1",
      objectTitle: "Deployment runbook",
      status: "pending",
      fromVisibility: "private",
      toVisibility: "organization",
      rowVersion: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      requestedBy: "u-member",
      decisionNote: null,
      toOwnerId: "org-1",
    },
  });
});

describe("registration", () => {
  it("registers EXACTLY ONE tool, and it is the request half", () => {
    const tool = registered();
    expect(tool.name).toBe("memory_promote_request");
    // No decide primitive rides this module: approve/reject are the shared
    // `approvals_*` tools' job.
    expect(tool.name).not.toMatch(/decide|approve|reject/);
  });

  it("its description states the three moves and the indistinguishable not_found", () => {
    const description = String(registered().meta.description);
    expect(description).toContain("user/private");
    expect(description).toContain("team/team");
    expect(description).toContain("does NOT widen the row");
    expect(description).toContain("indistinguishable");
  });
});

describe("the handler", () => {
  it("delegates to the shared service with the AUTHENTICATED principal, not the input", async () => {
    const { handler } = registered();
    const res = await handler({ memoryId: "mem-1", toVisibility: "organization" });
    expect(mocks.requestMemoryPromotion).toHaveBeenCalledWith({
      orgId: "org-1",
      memoryId: "mem-1",
      requestedBy: "u-member",
      toVisibility: "organization",
      actor,
    });
    expect(res.structuredContent).toMatchObject({ ok: true });
  });

  it("forwards a team target", async () => {
    const { handler } = registered();
    await handler({ memoryId: "mem-1", toVisibility: "team", targetTeamId: "team-9" });
    expect(mocks.requestMemoryPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ toVisibility: "team", targetTeamId: "team-9" }),
    );
  });

  it("refuses a caller with no attributable USER principal", async () => {
    mocks.resolveScope.mockReturnValue({ orgId: "org-1", userId: null, actor });
    const { handler } = registered();
    const res = await handler({ memoryId: "mem-1", toVisibility: "organization" });
    expect(res.structuredContent).toMatchObject({ ok: false, code: "not_authorized" });
    expect(mocks.requestMemoryPromotion).not.toHaveBeenCalled();
  });

  // cinatra#1381 review, finding 10. The tool used to `parse` and let the schema
  // error ESCAPE, while its server-action twin `safeParse`d and answered
  // `invalid_state`, against a module header that promises refusals are VALUES
  // and that this tool never throws. It now answers the way its twin does.
  it.each([
    ["a visibility outside the matrix", { memoryId: "mem-1", toVisibility: "public" }],
    ["a narrowing visibility", { memoryId: "mem-1", toVisibility: "private" }],
    ["an empty memoryId", { memoryId: "", toVisibility: "organization" }],
    ["a blank memoryId", { memoryId: "   ", toVisibility: "organization" }],
    ["a blank targetTeamId", { memoryId: "mem-1", toVisibility: "team", targetTeamId: "  " }],
    ["a missing payload", undefined],
    ["a payload that is not an object", "mem-1"],
  ])("refuses %s as a VALUE: invalid_state, never a throw", async (_label, payload) => {
    const { handler } = registered();
    const res = await handler(payload);
    expect(res.structuredContent).toEqual({
      ok: false,
      code: "invalid_state",
      message: "Invalid promotion request payload.",
    });
    expect(mocks.requestMemoryPromotion).not.toHaveBeenCalled();
  });

  // cinatra#1381 review, finding 9. `.min(1)` accepted "   " and a 1 MiB string
  // on both surfaces, and the 1 MiB value was echoed back inside the
  // `not_found` message.
  it("refuses an identifier past the byte cap on either field", async () => {
    const { handler } = registered();
    const huge = "m".repeat(1024 * 1024);
    expect((await handler({ memoryId: huge, toVisibility: "organization" })).structuredContent).toMatchObject({
      ok: false,
      code: "invalid_state",
    });
    expect(
      (await handler({ memoryId: "mem-1", toVisibility: "team", targetTeamId: huge })).structuredContent,
    ).toMatchObject({ ok: false, code: "invalid_state" });
    expect(mocks.requestMemoryPromotion).not.toHaveBeenCalled();
  });

  it("TRIMS the identifiers it accepts, so a padded id is one lookup key", async () => {
    const { handler } = registered();
    await handler({ memoryId: "  mem-1  ", toVisibility: "team", targetTeamId: " team-9 " });
    expect(mocks.requestMemoryPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "mem-1", targetTeamId: "team-9" }),
    );
  });

  it("returns business refusals as VALUES so an agent can branch on `code`", async () => {
    mocks.requestMemoryPromotion.mockResolvedValue({ ok: false, code: "conflict", message: "already pending" });
    const { handler } = registered();
    const res = await handler({ memoryId: "mem-1", toVisibility: "organization" });
    expect(res.structuredContent).toEqual({ ok: false, code: "conflict", message: "already pending" });
  });

  it("serializes PUBLIC request fields only — never the whole store row", async () => {
    const { handler } = registered();
    const res = await handler({ memoryId: "mem-1", toVisibility: "organization" });
    const request = (res.structuredContent as { request: Record<string, unknown> }).request;
    expect(Object.keys(request).sort()).toEqual([
      "createdAt",
      "fromVisibility",
      "id",
      "objectId",
      "rowVersion",
      "status",
      "title",
      "toVisibility",
    ]);
  });
});

describe("the scope resolver this tool inherits", () => {
  it("is the SHARED one — the artifact primitives resolve through the same module", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const artifactMcp = readFileSync(join(here, "..", "..", "artifacts", "mcp.ts"), "utf8");
    const memoryMcp = readFileSync(join(here, "..", "mcp.ts"), "utf8");
    for (const source of [artifactMcp, memoryMcp]) {
      expect(source).toContain('from "@/lib/mcp-tool-scope"');
      // Neither file may hold a second copy of the precedence rule.
      expect(source).not.toContain("function resolveScope(");
    }
  });

  // cinatra#1381 review, finding 9. Two hand-kept twins is how one surface ends
  // up accepting what the other refuses; the schema now has ONE definition and
  // both surfaces import it.
  it("BOTH request surfaces validate against the SAME schema object", async () => {
    const service = await import("../memory-promotion-request");
    const { meta } = registered();
    expect(meta.inputSchema).toBe(service.memoryPromotionRequestPayloadSchema);

    const here = dirname(fileURLToPath(import.meta.url));
    const action = readFileSync(
      join(here, "..", "..", "..", "app", "memory", "promotion-actions.ts"),
      "utf8",
    );
    expect(action).toContain("memoryPromotionRequestPayloadSchema");
    // No second literal schema anywhere on either surface.
    expect(action).not.toMatch(/z\.object\(/);
    expect(
      readFileSync(join(here, "..", "mcp.ts"), "utf8"),
    ).not.toMatch(/z\.object\(/);
  });

  it("NO module on this flow reads a dev-bypass env var", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..", "..");
    const files = [
      join(root, "memory", "mcp.ts"),
      join(root, "memory", "memory-promotion-request.ts"),
      join(root, "mcp-tool-scope.ts"),
      join(root, "objects", "memory-row-promotion.ts"),
      join(root, "objects", "memory-promotion-request-store.ts"),
      join(root, "objects", "memory-promotion-request-schema.ts"),
      join(root, "approvals", "sources", "memory-promotion.ts"),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/A2A_DEV_BYPASS|DEV_BYPASS|SKIP_AUTH|isLocalhostRequest|NODE_ENV\s*!==\s*"production"/);
      // Nor any env read at all — there is no flag that relaxes this flow.
      expect(source, file).not.toMatch(/process\.env/);
    }
  });
});
