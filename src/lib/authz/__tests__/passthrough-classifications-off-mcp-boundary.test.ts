/**
 * cinatra#4895: passthrough rows are classified in their own map, and the MCP
 * boundary never reads it. A name only the passthrough route admits gets no
 * host classification at the MCP boundary, so a pack's MCP tool of that name
 * keeps the boundary's own treatment.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../audit";
import * as augmentModule from "../inventory-augment";
import { lookupPrimitiveClassification } from "../inventory-augment";
import { enforceMcpBoundary } from "../mcp-boundary";

const PASSTHROUGH_ONLY = "run_folder_write";

describe("passthrough classifications stay off the MCP boundary", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  });
  afterEach(() => {
    auditSpy.mockRestore();
  });

  it("classifies a passthrough-only name in the passthrough map, enforced at the route", () => {
    const map = (augmentModule as Record<string, unknown>).PASSTHROUGH_TOOL_CLASSIFICATIONS as
      | Record<string, { status: string }>
      | undefined;
    expect(map?.[PASSTHROUGH_ONLY]?.status).toBe("passthrough_route");
  });

  it("gives that name no host classification at the MCP boundary", async () => {
    expect(lookupPrimitiveClassification(PASSTHROUGH_ONLY)).toBeUndefined();
    const d = await enforceMcpBoundary({
      primitiveName: PASSTHROUGH_ONLY,
      ctx: { orgId: "org-1", userId: "user-1", platformRole: undefined as never },
      delegatedRestricted: false,
    });
    expect(d).toMatchObject({ allowed: false, shouldBlock: true, reason: "unclassified_primitive" });
  });
});
