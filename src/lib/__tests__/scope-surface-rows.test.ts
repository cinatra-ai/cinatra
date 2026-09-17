/**
 * THE SCOPE-TAB CARD ROWS (cinatra#2808, per-scope surfaces S2).
 *
 * The acceptance: "every row's Run/Chat control carries its row-specific launch
 * href … Every Settings control carries the exact scope- and package-specific
 * href produced by #2809's contract". The hrefs are therefore asserted against
 * #2809's OWN builders, never against a literal retyped here — a literal would
 * pass even if the two slices had drifted apart.
 */
import { describe, expect, it } from "vitest";

import {
  buildScopeSurfaceAgentRows,
  buildScopeSurfaceAssistantRows,
  formatScopeSurfaceVersion,
} from "@/lib/scope-surface-rows";
import type { ScopeSurfaceEligibilityRow } from "@/lib/scope-surface-eligibility";
import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

const eligible = (over: Partial<ScopeSurfaceEligibilityRow> = {}): ScopeSurfaceEligibilityRow => ({
  packageName: "@acme/research",
  displayName: "Research Assistant",
  description: "Gathers sources.",
  version: "0.4.2",
  status: "active",
  installId: "install-1",
  executionOrgIds: ["org-a"],
  ...over,
});

const SCOPES: ScopeSurfaceRef[] = [
  { kind: "workspace" },
  { kind: "personal" },
  { kind: "organization", id: "org-a" },
  { kind: "team", id: "team-1" },
  { kind: "project", id: "proj-1" },
];

describe("the Agents tab's rows", () => {
  it.each(SCOPES)("carries #2809's scoped Run and Settings hrefs on %o", (scope) => {
    const [row] = buildScopeSurfaceAgentRows(scope, [eligible()]);
    expect(row!.runHref).toBe(scopeSurfaceAgentLaunchHref(scope, "@acme/research"));
    expect(row!.settingsHref).toBe(scopeSurfaceAgentSettingsHref(scope, "@acme/research"));
  });

  it("gives each row its OWN launch and settings href — never one shared address", () => {
    const rows = buildScopeSurfaceAgentRows({ kind: "team", id: "team-1" }, [
      eligible({ packageName: "@acme/research" }),
      eligible({ packageName: "@acme/transcript", displayName: "Media Transcript Agent" }),
    ]);
    expect(rows[0]!.runHref).not.toBe(rows[1]!.runHref);
    expect(rows[0]!.settingsHref).not.toBe(rows[1]!.settingsHref);
    expect(rows[1]!.runHref).toContain("transcript");
  });

  it("carries the version and the status each row actually has", () => {
    const rows = buildScopeSurfaceAgentRows({ kind: "workspace" }, [
      eligible({ packageName: "@acme/research", version: "0.4.2", status: "active" }),
      eligible({ packageName: "@acme/transcript", version: "1.9.0", status: "locked" }),
    ]);
    expect(rows[0]!.version).toBe("v0.4.2");
    expect(rows[0]!.status).toBe("active");
    expect(rows[1]!.version).toBe("v1.9.0");
    expect(rows[1]!.status).toBe("locked");
  });

  it("mints NO /configuration href — the scope tabs are member-facing", () => {
    const rows = buildScopeSurfaceAgentRows({ kind: "organization", id: "org-a" }, [eligible()]);
    expect(rows[0]!.detailHref).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("/configuration");
  });
});

describe("the Assistants tab's rows", () => {
  const directory = [
    {
      packageName: "@acme/research",
      vendor: "acme",
      slug: "research",
      displayName: "Research Assistant",
      remoteCapable: false,
      remoteInstances: [],
    },
  ];

  it.each(SCOPES)("carries #2809's scoped Chat and Settings hrefs on %o", (scope) => {
    const [row] = buildScopeSurfaceAssistantRows(scope, directory, [eligible()]);
    expect(row!.chatHref).toBe(
      scopeSurfaceAssistantLaunchHref(scope, { vendor: "acme", slug: "research" }),
    );
    expect(row!.settingsHref).toBe(
      scopeSurfaceAssistantSettingsHref(scope, { vendor: "acme", slug: "research" }),
    );
  });

  it("PRESERVES the Chat control(s): a remote-capable row keeps one pair per connected site", () => {
    const scope: ScopeSurfaceRef = { kind: "team", id: "team-1" };
    const [row] = buildScopeSurfaceAssistantRows(
      scope,
      [
        {
          ...directory[0]!,
          remoteCapable: true,
          remoteInstances: [
            { instanceId: "site-1", name: "Marketing site", remoteHref: "https://site.example/wp" },
          ],
        },
      ],
      [eligible()],
    );
    expect(row!.remoteInstances).toHaveLength(1);
    // The in-app half is re-scoped …
    expect(row!.remoteInstances[0]!.localChatHref).toBe(
      scopeSurfaceAssistantLaunchHref(scope, {
        vendor: "acme",
        slug: "research",
        instance: "site-1",
      }),
    );
    // … and the jump-out addresses the site itself, which no scope owns.
    expect(row!.remoteInstances[0]!.remoteHref).toBe("https://site.example/wp");
  });

  it("carries the installed-card fields from the eligible install", () => {
    const [row] = buildScopeSurfaceAssistantRows({ kind: "workspace" }, directory, [
      eligible({ version: "2.1.0", status: "locked", description: "Cited answers." }),
    ]);
    expect(row!.version).toBe("v2.1.0");
    expect(row!.status).toBe("locked");
    expect(row!.description).toBe("Cited answers.");
  });

  it("drops a directory row this scope has no eligible install for", () => {
    const rows = buildScopeSurfaceAssistantRows({ kind: "project", id: "proj-1" }, directory, []);
    expect(rows).toEqual([]);
  });

  /** The BUILT-IN platform assistant is never an `installed_extension` row — the
   *  registry reader unions its descriptor in unconditionally — so the
   *  eligibility filter gates the INSTALLED assistant packages only, and the
   *  built-in row is folded in with no install behind it. */
  const builtin = {
    packageName: "@cinatra-ai/cinatra-assistant",
    vendor: "cinatra-ai",
    slug: "cinatra-assistant",
    displayName: "Cinatra",
    isBuiltin: true,
    remoteCapable: false,
    remoteInstances: [],
  };

  it.each(SCOPES)("folds the BUILT-IN assistant in with NO eligible install on %o", (scope) => {
    const assistant = { vendor: "cinatra-ai", slug: "cinatra-assistant" };
    const [row] = buildScopeSurfaceAssistantRows(scope, [builtin], []);
    expect(row!.packageName).toBe("@cinatra-ai/cinatra-assistant");
    expect(row!.displayName).toBe("Cinatra");
    expect(row!.chatHref).toBe(scopeSurfaceAssistantLaunchHref(scope, assistant));
    expect(row!.settingsHref).toBe(scopeSurfaceAssistantSettingsHref(scope, assistant));
  });

  it("gives the built-in row the live installed-card fields it has no install for", () => {
    const [row] = buildScopeSurfaceAssistantRows({ kind: "workspace" }, [builtin], []);
    expect(row!.version).toBeNull();
    expect(row!.description).toBeNull();
    expect(row!.status).toBe("active");
  });
});

describe("the version formatting", () => {
  it("prefixes a bare version and leaves an already-prefixed one alone", () => {
    expect(formatScopeSurfaceVersion("0.4.2")).toBe("v0.4.2");
    expect(formatScopeSurfaceVersion("v0.4.2")).toBe("v0.4.2");
  });
  it("renders nothing at all for a missing version", () => {
    expect(formatScopeSurfaceVersion(null)).toBeNull();
    expect(formatScopeSurfaceVersion("  ")).toBeNull();
  });
});
