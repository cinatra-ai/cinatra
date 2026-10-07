// The recommending connector's line on a REAL panel (cinatra#3408).
//
// The pure fold (`decideConnectionShareSurface`) and the section's wiring are
// each pinned elsewhere; the seam BETWEEN them was not. A connection panel
// reads its stored grant through the canonical
// `readExtensionAccessPolicy`, and the connect seed's `seededDefault` marker —
// the one thing that tells an UNTOUCHED seed from an explicit owner save —
// lives inside the stored policy jsonb. This file runs the REAL reader over a
// mocked postgres leaf and folds its result through the REAL model with the
// MCP Servers connector's own cached declaration (mode "default", scope
// "workspace"), so a marker lost anywhere on that road REDS here.
//
// §II of the ratified drawing: "Where the connector only recommends a scope,
// the line reads instead This connector recommends sharing with your
// organization — nothing is shared until you save. Currently: only you."
// A workspace grant on a connection of an organization reaches exactly that
// organization, so the MCP Servers connector's workspace recommendation reads
// that sentence word for word, as an organization recommendation does.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));

import { readExtensionAccessPolicy } from "@cinatra-ai/extensions/permissions-store";
import { decideConnectionShareSurface } from "@/lib/connection-share-ui";
import type { AvailableScopes } from "@/components/access-scope";

const ORG = "org-vantablack";
const CONNECTION_ID = "conn-quimbly-vetch";
const scopes: AvailableScopes = {
  orgs: [{ id: ORG, name: "Vantablack Holdings", teams: [] }],
  projects: [],
  canGrantWorkspace: true,
};
const identity = { organizationId: ORG };

/** The declaration the MCP Servers connector's own cinatra/config.json resolves to. */
function declaration(scope: "workspace" | "organization") {
  return { formatVersion: 1 as const, mode: "default", scope, source: "declared" as const } as never;
}

/** One stored `extension_access_policy` row, exactly as the column holds it. */
function storedRow(policy: Record<string, unknown>) {
  runPostgresQueriesSync.mockReturnValue([
    { rows: [{ resource_id: CONNECTION_ID, policy }] },
  ]);
}

/** What `registerSavedConnectionIdentity` seeds for a per-user connection. */
const CONNECT_SEED = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
  seededDefault: true,
};

/**
 * The recommendation line as section II of the connectors drawing gives it,
 * word for word. The dash is U+2014, written as an escape here.
 */
const RECOMMENDATION_LINE =
  "This connector recommends sharing with your organization \u2014 nothing is shared until you save. Currently: only you.";

/** What the first explicit Save changes writes (the marker is stripped by it). */
const SAVED_WORKSPACE = {
  runListVisibility: ["workspace"],
  runDataVisibility: ["workspace"],
  runExecuteVisibility: ["workspace"],
  allowRunSharing: false,
};

async function surfaceFor(scope: "workspace" | "organization") {
  const storedPolicy = await readExtensionAccessPolicy("connection", CONNECTION_ID);
  return decideConnectionShareSurface({
    identity,
    declaration: declaration(scope),
    storedPolicy,
    scopes,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The two module mocks above are FILE-scoped (vitest gives every test file its
// own module registry) and an unmock call here would be HOISTED above them,
// cancelling them for the whole file — so the restoration this file owes is the
// mock state and the module registry, reset after every test.
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the recommending connector's panel, read from the stored seed", () => {
  it("an UNTOUCHED seed yields the drawing's line word for word and the picker pre-selected to the recommended scope", async () => {
    storedRow(CONNECT_SEED);
    const s = await surfaceFor("workspace");
    expect(s.surface).toBe("editable");
    if (s.surface !== "editable") return;
    // The picker proposes the recommended scope; nothing is written until
    // Save, and the line says the stored grant is still only you (#3408).
    expect(s.value).toBe("workspace");
    expect(s.recommendationNote).toBe(RECOMMENDATION_LINE);
  });

  it("declares the same sentence for an organization recommendation, pre-selecting the owning organization", async () => {
    storedRow(CONNECT_SEED);
    const s = await surfaceFor("organization");
    expect(s.surface).toBe("editable");
    if (s.surface !== "editable") return;
    expect(s.value).toBe(`org:${ORG}`);
    expect(s.recommendationNote).toBe(RECOMMENDATION_LINE);
  });

  it("a SAVED grant draws the saved scope and no recommendation line", async () => {
    storedRow(SAVED_WORKSPACE);
    const s = await surfaceFor("workspace");
    expect(s.surface).toBe("editable");
    if (s.surface !== "editable") return;
    expect(s.value).toBe("workspace");
    expect(s.recommendationNote).toBeUndefined();
  });
});
