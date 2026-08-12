// /assistants directory builder (cinatra#1878 W3, AC#4/#5). The build logic runs
// for real; the registry read + instance authority are injected. Proves: exactly
// the actor's audience; remote rows expand per AUTHORIZED instance with both
// actions; remote links match the instance records.
import { describe, expect, it, vi } from "vitest";
import {
  assistantAudienceScopeEntries,
  buildAssistantsDirectory,
  resolveRemoteChatForBoundRoute,
  type AssistantsDirectoryDeps,
} from "../assistants-directory.server";
import type { AssistantRegistryEntry } from "../assistant-registry-reader";
import {
  isDefaultScopeSelection,
  scopeSelectionMatchesAny,
  type NormalizedResourceScope,
} from "../scope-filter";

function entry(over: Partial<AssistantRegistryEntry> & { packageName: string }): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: over.packageName,
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const CINATRA = entry({
  packageName: "@cinatra-ai/cinatra-assistant",
  displayName: "Cinatra",
  // Ruled shape (owner ruling 2026-07-23 (groganz)): the built-in's ONE tag is its
  // resolving handle `cinatra` (@cinatra), with no builtin alias.
  handle: "cinatra",
  aliases: [],
  isBuiltin: true,
});
const WORDPRESS = entry({
  packageName: "@cinatra-ai/wordpress-assistant",
  displayName: "WordPress",
  handle: "wordpress",
  launch: { kind: "remote", targetProvider: "wordpress" },
});

describe("buildAssistantsDirectory (AC#4)", () => {
  it("lists exactly the actor's audience, builtin first, with local chat hrefs", async () => {
    const deps: AssistantsDirectoryDeps = {
      readVisibleRegistry: async () => [WORDPRESS, CINATRA],
      listAuthorizedInstances: async () => [],
    };
    const rows = await buildAssistantsDirectory(deps);
    expect(rows.map((r) => r.packageName)).toEqual([
      "@cinatra-ai/cinatra-assistant", // builtin sorts first
      "@cinatra-ai/wordpress-assistant",
    ]);
    const cin = rows[0];
    expect(cin.localChatHref).toBe("/chat/cinatra-ai/cinatra-assistant");
    expect(cin.remoteCapable).toBe(false);
    expect(cin.remoteInstances).toEqual([]);
    expect(cin.handle).toBe("cinatra");
    expect(cin.aliases).toEqual([]);
  });

  it("expands a remote row per AUTHORIZED instance with both actions", async () => {
    const listAuthorizedInstances = vi.fn(async () => [
      { id: "wp-1", name: "Marketing Site", siteUrl: "https://mktg.example" },
      { id: "wp-2", name: "Docs", siteUrl: "https://docs.example/blog" },
    ]);
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [WORDPRESS],
      listAuthorizedInstances,
    });
    expect(listAuthorizedInstances).toHaveBeenCalledWith("wordpress");
    const wp = rows[0];
    expect(wp.remoteCapable).toBe(true);
    expect(wp.remoteInstances).toEqual([
      {
        instanceId: "wp-1",
        name: "Marketing Site",
        localChatHref: "/chat/cinatra-ai/wordpress-assistant/wp-1",
        remoteHref: "https://mktg.example/wp-admin/",
      },
      {
        instanceId: "wp-2",
        name: "Docs",
        localChatHref: "/chat/cinatra-ai/wordpress-assistant/wp-2",
        remoteHref: "https://docs.example/blog/wp-admin/",
      },
    ]);
  });

  it("drops an instance whose siteUrl is invalid (no broken remote link)", async () => {
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [WORDPRESS],
      listAuthorizedInstances: async () => [
        { id: "good", name: "Good", siteUrl: "https://ok.example" },
        { id: "bad", name: "Bad", siteUrl: "not-a-url" },
      ],
    });
    expect(rows[0].remoteInstances.map((i) => i.instanceId)).toEqual(["good"]);
  });

  it("a remote assistant with an unknown provider shows no instances", async () => {
    const listAuthorizedInstances = vi.fn(async () => [
      { id: "x", name: "X", siteUrl: "https://x.example" },
    ]);
    const broken = entry({
      packageName: "@cinatra-ai/mystery-assistant",
      launch: { kind: "remote", targetProvider: "unknown" },
    });
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [broken],
      listAuthorizedInstances,
    });
    expect(rows[0].remoteInstances).toEqual([]);
    expect(listAuthorizedInstances).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2688 — the `?scope=` half of the Connectors-style toolbar.
// ---------------------------------------------------------------------------

const ORG_ASSISTANT = entry({
  packageName: "@cinatra-ai/org-assistant",
  displayName: "Org Assistant",
  handle: "org",
  audience: [{ subjectKind: "organization", subjectId: "o1" }],
});
const TEAM_ASSISTANT = entry({
  packageName: "@cinatra-ai/team-assistant",
  displayName: "Team Assistant",
  handle: "team",
  audience: [{ subjectKind: "team", subjectId: "t1" }],
});
const PROJECT_ASSISTANT = entry({
  packageName: "@cinatra-ai/project-assistant",
  displayName: "Project Assistant",
  handle: "project",
  audience: [{ subjectKind: "project", subjectId: "p1" }],
});
const WORKSPACE_ASSISTANT = entry({
  packageName: "@cinatra-ai/workspace-assistant",
  displayName: "Workspace Assistant",
  handle: "workspace",
  audience: [{ subjectKind: "workspace", subjectId: null }],
});
const ADMIN_ASSISTANT = entry({
  packageName: "@cinatra-ai/admin-assistant",
  displayName: "Admin Assistant",
  handle: "admin",
  audience: [{ subjectKind: "admin", subjectId: null }],
});

const SCOPED_REGISTRY = [
  CINATRA,
  ORG_ASSISTANT,
  TEAM_ASSISTANT,
  PROJECT_ASSISTANT,
  WORKSPACE_ASSISTANT,
  ADMIN_ASSISTANT,
];

/**
 * Build the injected `?scope=` predicate the /assistants page builds, from the
 * REAL shared helpers — so these tests exercise the same OR-semantics the page
 * does, while the resolver itself stays free of a scope-filter value import.
 */
function scopeMatchFor(scopeTokens: string[]) {
  if (isDefaultScopeSelection(scopeTokens)) return undefined;
  return (scopeEntries: readonly NormalizedResourceScope[]) =>
    scopeEntries.some((entry) => scopeSelectionMatchesAny(scopeTokens, entry));
}

async function handlesForScope(scopeTokens?: string[]): Promise<string[]> {
  const rows = await buildAssistantsDirectory(
    { readVisibleRegistry: async () => SCOPED_REGISTRY, listAuthorizedInstances: async () => [] },
    scopeTokens ? { scopeMatch: scopeMatchFor(scopeTokens) } : {},
  );
  return rows.map((r) => r.handle).sort();
}

describe("assistantAudienceScopeEntries (cinatra#2688)", () => {
  it("maps each audience subject kind to the shared scope vocabulary", () => {
    expect(
      assistantAudienceScopeEntries({
        isBuiltin: false,
        audience: [
          { subjectKind: "workspace", subjectId: null },
          { subjectKind: "admin", subjectId: null },
          { subjectKind: "organization", subjectId: "o1" },
          { subjectKind: "team", subjectId: "t1" },
          { subjectKind: "project", subjectId: "p1" },
        ],
      }),
    ).toEqual([
      { locus: "workspace" },
      { locus: "workspace", adminOnly: true },
      { locus: "organization", locusId: "o1" },
      { locus: "team", locusId: "t1" },
      { locus: "project", locusId: "p1" },
    ]);
  });

  it("FAILS CLOSED on an unknown kind and on an id-less org/team/project grant", () => {
    expect(
      assistantAudienceScopeEntries({
        isBuiltin: false,
        audience: [
          { subjectKind: "wat", subjectId: "x" },
          { subjectKind: "organization", subjectId: null },
          { subjectKind: "team", subjectId: null },
          { subjectKind: "project", subjectId: null },
        ],
      }),
    ).toEqual([]);
  });

  it("normalizes the grant-less builtin to the workspace locus", () => {
    expect(assistantAudienceScopeEntries({ isBuiltin: true })).toEqual([{ locus: "workspace" }]);
    // A non-builtin with no grants folds to NOTHING — it can never over-match.
    expect(assistantAudienceScopeEntries({ isBuiltin: false })).toEqual([]);
  });
});

describe("buildAssistantsDirectory ?scope= filter (cinatra#2688)", () => {
  it("shows every audience-admitted row when no selection is passed", async () => {
    expect(await handlesForScope()).toEqual([
      "admin",
      "cinatra",
      "org",
      "project",
      "team",
      "workspace",
    ]);
  });

  it("the default selection short-circuits — it narrows nothing", async () => {
    expect(await handlesForScope(["workspace"])).toEqual(await handlesForScope());
  });

  it("an org selection matches ONLY that org's grants", async () => {
    expect(await handlesForScope(["org:o1"])).toEqual(["org"]);
    expect(await handlesForScope(["org:o2"])).toEqual([]);
  });

  it("team and project selections match their own concrete locus only", async () => {
    expect(await handlesForScope(["team:t1"])).toEqual(["team"]);
    expect(await handlesForScope(["project:p1"])).toEqual(["project"]);
  });

  it("OR-unions a multi-token selection", async () => {
    expect(await handlesForScope(["team:t1", "project:p1"])).toEqual(["project", "team"]);
  });

  it("the admin token is a visibility TIER, not 'everything non-personal'", async () => {
    expect(await handlesForScope(["admin"])).toEqual(["admin"]);
  });

  it("no assistant matches `personal` — assistant_audience has no per-user subject kind", async () => {
    expect(await handlesForScope(["personal"])).toEqual([]);
  });

  it("carries the fold onto each row so the filter and the row agree", async () => {
    const rows = await buildAssistantsDirectory({
      readVisibleRegistry: async () => [TEAM_ASSISTANT],
      listAuthorizedInstances: async () => [],
    });
    expect(rows[0].scopeEntries).toEqual([{ locus: "team", locusId: "t1" }]);
  });

  it("an excluded row never costs an instance-authority round trip", async () => {
    // The scope check runs BEFORE listAuthorizedInstances, so filtering out a
    // remote-capable assistant does no per-row authorization work.
    const listAuthorizedInstances = vi.fn(async () => []);
    const remoteOutOfScope = entry({
      packageName: "@cinatra-ai/wordpress-assistant",
      handle: "wordpress",
      launch: { kind: "remote", targetProvider: "wordpress" },
      audience: [{ subjectKind: "team", subjectId: "t9" }],
    });
    const rows = await buildAssistantsDirectory(
      {
        readVisibleRegistry: async () => [remoteOutOfScope],
        listAuthorizedInstances,
      },
      { scopeMatch: scopeMatchFor(["team:t1"]) },
    );
    expect(rows).toEqual([]);
    expect(listAuthorizedInstances).not.toHaveBeenCalled();
  });
});

describe("resolveRemoteChatForBoundRoute (AC#5)", () => {
  it("resolves the flyout href for an authorized instance", async () => {
    const deps: AssistantsDirectoryDeps = {
      readVisibleRegistry: async () => [],
      listAuthorizedInstances: async () => [
        { id: "wp-1", name: "Site", siteUrl: "https://site.example" },
      ],
    };
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: "wordpress", instanceId: "wp-1" },
      deps,
    );
    expect(out).toEqual({ href: "https://site.example/wp-admin/" });
  });

  it("returns null for an instance the actor is not authorized for", async () => {
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: "wordpress", instanceId: "wp-9" },
      { readVisibleRegistry: async () => [], listAuthorizedInstances: async () => [] },
    );
    expect(out).toBeNull();
  });

  it("returns null for a non-remote / unknown provider", async () => {
    const out = await resolveRemoteChatForBoundRoute(
      { targetProvider: null, instanceId: "x" },
      { readVisibleRegistry: async () => [], listAuthorizedInstances: async () => [] },
    );
    expect(out).toBeNull();
  });
});
