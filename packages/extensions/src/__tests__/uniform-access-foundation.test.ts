import { describe, it, expect } from "vitest";

import {
  ALL_EXTENSION_KINDS,
  isExtensionKind,
  type ExtensionKind,
} from "../permissions-kind-hooks";
import { defaultAccessPolicyForKind } from "../install-access-contract";

// ---------------------------------------------------------------------------
// The ExtensionKind union covers all seven polymorphic resource kinds, and
// install-time defaults are sane per kind.
// ---------------------------------------------------------------------------

describe("ExtensionKind union", () => {
  it("includes the 4 legacy kinds + connector/artifact/workflow + connection (cinatra#951)", () => {
    expect([...ALL_EXTENSION_KINDS].sort()).toEqual(
      [
        "agent_run",
        "agent_template",
        "artifact",
        "connection",
        "connector",
        "skill",
        "skill_package",
        "workflow",
      ].sort(),
    );
  });

  it("isExtensionKind accepts each kind and rejects junk", () => {
    for (const k of ALL_EXTENSION_KINDS) expect(isExtensionKind(k)).toBe(true);
    expect(isExtensionKind("mcp_server")).toBe(false);
    expect(isExtensionKind(undefined)).toBe(false);
  });
});

describe("install-time defaults", () => {
  it("artifact / workflow default to workspace visibility", () => {
    for (const k of ["artifact", "workflow"] as ExtensionKind[]) {
      const p = defaultAccessPolicyForKind(k);
      // Multi-scope W1: visibility fields are non-empty token arrays.
      expect(p.runListVisibility).toEqual(["workspace"]);
      expect(p.runDataVisibility).toEqual(["workspace"]);
      expect(p.runExecuteVisibility).toEqual(["workspace"]);
      expect(p.allowRunSharing).toBe(false);
    }
  });

  it("the connector kind has NO static default — it derives from cinatra/config.json (cinatra#955)", () => {
    expect(() => defaultAccessPolicyForKind("connector")).toThrow(
      /no static access default/,
    );
    expect(() => defaultAccessPolicyForKind("connector")).toThrow(
      /cinatra\/config\.json declaration/,
    );
  });

  it("agent / skill kinds default to owner visibility (fail-safe)", () => {
    for (const k of ["agent_run", "agent_template", "skill_package", "skill"] as ExtensionKind[]) {
      expect(defaultAccessPolicyForKind(k).runDataVisibility).toEqual(["owner"]);
    }
  });
});
