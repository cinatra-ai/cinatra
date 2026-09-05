// The launch anchor's closed union, its fail-closed decoder, and the canonical
// addresses it derives (cinatra#2809, per-scope surfaces S3).
//
// Pins the issue's own sentences: "Unknown versions, kinds, missing/empty ids,
// and workspace anchors carrying an id fail closed as unanchored; no other
// column is consulted to repair them", "Workspace canonicalizes under
// /workspace; user remains flat by design", and "The storage-only
// `__workspace__` sentinel is never serialized into this anchor".

import { describe, it, expect } from "vitest";

import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import {
  LAUNCH_SCOPE_ANCHOR_KINDS,
  LAUNCH_SCOPE_ANCHOR_VERSION,
  assertLaunchScopeAnchorNotMutated,
  buildLaunchScopeAnchor,
  canonicalRunPath,
  canonicalThreadPath,
  homeRedirectFor,
  launchScopeAnchorBase,
  launchScopeAnchorForScope,
  launchScopeInstanceLabel,
  parseLaunchScopeAnchor,
  readLaunchScopeAnchor,
  serializeLaunchScopeAnchor,
} from "@/lib/launch-scope-anchor";

describe("LaunchScopeAnchorV1 — the closed union", () => {
  it("names exactly the five scope kinds, at version 1", () => {
    expect(LAUNCH_SCOPE_ANCHOR_VERSION).toBe(1);
    expect([...LAUNCH_SCOPE_ANCHOR_KINDS]).toEqual([
      "workspace",
      "organization",
      "team",
      "project",
      "user",
    ]);
  });

  it("round-trips all five arms through serialize → parse", () => {
    const arms = [
      { v: 1 as const, kind: "workspace" as const },
      { v: 1 as const, kind: "organization" as const, id: "org_1" },
      { v: 1 as const, kind: "team" as const, id: "team_1" },
      { v: 1 as const, kind: "project" as const, id: "proj_1" },
      { v: 1 as const, kind: "user" as const, id: "user_1" },
    ];
    for (const arm of arms) {
      expect(parseLaunchScopeAnchor(serializeLaunchScopeAnchor(arm))).toEqual(arm);
      // A jsonb column hands back the parsed object, not the text.
      expect(parseLaunchScopeAnchor({ ...arm })).toEqual(arm);
    }
  });
});

describe("the decoder fails closed", () => {
  const malformed: [string, unknown][] = [
    ["an absent column", null],
    ["undefined", undefined],
    ["unparseable text", "{not json"],
    ["a non-object", 42],
    ["an unknown version", { v: 2, kind: "organization", id: "org_1" }],
    ["a missing version", { kind: "organization", id: "org_1" }],
    ["an unknown kind", { v: 1, kind: "galaxy", id: "g_1" }],
    ["a missing id", { v: 1, kind: "organization" }],
    ["an empty id", { v: 1, kind: "team", id: "" }],
    ["a whitespace-only id", { v: 1, kind: "project", id: "   " }],
    ["a non-string id", { v: 1, kind: "user", id: 7 }],
    ["a workspace anchor carrying an id", { v: 1, kind: "workspace", id: "org_1" }],
    ["the storage-only sentinel as an id", { v: 1, kind: "organization", id: WORKSPACE_SCOPE_SENTINEL }],
  ];
  for (const [name, raw] of malformed) {
    it(`resolves ${name} to unanchored`, () => {
      expect(parseLaunchScopeAnchor(raw)).toBeNull();
    });
  }

  it("never consults another column to repair a malformed row", () => {
    // The decoder takes ONE argument. A repair would need a second.
    expect(parseLaunchScopeAnchor.length).toBe(1);
  });

  it("separates an ABSENT column from a MALFORMED payload", () => {
    expect(readLaunchScopeAnchor(null)).toEqual({ kind: "unanchored", reason: "absent" });
    expect(readLaunchScopeAnchor({ v: 9 })).toEqual({ kind: "unanchored", reason: "malformed" });
    expect(readLaunchScopeAnchor({ v: 1, kind: "team", id: "t1" })).toEqual({
      kind: "anchored",
      anchor: { v: 1, kind: "team", id: "t1" },
    });
  });
});

describe("buildLaunchScopeAnchor — the mint", () => {
  it("mints the workspace arm with no id", () => {
    expect(buildLaunchScopeAnchor({ kind: "workspace" })).toEqual({ v: 1, kind: "workspace" });
  });
  it("trims an id, mirroring the store's own normalization", () => {
    expect(buildLaunchScopeAnchor({ kind: "team", id: "  t1  " })).toEqual({
      v: 1,
      kind: "team",
      id: "t1",
    });
  });
  it("refuses a workspace mint carrying an id, and an id-bearing kind without one", () => {
    expect(buildLaunchScopeAnchor({ kind: "workspace", id: "org_1" })).toBeNull();
    expect(buildLaunchScopeAnchor({ kind: "organization" })).toBeNull();
    expect(buildLaunchScopeAnchor({ kind: "organization", id: "  " })).toBeNull();
  });
  it("never mints the storage-only sentinel into an anchor", () => {
    expect(buildLaunchScopeAnchor({ kind: "organization", id: WORKSPACE_SCOPE_SENTINEL })).toBeNull();
    expect(JSON.stringify(buildLaunchScopeAnchor({ kind: "workspace" }))).not.toContain(
      WORKSPACE_SCOPE_SENTINEL,
    );
  });
});

describe("the canonical home", () => {
  it("canonicalizes the workspace under /workspace", () => {
    expect(launchScopeAnchorBase({ v: 1, kind: "workspace" })).toBe("/workspace");
  });
  it("puts the three id-bearing container scopes under their own route", () => {
    expect(launchScopeAnchorBase({ v: 1, kind: "organization", id: "o 1" })).toBe(
      "/organizations/o%201",
    );
    expect(launchScopeAnchorBase({ v: 1, kind: "team", id: "t1" })).toBe("/teams/t1");
    expect(launchScopeAnchorBase({ v: 1, kind: "project", id: "p1" })).toBe("/projects/p1");
  });
  it("keeps a user anchor FLAT by design — /personal is actor-relative", () => {
    expect(launchScopeAnchorBase({ v: 1, kind: "user", id: "u1" })).toBeNull();
  });
  it("keeps an unanchored instance flat", () => {
    expect(launchScopeAnchorBase(null)).toBeNull();
  });
});

describe("canonical run and thread addresses", () => {
  const run = { agentPackageName: "@acme/writer", instanceId: "run_1" };

  it("addresses an org-anchored run under its organization", () => {
    expect(canonicalRunPath({ ...run, anchor: { v: 1, kind: "organization", id: "o1" } })).toBe(
      "/organizations/o1/agents/acme/writer/run_1",
    );
  });
  it("addresses a workspace-anchored run under /workspace", () => {
    expect(canonicalRunPath({ ...run, anchor: { v: 1, kind: "workspace" } })).toBe(
      "/workspace/agents/acme/writer/run_1",
    );
  });
  it("leaves a user-anchored and an unanchored run on the bare route", () => {
    expect(canonicalRunPath({ ...run, anchor: { v: 1, kind: "user", id: "u1" } })).toBe(
      "/agents/acme/writer/run_1",
    );
    expect(canonicalRunPath({ ...run, anchor: null })).toBe("/agents/acme/writer/run_1");
  });
  it("re-homes a thread's bare chat path under its anchor, and leaves a flat one alone", () => {
    expect(
      canonicalThreadPath({ chatPath: "/chat/acme/helper/my-thread", anchor: { v: 1, kind: "team", id: "t1" } }),
      // CONVERGENCE ROUND (codex, this lane): this read
      // "/teams/t1/chat/acme/helper/my-thread" -- an address NO route answers,
      // because the scoped mount is <base>/assistants, not <base>/chat. The
      // canonical home a reader is redirected to must be a home they can reach.
    ).toBe("/teams/t1/assistants/acme/helper/my-thread");
    expect(canonicalThreadPath({ chatPath: "/chat/acme/helper", anchor: null })).toBe(
      "/chat/acme/helper",
    );
  });
});

describe("the home redirect", () => {
  it("redirects an anchored non-personal instance off the bare route", () => {
    expect(homeRedirectFor("/agents/acme/writer/run_1", "/teams/t1/agents/acme/writer/run_1")).toBe(
      "/teams/t1/agents/acme/writer/run_1",
    );
  });
  it("redirects a WRONG scoped path to the canonical home", () => {
    expect(
      homeRedirectFor("/organizations/o9/agents/acme/writer/run_1", "/teams/t1/agents/acme/writer/run_1"),
    ).toBe("/teams/t1/agents/acme/writer/run_1");
  });
  it("answers null on the canonical path itself, so the page renders once", () => {
    expect(homeRedirectFor("/teams/t1/agents/acme/writer/run_1", "/teams/t1/agents/acme/writer/run_1")).toBeNull();
  });
  it("ignores a trailing slash rather than looping on it", () => {
    expect(homeRedirectFor("/teams/t1/agents/acme/writer/run_1/", "/teams/t1/agents/acme/writer/run_1")).toBeNull();
  });
});

describe("the flat instance label", () => {
  it("labels a personal-anchored instance for its owner", () => {
    expect(launchScopeInstanceLabel(readLaunchScopeAnchor({ v: 1, kind: "user", id: "u1" }), {})).toBe(
      "Personal (owner)",
    );
  });
  it("labels a pre-column row Legacy and a malformed one Global", () => {
    expect(launchScopeInstanceLabel(readLaunchScopeAnchor(null), {})).toBe("Legacy");
    expect(launchScopeInstanceLabel(readLaunchScopeAnchor({ v: 3 }), {})).toBe("Global");
  });
  it("labels an A2A instance Global whatever the column says", () => {
    expect(launchScopeInstanceLabel(readLaunchScopeAnchor(null), { a2a: true })).toBe("Global");
  });
  it("gives a scoped instance no flat label — it lives at its home", () => {
    expect(
      launchScopeInstanceLabel(readLaunchScopeAnchor({ v: 1, kind: "project", id: "p1" }), {}),
    ).toBeNull();
  });
});

describe("the anchor is immutable", () => {
  it("refuses an update payload that carries it, in either spelling", () => {
    expect(() => assertLaunchScopeAnchorNotMutated({ launchScopeAnchor: null })).toThrow(
      /IMMUTABLE/,
    );
    expect(() => assertLaunchScopeAnchorNotMutated({ launch_scope_anchor: "{}" })).toThrow(
      /IMMUTABLE/,
    );
    expect(() => assertLaunchScopeAnchorNotMutated({ title: "fine" })).not.toThrow();
  });
});

describe("minting the anchor FROM the launching route's scope", () => {
  it("mints the workspace arm with no id", () => {
    expect(launchScopeAnchorForScope({ kind: "workspace" }, "u1")).toEqual({
      v: 1,
      kind: "workspace",
    });
  });

  it("mints the three container scopes from their own id", () => {
    expect(launchScopeAnchorForScope({ kind: "organization", id: "o1" }, "u1")).toEqual({
      v: 1,
      kind: "organization",
      id: "o1",
    });
    expect(launchScopeAnchorForScope({ kind: "team", id: "t1" }, "u1")).toEqual({
      v: 1,
      kind: "team",
      id: "t1",
    });
    expect(launchScopeAnchorForScope({ kind: "project", id: "p1" }, "u1")).toEqual({
      v: 1,
      kind: "project",
      id: "p1",
    });
  });

  it("mints the PERSONAL scope as the originating human, never as a route id", () => {
    // `/personal` is actor-relative — it names the person reading it — so the
    // anchor records WHO launched, which is a durable id.
    expect(launchScopeAnchorForScope({ kind: "personal" }, "u1")).toEqual({
      v: 1,
      kind: "user",
      id: "u1",
    });
  });

  it("mints NOTHING when the personal launcher has no signed-in human", () => {
    expect(launchScopeAnchorForScope({ kind: "personal" }, null)).toBeNull();
  });

  it("mints nothing for a launch made from no scope at all", () => {
    expect(launchScopeAnchorForScope(null, "u1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE ROUND (codex, this lane). Two fail-open edges the first cut left.
// ---------------------------------------------------------------------------
describe("the canonical thread address (convergence)", () => {
  it("re-homes under the scoped MOUNT, for every anchored kind", () => {
    expect(canonicalThreadPath({ chatPath: "/chat/acme/helper", anchor: { v: 1, kind: "workspace" } })).toBe(
      "/workspace/assistants/acme/helper",
    );
    expect(
      canonicalThreadPath({ chatPath: "/chat/acme/helper/site/t", anchor: { v: 1, kind: "project", id: "p1" } }),
    ).toBe("/projects/p1/assistants/acme/helper/site/t");
  });

  it("never mints the /chat-under-a-base shape that answers nowhere", () => {
    const home = canonicalThreadPath({ chatPath: "/chat/acme/helper", anchor: { v: 1, kind: "team", id: "t1" } });
    expect(home.startsWith("/teams/t1/assistants/")).toBe(true);
    expect(home).not.toContain("/chat/");
  });

  it("a user anchor stays FLAT, so the bare path is already the home", () => {
    expect(canonicalThreadPath({ chatPath: "/chat/acme/helper", anchor: { v: 1, kind: "user", id: "u1" } })).toBe(
      "/chat/acme/helper",
    );
  });

  it("refuses a path that is not a chat path rather than inventing one", () => {
    expect(() =>
      canonicalThreadPath({ chatPath: "/agents/acme/writer/r1", anchor: { v: 1, kind: "team", id: "t1" } }),
    ).toThrow(/not a chat path/);
  });
});

describe("a workspace payload that carries an id at all (convergence)", () => {
  it("reads as UNANCHORED when the key is present, null included", () => {
    expect(parseLaunchScopeAnchor({ v: 1, kind: "workspace", id: null })).toBeNull();
    expect(parseLaunchScopeAnchor({ v: 1, kind: "workspace", id: "" })).toBeNull();
    expect(parseLaunchScopeAnchor({ v: 1, kind: "workspace", id: "o1" })).toBeNull();
    expect(readLaunchScopeAnchor({ v: 1, kind: "workspace", id: null })).toEqual({
      kind: "unanchored",
      reason: "malformed",
    });
  });

  it("still reads the payload the mint actually produces", () => {
    expect(parseLaunchScopeAnchor({ v: 1, kind: "workspace" })).toEqual({ v: 1, kind: "workspace" });
  });

  it("and the mint refuses a workspace input carrying a blank id", () => {
    expect(buildLaunchScopeAnchor({ kind: "workspace", id: "   " })).toBeNull();
    expect(buildLaunchScopeAnchor({ kind: "workspace", id: "" })).toBeNull();
    expect(buildLaunchScopeAnchor({ kind: "workspace" })).toEqual({ v: 1, kind: "workspace" });
  });
});
