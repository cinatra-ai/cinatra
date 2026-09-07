// THE RESOLVING ROUTE SHELLS (cinatra#2809, per-scope surfaces S3).
//
// The issue's sentence: "the settings href contract is pinned and its route
// shells resolve (page content + navigation acceptance live in the assignment
// epic); reserved segments pinned."

import { describe, expect, it } from "vitest";

import {
  resolveScopedAgentRoute,
  resolveScopedAssistantRoute,
} from "@/lib/scoped-launch-route";

describe("the scoped AGENTS shell", () => {
  it("resolves the launcher", () => {
    expect(resolveScopedAgentRoute(["acme", "writer", "new"])).toEqual({
      kind: "launch",
      vendor: "acme",
      packageName: "writer",
      agentId: "acme/writer",
    });
  });

  it("resolves the settings surface — the href the card's Settings button targets", () => {
    expect(resolveScopedAgentRoute(["acme", "writer", "settings"])).toEqual({
      kind: "settings",
      vendor: "acme",
      packageName: "writer",
      agentId: "acme/writer",
    });
  });

  it("resolves a persisted instance and its sub-routes", () => {
    expect(resolveScopedAgentRoute(["acme", "writer", "r1"])).toEqual({
      kind: "instance",
      vendor: "acme",
      packageName: "writer",
      agentId: "acme/writer",
      instanceId: "r1",
      rest: [],
    });
    expect(resolveScopedAgentRoute(["acme", "writer", "r1", "trigger"])).toEqual({
      kind: "instance",
      vendor: "acme",
      packageName: "writer",
      agentId: "acme/writer",
      instanceId: "r1",
      rest: ["trigger"],
    });
  });

  it("reserves the two words BELOW the pair, so a package named `new` still resolves", () => {
    expect(resolveScopedAgentRoute(["acme", "new", "r1"])).toEqual({
      kind: "instance",
      vendor: "acme",
      packageName: "new",
      agentId: "acme/new",
      instanceId: "r1",
      rest: [],
    });
    expect(resolveScopedAgentRoute(["acme", "settings", "new"])).toEqual({
      kind: "launch",
      vendor: "acme",
      packageName: "settings",
      agentId: "acme/settings",
    });
  });

  it("refuses the shapes that have no page", () => {
    for (const segs of [[], ["acme"], ["acme", "writer"], ["acme", "writer", "new", "x"]]) {
      expect(resolveScopedAgentRoute(segs).kind).toBe("not-found");
    }
  });

  it("refuses a malformed segment rather than addressing something else", () => {
    expect(resolveScopedAgentRoute(["acme", "", "r1"]).kind).toBe("not-found");
    expect(resolveScopedAgentRoute(["acme", "wri ter", "r1"]).kind).toBe("not-found");
    expect(resolveScopedAgentRoute(undefined).kind).toBe("not-found");
  });
});

describe("the scoped ASSISTANTS shell", () => {
  it("resolves the settings surface", () => {
    expect(resolveScopedAssistantRoute(["acme", "helper", "settings"])).toEqual({
      kind: "settings",
      vendor: "acme",
      slug: "helper",
      assistantPackageName: "@acme/helper",
    });
  });

  it("hands every conversation shape to the SAME renderer, base already split off", () => {
    expect(resolveScopedAssistantRoute(["acme", "helper"])).toEqual({
      kind: "chat",
      slug: ["acme", "helper"],
    });
    expect(resolveScopedAssistantRoute(["acme", "helper", "my-thread"])).toEqual({
      kind: "chat",
      slug: ["acme", "helper", "my-thread"],
    });
    expect(resolveScopedAssistantRoute(["acme", "helper", "i1", "my-thread"])).toEqual({
      kind: "chat",
      slug: ["acme", "helper", "i1", "my-thread"],
    });
  });

  it("refuses the shapes that have no page", () => {
    for (const segs of [[], ["acme"], ["acme", "helper", "i1", "t", "extra"]]) {
      expect(resolveScopedAssistantRoute(segs).kind).toBe("not-found");
    }
  });

  it("refuses a malformed segment", () => {
    expect(resolveScopedAssistantRoute(["acme", "hel per"]).kind).toBe("not-found");
    expect(resolveScopedAssistantRoute(undefined).kind).toBe("not-found");
  });
});
