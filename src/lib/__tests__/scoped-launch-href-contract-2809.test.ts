// THE HREF CONTRACT the per-scope cards compose on (cinatra#2809, S3; the
// consumer is #2808's Run / Chat / Settings buttons).
//
// The issue's sentence: "this epic pins the settings-HREF contract (the card's
// Settings button targets `<scope-base>/agents/<vendor>/<packageName>/settings`
// / the assistants analog) and mounts resolving route SHELLS".

import { describe, it, expect } from "vitest";

import { SCOPED_CHAT_SEGMENT, chatMountRoot } from "@cinatra-ai/chat/chat-path-codec";
import { canonicalThreadPath } from "@/lib/launch-scope-anchor";
import {
  AGENT_LAUNCH_SEGMENT,
  AGENT_SETTINGS_SEGMENT,
  buildAgentInstancePath,
  buildAgentSettingsPath,
  buildAgentWorkspacePath,
} from "@/lib/agent-url";
import { AGENTS_NAV, agentsNavFor } from "@/lib/agents-nav";
import {
  SCOPE_SURFACE_ASSISTANTS_SEGMENT,
  type ScopeSurfaceRef,
  scopeSurfaceAgentInstanceHref,
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceAssistantBaseHref,
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  scopeSurfaceBase,
} from "@/lib/scope-surfaces";

const SCOPES: ScopeSurfaceRef[] = [
  { kind: "workspace" },
  { kind: "personal" },
  { kind: "organization", id: "o1" },
  { kind: "team", id: "t1" },
  { kind: "project", id: "p1" },
];

describe("the agent card's three hrefs, at every scope", () => {
  for (const scope of SCOPES) {
    const base = scopeSurfaceBase(scope);
    it(`resolves under ${base}`, () => {
      expect(scopeSurfaceAgentLaunchHref(scope, "@acme/writer")).toBe(
        `${base}/agents/acme/writer/new`,
      );
      expect(scopeSurfaceAgentSettingsHref(scope, "@acme/writer")).toBe(
        `${base}/agents/acme/writer/settings`,
      );
      expect(scopeSurfaceAgentInstanceHref(scope, "@acme/writer", "r1")).toBe(
        `${base}/agents/acme/writer/r1`,
      );
      // The contract is the path BUILDER's answer — this surface never spells a
      // second grammar for the same address.
      expect(scopeSurfaceAgentLaunchHref(scope, "@acme/writer")).toBe(
        buildAgentWorkspacePath("@acme/writer", { scopeBase: base }),
      );
      expect(scopeSurfaceAgentSettingsHref(scope, "@acme/writer")).toBe(
        buildAgentSettingsPath("@acme/writer", { scopeBase: base }),
      );
      expect(scopeSurfaceAgentInstanceHref(scope, "@acme/writer", "r1")).toBe(
        buildAgentInstancePath("@acme/writer", "r1", { scopeBase: base }),
      );
    });
  }
});

describe("the assistant card's hrefs, at every scope", () => {
  for (const scope of SCOPES) {
    const base = scopeSurfaceBase(scope);
    it(`resolves under ${base}`, () => {
      expect(scopeSurfaceAssistantLaunchHref(scope, { vendor: "acme", slug: "helper" })).toBe(
        `${base}/assistants/acme/helper`,
      );
      // A remote assistant's launch is scoped to one connected site.
      expect(
        scopeSurfaceAssistantLaunchHref(scope, { vendor: "acme", slug: "helper", instance: "i1" }),
      ).toBe(`${base}/assistants/acme/helper/i1`);
      expect(scopeSurfaceAssistantSettingsHref(scope, { vendor: "acme", slug: "helper" })).toBe(
        `${base}/assistants/acme/helper/settings`,
      );
    });
  }

  it("refuses a slash-carrying vendor or slug rather than minting a wrong address", () => {
    expect(() =>
      scopeSurfaceAssistantLaunchHref({ kind: "workspace" }, { vendor: "a/b", slug: "helper" }),
    ).toThrow(/segment/i);
  });
});

describe("the segment vocabulary agrees across the leaves", () => {
  it("spells the launcher and the settings segments once", () => {
    expect(AGENT_LAUNCH_SEGMENT).toBe("new");
    expect(AGENT_SETTINGS_SEGMENT).toBe("settings");
  });
  it("spells the scoped assistants mount the same way the chat codec does", () => {
    expect(SCOPE_SURFACE_ASSISTANTS_SEGMENT).toBe(SCOPED_CHAT_SEGMENT);
  });
});

describe("AGENTS_NAV never escapes the scope it renders in", () => {
  it("keeps the bare hrefs at the root", () => {
    expect(agentsNavFor()).toEqual(AGENTS_NAV);
    expect(agentsNavFor().map((i) => i.href)).toEqual([
      "/agents",
      "/agents/executions",
      "/agents/reviews",
    ]);
  });

  for (const scope of SCOPES) {
    const base = scopeSurfaceBase(scope);
    it(`renders scoped hrefs under ${base} — no item points at the root`, () => {
      const items = agentsNavFor(base);
      expect(items.map((i) => i.href)).toEqual([
        `${base}/agents`,
        `${base}/agents/executions`,
        `${base}/agents/reviews`,
      ]);
      // ROOT ESCAPE: not one href may leave the scope base.
      for (const item of items) {
        expect(item.href.startsWith(`${base}/`)).toBe(true);
      }
      // Labels and keys are the scope-invariant half of the bar.
      expect(items.map((i) => i.value)).toEqual(AGENTS_NAV.map((i) => i.value));
      expect(items.map((i) => i.label)).toEqual(AGENTS_NAV.map((i) => i.label));
    });
  }

  it("refuses a malformed base rather than rendering a broken bar", () => {
    expect(() => agentsNavFor("/teams/t1/")).toThrow(/scope base/i);
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE ROUND (codex, this lane): the published contract and the path
// builders disagreed PRECISELY on the reserved collision -- the one input where
// disagreeing turns an instance link into a launcher.
// ---------------------------------------------------------------------------
describe("the reserved words hold on BOTH sides of the contract (convergence)", () => {
  const TEAM: ScopeSurfaceRef = { kind: "team", id: "t1" };

  it("refuses a persisted instance id that occupies a reserved word", () => {
    for (const reserved of [AGENT_LAUNCH_SEGMENT, AGENT_SETTINGS_SEGMENT]) {
      expect(() => scopeSurfaceAgentInstanceHref(TEAM, "@acme/writer", reserved)).toThrow(
        /reserved path segment/,
      );
      expect(() => buildAgentInstancePath("@acme/writer", reserved, { scopeBase: "/teams/t1" })).toThrow();
    }
  });

  it("refuses a malformed instance segment instead of splicing it into the path", () => {
    for (const bad of ["", "a/b", "a b"]) {
      expect(() => scopeSurfaceAgentInstanceHref(TEAM, "@acme/writer", bad)).toThrow();
    }
  });

  it("refuses a connected site named for the settings shell", () => {
    expect(() =>
      scopeSurfaceAssistantLaunchHref(TEAM, { vendor: "acme", slug: "helper", instance: AGENT_SETTINGS_SEGMENT }),
    ).toThrow(/reserved path segment/);
  });

  it("still agrees with the path builder on an ordinary id", () => {
    expect(scopeSurfaceAgentInstanceHref(TEAM, "@acme/writer", "r1")).toBe(
      buildAgentInstancePath("@acme/writer", "r1", { scopeBase: "/teams/t1" }),
    );
  });
});

describe("the canonical thread home lands on the published mount (convergence)", () => {
  it("agrees with scopeSurfaceAssistantBaseHref, segment for segment", () => {
    const TEAM: ScopeSurfaceRef = { kind: "team", id: "t1" };
    expect(canonicalThreadPath({ chatPath: "/chat/acme/helper", anchor: { v: 1, kind: "team", id: "t1" } })).toBe(
      scopeSurfaceAssistantBaseHref(TEAM, { vendor: "acme", slug: "helper" }),
    );
  });

  it("and on the codec's own mount root", () => {
    expect(chatMountRoot({ scopeBase: "/teams/t1" })).toBe(
      `/teams/t1/${SCOPE_SURFACE_ASSISTANTS_SEGMENT}`,
    );
    expect(SCOPE_SURFACE_ASSISTANTS_SEGMENT).toBe(SCOPED_CHAT_SEGMENT);
  });
});
