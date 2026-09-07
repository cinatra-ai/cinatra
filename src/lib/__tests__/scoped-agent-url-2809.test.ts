// The scope-base PREFIX on the agent path builders, and the reserved segments
// below the vendor/package pair (cinatra#2809, per-scope surfaces S3).
//
// The issue's sentences: "Path builders gain a scope-base PREFIX parameter
// (agent-url; all four CHAT_ROOT sites)" and "`new` and `settings` are reserved
// below the vendor/package pair (test-pinned)".

import { describe, it, expect } from "vitest";

import {
  AGENT_LAUNCH_SEGMENT,
  AGENT_SETTINGS_SEGMENT,
  RESERVED_AGENT_INSTANCE_SEGMENTS,
  buildAgentInstancePath,
  buildAgentPackageBasePath,
  buildAgentSettingsPath,
  buildAgentWorkspacePath,
  isReservedAgentInstanceSegment,
} from "@/lib/agent-url";
import { scopeSurfaceBase } from "@/lib/scope-surfaces";

const SCOPES = [
  { ref: { kind: "workspace" } as const, base: "/workspace" },
  { ref: { kind: "personal" } as const, base: "/personal" },
  { ref: { kind: "organization", id: "o1" } as const, base: "/organizations/o1" },
  { ref: { kind: "team", id: "t1" } as const, base: "/teams/t1" },
  { ref: { kind: "project", id: "p1" } as const, base: "/projects/p1" },
];

describe("the bare routes are unchanged", () => {
  it("builds the same paths as before when no scope base is given", () => {
    expect(buildAgentInstancePath("@acme/writer", "r1")).toBe("/agents/acme/writer/r1");
    expect(buildAgentInstancePath("writer", "r1")).toBe("/agents/writer/r1");
    expect(buildAgentWorkspacePath("@acme/writer")).toBe("/agents/acme/writer/new");
    expect(buildAgentPackageBasePath("@acme/writer")).toBe("/agents/acme/writer");
  });
});

describe("the scope base is a PREFIX, on every scope", () => {
  for (const { ref, base } of SCOPES) {
    it(`prefixes ${base}`, () => {
      expect(scopeSurfaceBase(ref)).toBe(base);
      expect(buildAgentInstancePath("@acme/writer", "r1", { scopeBase: base })).toBe(
        `${base}/agents/acme/writer/r1`,
      );
      expect(buildAgentWorkspacePath("@acme/writer", { scopeBase: base })).toBe(
        `${base}/agents/acme/writer/new`,
      );
      expect(buildAgentPackageBasePath("@acme/writer", { scopeBase: base })).toBe(
        `${base}/agents/acme/writer`,
      );
      expect(buildAgentSettingsPath("@acme/writer", { scopeBase: base })).toBe(
        `${base}/agents/acme/writer/settings`,
      );
    });
  }

  it("refuses a base that is not a rooted, slash-terminated-free path", () => {
    for (const bad of ["workspace", "/workspace/", "", "//workspace", "/work space"]) {
      expect(() => buildAgentInstancePath("@acme/writer", "r1", { scopeBase: bad })).toThrow(
        /scope base/i,
      );
    }
  });
});

describe("`new` and `settings` are reserved below the vendor/package pair", () => {
  it("names exactly those two segments", () => {
    expect(AGENT_LAUNCH_SEGMENT).toBe("new");
    expect(AGENT_SETTINGS_SEGMENT).toBe("settings");
    expect([...RESERVED_AGENT_INSTANCE_SEGMENTS].sort()).toEqual(["new", "settings"]);
    expect(isReservedAgentInstanceSegment("new")).toBe(true);
    expect(isReservedAgentInstanceSegment("settings")).toBe(true);
    expect(isReservedAgentInstanceSegment("r1")).toBe(false);
  });

  it("refuses to address an INSTANCE by a reserved word — the launcher wins the collision", () => {
    expect(() => buildAgentInstancePath("@acme/writer", "new")).toThrow(/reserved/i);
    expect(() => buildAgentInstancePath("@acme/writer", "settings")).toThrow(/reserved/i);
  });

  it("reserves them BELOW the pair, so a package literally named `new` still resolves", () => {
    // A package may be called `new` or `settings`; the reservation is on the
    // segment AFTER the vendor/package pair, never on the pair itself.
    expect(buildAgentPackageBasePath("@acme/new", { scopeBase: "/teams/t1" })).toBe(
      "/teams/t1/agents/acme/new",
    );
    expect(buildAgentWorkspacePath("@acme/settings", { scopeBase: "/teams/t1" })).toBe(
      "/teams/t1/agents/acme/settings/new",
    );
    expect(isReservedAgentInstanceSegment("new")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A HOST ESCAPE THE FIRST CUT LET THROUGH: the base validator accepted a BACKSLASH.
// `/\\attacker.example` passed `[^/\\s]+` and minted
// `/\\attacker.example/agents/…`; a browser reads `/\\` as `//` and resolves that
// to https://attacker.example/agents/… — the very host escape the validator
// exists to stop. Proved with the platform's own URL parser, not by assertion.
// ---------------------------------------------------------------------------
describe("the scope base refuses a backslash (convergence)", () => {
  const HOSTILE = "/\\attacker.example";

  it("a browser really would read the unguarded shape as another host", () => {
    expect(new URL(`${HOSTILE}/agents/acme/writer/r1`, "https://cinatra.example").host).toBe(
      "attacker.example",
    );
  });

  it("refuses it in every builder rather than minting it", () => {
    expect(() => buildAgentInstancePath("@acme/writer", "r1", { scopeBase: HOSTILE })).toThrow(
      /invalid scope base/,
    );
    expect(() => buildAgentWorkspacePath("@acme/writer", { scopeBase: HOSTILE })).toThrow(
      /invalid scope base/,
    );
    expect(() => buildAgentSettingsPath("@acme/writer", { scopeBase: HOSTILE })).toThrow(
      /invalid scope base/,
    );
  });

  it("still accepts every real scope base", () => {
    for (const base of ["/workspace", "/personal", "/teams/t1", "/organizations/o1", "/projects/p1"]) {
      expect(buildAgentInstancePath("@acme/writer", "r1", { scopeBase: base })).toBe(
        `${base}/agents/acme/writer/r1`,
      );
    }
  });
});
