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

describe("ExtensionKind union (UAC-02)", () => {
  it("includes the 4 legacy kinds + connector/artifact/workflow", () => {
    expect([...ALL_EXTENSION_KINDS].sort()).toEqual(
      [
        "agent_run",
        "agent_template",
        "artifact",
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

describe("install-time defaults (UAC-10)", () => {
  it("connector / artifact / workflow default to workspace visibility", () => {
    for (const k of ["connector", "artifact", "workflow"] as ExtensionKind[]) {
      const p = defaultAccessPolicyForKind(k);
      expect(p.runListVisibility).toBe("workspace");
      expect(p.runDataVisibility).toBe("workspace");
      expect(p.runExecuteVisibility).toBe("workspace");
      expect(p.allowRunSharing).toBe(false);
    }
  });

  it("agent / skill kinds default to owner visibility (fail-safe)", () => {
    for (const k of ["agent_run", "agent_template", "skill_package", "skill"] as ExtensionKind[]) {
      expect(defaultAccessPolicyForKind(k).runDataVisibility).toBe("owner");
    }
  });
});
