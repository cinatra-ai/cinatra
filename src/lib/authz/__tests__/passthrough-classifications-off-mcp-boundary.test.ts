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
    const map = (augmentModule as Record<string, unknown>).PASSTHROUGH_TOOL_CLASSIFICATIONS as
      | Record<string, unknown>
      | undefined;
    expect(map?.[PASSTHROUGH_ONLY]).toBeDefined();
    expect(lookupPrimitiveClassification(PASSTHROUGH_ONLY)).toBeUndefined();
    const d = await enforceMcpBoundary({
      primitiveName: PASSTHROUGH_ONLY,
      ctx: { orgId: "org-1", userId: "user-1", platformRole: undefined as never },
      delegatedRestricted: false,
    });
    expect(d).toMatchObject({ allowed: false, shouldBlock: true, reason: "unclassified_primitive" });
  });

  it("takes a host classification only from an own entry of the host map", () => {
    const viaHostHandler = (augmentModule as Record<string, unknown>).viaHostHandler as
      | ((name: string) => { resourceType: unknown; action: unknown; status: string })
      | undefined;
    expect(typeof viaHostHandler).toBe("function");
    for (const name of ["constructor", "toString", "__proto__"]) {
      const c = viaHostHandler!(name);
      expect(c.resourceType, name).toBeUndefined();
      expect(c.action, name).toBeUndefined();
    }
    // Even with a value reachable through the prototype chain, an inherited
    // key gives none (the lookup is own-property, not a property access).
    const proto = Object.prototype as Record<string, unknown>;
    proto.resourceType = "artifact";
    try {
      expect(viaHostHandler!("constructor").resourceType).toBeUndefined();
      expect(viaHostHandler!("__proto__").resourceType).toBeUndefined();
    } finally {
      delete proto.resourceType;
    }
    // An own entry still gives its resource and action.
    expect(viaHostHandler!("objects_save")).toMatchObject({
      resourceType: augmentModule.PRIMITIVE_CLASSIFICATIONS.objects_save.resourceType,
      action: augmentModule.PRIMITIVE_CLASSIFICATIONS.objects_save.action,
    });
  });
});
