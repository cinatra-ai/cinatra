/**
 * Cross-realm structural error-discriminator contract (#1715 D1).
 *
 * The provider adapters are relocating into their connectors (epic #1711). Once
 * the host resolves a CONNECTOR-registered adapter, a connector-inlined copy of
 * these sentinel error classes lives in a SEPARATE module realm — same shape,
 * DIFFERENT constructor identity — so `err instanceof <CoreClass>` silently
 * returns false and a fail-loud configuration sentinel would be swallowed to a
 * warning (the agent-creation-review.ts rethrow bug).
 *
 * These tests pin the fix: the `is*Error` predicates recognize a foreign-realm
 * copy (proven by constructing classes that do NOT extend the core ones and
 * asserting `instanceof` fails while the predicate matches), and reject
 * unrelated errors.
 */
import { describe, it, expect } from "vitest";

import {
  AnthropicSkillDeliveryError,
  AnthropicSkillNotSyncedError,
  AnthropicSkillCapError,
  AnthropicFunctionToolSkillError,
  AnthropicSkillPreflightError,
  BatchNotSupportedError,
  NativeMcpCapabilityRequiredError,
  McpApprovalUnsupportedError,
  isAnthropicSkillDeliveryError,
  isBatchNotSupportedError,
  isNativeMcpCapabilityRequiredError,
  isMcpApprovalUnsupportedError,
  ANTHROPIC_SKILL_DELIVERY_ERROR_CODES,
} from "../errors";

// ---------------------------------------------------------------------------
// Foreign-realm faithful copies. These deliberately DO NOT extend the core
// classes — they stand in for a connector-inlined copy with a different
// constructor identity but the same observable `code`/`provider`/`name` shape.
// ---------------------------------------------------------------------------

/** A faithful foreign-realm copy of AnthropicSkillNotSyncedError. */
class ForeignAnthropicSkillNotSyncedError extends Error {
  readonly code = "anthropic_skill_not_synced" as const;
  readonly provider = "anthropic" as const;
  readonly catalogSkillIds: string[];
  constructor(catalogSkillIds: string[]) {
    super("foreign realm not-synced");
    this.name = "AnthropicSkillNotSyncedError";
    this.catalogSkillIds = catalogSkillIds;
  }
}

/** A faithful foreign-realm copy of AnthropicFunctionToolSkillError. */
class ForeignAnthropicFunctionToolSkillError extends Error {
  readonly code = "anthropic_function_tool_skill_forbidden" as const;
  readonly provider = "anthropic" as const;
  constructor() {
    super("foreign realm function-tool");
    this.name = "AnthropicFunctionToolSkillError";
  }
}

/** A faithful foreign-realm copy of BatchNotSupportedError. */
class ForeignBatchNotSupportedError extends Error {
  readonly code = "batch_not_supported" as const;
  readonly provider = "gemini" as const;
  constructor() {
    super("foreign realm batch");
    this.name = "BatchNotSupportedError";
  }
}

/** A faithful foreign-realm copy of NativeMcpCapabilityRequiredError. */
class ForeignNativeMcpCapabilityRequiredError extends Error {
  readonly code = "native_mcp_capability_required" as const;
  readonly provider = "anthropic" as const;
  constructor() {
    super("foreign realm native-mcp");
    this.name = "NativeMcpCapabilityRequiredError";
  }
}

/** A faithful foreign-realm copy of McpApprovalUnsupportedError. */
class ForeignMcpApprovalUnsupportedError extends Error {
  readonly code = "mcp_approval_unsupported" as const;
  readonly provider = "anthropic" as const;
  constructor() {
    super("foreign realm mcp-approval");
    this.name = "McpApprovalUnsupportedError";
  }
}

describe("isAnthropicSkillDeliveryError — cross-realm structural discriminator", () => {
  it("recognizes every in-core subclass instance", () => {
    const instances: AnthropicSkillDeliveryError[] = [
      new AnthropicSkillNotSyncedError(["skill.a"]),
      new AnthropicSkillCapError(9, ["skill.a", "skill.b"]),
      new AnthropicFunctionToolSkillError("read_skill(foo)"),
      new AnthropicSkillPreflightError({
        kind: "size",
        offendingSkillIds: ["skill.big"],
        byteSize: 1,
        message: "too big",
      }),
    ];
    for (const err of instances) {
      expect(isAnthropicSkillDeliveryError(err)).toBe(true);
    }
  });

  it("recognizes a FOREIGN-REALM copy where instanceof fails", () => {
    const foreign = new ForeignAnthropicSkillNotSyncedError(["skill.a"]);
    // The realm gap: instanceof against the core class MISSES it (this is the
    // exact bug — the swallowed sentinel).
    expect(foreign instanceof AnthropicSkillDeliveryError).toBe(false);
    // The structural discriminator RECOGNIZES it.
    expect(isAnthropicSkillDeliveryError(foreign)).toBe(true);
    expect(isAnthropicSkillDeliveryError(new ForeignAnthropicFunctionToolSkillError())).toBe(true);
  });

  it("rejects unrelated errors and non-error inputs", () => {
    expect(isAnthropicSkillDeliveryError(new Error("plain"))).toBe(false);
    expect(isAnthropicSkillDeliveryError(new TypeError("type"))).toBe(false);
    // Right code family but wrong provider (not anthropic) → not a match.
    expect(
      isAnthropicSkillDeliveryError({ code: "anthropic_skill_not_synced", provider: "openai" }),
    ).toBe(false);
    // A skill-delivery code with no provider field → not a match.
    expect(isAnthropicSkillDeliveryError({ code: "anthropic_skill_not_synced" })).toBe(false);
    // An unrelated coded error that is anthropic-provider → not a skill-delivery match.
    expect(
      isAnthropicSkillDeliveryError({ code: "some_other_error", provider: "anthropic" }),
    ).toBe(false);
    expect(isAnthropicSkillDeliveryError(null)).toBe(false);
    expect(isAnthropicSkillDeliveryError(undefined)).toBe(false);
    expect(isAnthropicSkillDeliveryError("anthropic_skill_not_synced")).toBe(false);
    // The three standalone sibling sentinels are NOT skill-delivery errors.
    expect(isAnthropicSkillDeliveryError(new BatchNotSupportedError("anthropic"))).toBe(false);
    expect(isAnthropicSkillDeliveryError(new NativeMcpCapabilityRequiredError("anthropic"))).toBe(false);
  });

  it("the code set stays in sync with the concrete subclasses' codes", () => {
    // Guards drift: every concrete subclass code must be in the discriminator's
    // set (a new subclass without its code added would silently escape).
    const subclassCodes = [
      new AnthropicSkillNotSyncedError([]).code,
      new AnthropicSkillCapError(1, []).code,
      new AnthropicFunctionToolSkillError("x").code,
      new AnthropicSkillPreflightError({ kind: "size", offendingSkillIds: [], message: "m" }).code,
    ].sort();
    expect([...ANTHROPIC_SKILL_DELIVERY_ERROR_CODES].sort()).toEqual(subclassCodes);
  });
});

describe("isBatchNotSupportedError — cross-realm structural discriminator", () => {
  it("recognizes the in-core instance and a foreign-realm copy where instanceof fails", () => {
    const core = new BatchNotSupportedError("gemini");
    expect(isBatchNotSupportedError(core)).toBe(true);
    const foreign = new ForeignBatchNotSupportedError();
    expect(foreign instanceof BatchNotSupportedError).toBe(false);
    expect(isBatchNotSupportedError(foreign)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isBatchNotSupportedError(new Error("plain"))).toBe(false);
    expect(isBatchNotSupportedError(new NativeMcpCapabilityRequiredError("anthropic"))).toBe(false);
    expect(isBatchNotSupportedError({ code: "native_mcp_capability_required" })).toBe(false);
    expect(isBatchNotSupportedError(null)).toBe(false);
  });
});

describe("isNativeMcpCapabilityRequiredError — cross-realm structural discriminator", () => {
  it("recognizes the in-core instance and a foreign-realm copy where instanceof fails", () => {
    const core = new NativeMcpCapabilityRequiredError("anthropic");
    expect(isNativeMcpCapabilityRequiredError(core)).toBe(true);
    const foreign = new ForeignNativeMcpCapabilityRequiredError();
    expect(foreign instanceof NativeMcpCapabilityRequiredError).toBe(false);
    expect(isNativeMcpCapabilityRequiredError(foreign)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isNativeMcpCapabilityRequiredError(new BatchNotSupportedError("anthropic"))).toBe(false);
    expect(isNativeMcpCapabilityRequiredError(new McpApprovalUnsupportedError("anthropic", ["s"]))).toBe(false);
    expect(isNativeMcpCapabilityRequiredError(null)).toBe(false);
  });
});

describe("isMcpApprovalUnsupportedError — cross-realm structural discriminator", () => {
  it("recognizes the in-core instance and a foreign-realm copy where instanceof fails", () => {
    const core = new McpApprovalUnsupportedError("anthropic", ["srv-a"]);
    expect(isMcpApprovalUnsupportedError(core)).toBe(true);
    const foreign = new ForeignMcpApprovalUnsupportedError();
    expect(foreign instanceof McpApprovalUnsupportedError).toBe(false);
    expect(isMcpApprovalUnsupportedError(foreign)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isMcpApprovalUnsupportedError(new NativeMcpCapabilityRequiredError("anthropic"))).toBe(false);
    expect(isMcpApprovalUnsupportedError(new Error("plain"))).toBe(false);
    expect(isMcpApprovalUnsupportedError(undefined)).toBe(false);
  });
});
