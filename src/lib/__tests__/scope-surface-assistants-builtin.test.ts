/**
 * THE BUILT-IN ASSISTANT ON A SCOPE'S ASSISTANTS TAB (cinatra#2808, S2).
 *
 * The change item this covers: "Assistants tab: reuse the directory resolver
 * parameterized by the viewed scope (inject the predicate — never a value
 * import of `scope-filter`) and EXTEND the rows around the preserved Chat
 * button(s) with Settings (Skills-only page) and the installed-card fields."
 *
 * The built-in Cinatra assistant is NEVER an `installed_extension` row — the
 * registry reader unions its descriptor in unconditionally — so an installation
 * carrying no assistant PACKAGE still reaches one assistant. The per-scope read
 * must therefore consult the directory whether or not an installed assistant
 * package is eligible; the eligibility filter gates the installed packages only.
 *
 * Every heavy seam of the server read is INJECTED as a module mock here: this
 * tier has no permissions store and no database, and the case turns on one
 * axis only — an empty eligible set beside a directory that carries the
 * built-in row. The hrefs are asserted against #2809's OWN builders, never
 * against a literal retyped here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  resolveActorGrantsForUserInOrg: vi.fn(),
  readOrgsWithTeamsForUserActiveOnly: vi.fn(),
  readProjectsForUser: vi.fn(),
  readInstalledAgentTemplates: vi.fn(),
  listInstalledExtensions: vi.fn(),
  buildAssistantsDirectoryForCurrentActor: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  requireActorContext: mocks.requireActorContext,
  resolveActorGrantsForUserInOrg: mocks.resolveActorGrantsForUserInOrg,
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: mocks.readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser: mocks.readProjectsForUser,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: mocks.readInstalledAgentTemplates,
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: mocks.listInstalledExtensions,
}));
vi.mock("@/lib/assistants-directory.server", () => ({
  buildAssistantsDirectoryForCurrentActor: mocks.buildAssistantsDirectoryForCurrentActor,
}));

import { BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";
import { readScopeSurfaceAssistantRows } from "@/lib/scope-surface-eligibility.server";
import {
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

const WORKSPACE: ScopeSurfaceRef = { kind: "workspace" };

/** The built-in descriptor as the /assistants resolver returns it: no install
 *  row behind it, `isBuiltin` true, and the platform's own chat address. */
const BUILTIN_DIRECTORY_ROW = {
  packageName: BUILTIN_ASSISTANT_ALIAS.packageName,
  vendor: "cinatra-ai",
  slug: "cinatra-assistant",
  displayName: "Cinatra",
  handle: "cinatra",
  aliases: [] as string[],
  isBuiltin: true,
  remoteCapable: false,
  localChatHref: "/chat/cinatra-ai/cinatra-assistant",
  remoteInstances: [] as never[],
  // As production folds it: the built-in's audience is derived from
  // `isBuiltin` as a workspace-locus entry (assistants-directory.server.ts).
  scopeEntries: [{ locus: "workspace" }] as readonly { locus: string }[],
};

beforeEach(() => {
  mocks.getAuthSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-a" },
  });
  mocks.requireActorContext.mockResolvedValue({ userId: "user-1", organizationId: "org-a" });
  mocks.resolveActorGrantsForUserInOrg.mockResolvedValue({ teamIds: [], projectGrants: [] });
  mocks.readOrgsWithTeamsForUserActiveOnly.mockResolvedValue([{ id: "org-a", teams: [] }]);
  mocks.readProjectsForUser.mockResolvedValue([]);
  // ZERO installed assistant rows: no agent template, so no eligible install.
  mocks.readInstalledAgentTemplates.mockResolvedValue([]);
  mocks.listInstalledExtensions.mockResolvedValue([]);
  mocks.buildAssistantsDirectoryForCurrentActor.mockResolvedValue([BUILTIN_DIRECTORY_ROW]);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the Assistants tab with NO installed assistant package", () => {
  it("still consults the directory, with the viewed scope's own predicate", async () => {
    await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(mocks.buildAssistantsDirectoryForCurrentActor).toHaveBeenCalledTimes(1);
    // The workspace scope injects NO predicate (the broadest view); the
    // organization scope injects one, and it admits the built-in's own
    // workspace-locus audience entry.
    expect(mocks.buildAssistantsDirectoryForCurrentActor.mock.calls[0]![0]).toEqual({
      scopeMatch: undefined,
    });
    await readScopeSurfaceAssistantRows({ kind: "organization", id: "org-a" });
    const { scopeMatch } = mocks.buildAssistantsDirectoryForCurrentActor.mock.calls[1]![0] as {
      scopeMatch?: (entries: readonly { locus: string; locusId?: string }[]) => boolean;
    };
    expect(typeof scopeMatch).toBe("function");
    expect(scopeMatch!(BUILTIN_DIRECTORY_ROW.scopeEntries)).toBe(true);
  });

  it("carries the built-in assistant's row for the workspace scope", async () => {
    const rows = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.packageName).toBe(BUILTIN_ASSISTANT_ALIAS.packageName);
    expect(rows[0]!.displayName).toBe("Cinatra");
  });

  it("draws Chat and Settings at #2809's own scoped addresses", async () => {
    const [row] = await readScopeSurfaceAssistantRows(WORKSPACE);
    const assistant = { vendor: "cinatra-ai", slug: "cinatra-assistant" };
    expect(row!.chatHref).toBe(scopeSurfaceAssistantLaunchHref(WORKSPACE, assistant));
    expect(row!.settingsHref).toBe(scopeSurfaceAssistantSettingsHref(WORKSPACE, assistant));
  });

  it("draws the built-in assistant's OWN description, never an empty middle panel", async () => {
    // §III / §IV draw the description in the middle panel of the row. The
    // built-in has no `installed_extension` row to carry one, so the row reads
    // the descriptor's own description rather than rendering the panel empty.
    mocks.buildAssistantsDirectoryForCurrentActor.mockResolvedValue([
      { ...BUILTIN_DIRECTORY_ROW, description: "The assistant that ships with Cinatra." },
    ]);
    const [row] = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(row!.description).toBe("The assistant that ships with Cinatra.");
  });

  it("leaves the built-in row's description null when the descriptor carries none", async () => {
    const [row] = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(row!.description).toBeNull();
  });

  it("drops a NON-built-in directory row the scope has no eligible install for", async () => {
    mocks.buildAssistantsDirectoryForCurrentActor.mockResolvedValue([
      BUILTIN_DIRECTORY_ROW,
      {
        ...BUILTIN_DIRECTORY_ROW,
        packageName: "@acme/research",
        vendor: "acme",
        slug: "research",
        displayName: "Research Assistant",
        handle: "research",
        isBuiltin: false,
        localChatHref: "/chat/acme/research",
      },
    ]);
    const rows = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(rows.map((r) => r.packageName)).toEqual([BUILTIN_ASSISTANT_ALIAS.packageName]);
  });
});

/**
 * THE FENCE (convergence finding, adopted): an eligible set that is EMPTY
 * because nothing is installed is a real answer — the directory is consulted
 * for it, and the built-in row is drawn. A read that could not be TAKEN at all
 * is not an answer, and must draw nothing: dropping the old
 * `if (eligible.length === 0) return [];` would otherwise have turned a failed
 * membership read (or an unresolvable anchor) into a rendered tab, because the
 * eligibility reader swallows its own failure and returns an empty set.
 */
describe("the Assistants tab when the eligibility read could not be TAKEN", () => {
  it("renders NO rows, and never consults the directory, on a failed membership read", async () => {
    mocks.readOrgsWithTeamsForUserActiveOnly.mockRejectedValue(new Error("membership read down"));
    const rows = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(rows).toEqual([]);
    expect(mocks.buildAssistantsDirectoryForCurrentActor).not.toHaveBeenCalled();
  });

  it("renders NO rows when no anchor resolves (no session)", async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const rows = await readScopeSurfaceAssistantRows(WORKSPACE);
    expect(rows).toEqual([]);
    expect(mocks.buildAssistantsDirectoryForCurrentActor).not.toHaveBeenCalled();
  });
});
