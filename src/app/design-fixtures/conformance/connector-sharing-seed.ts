// ---------------------------------------------------------------------------
// Deterministic seed kit for the three §II SHARING-tab conformance surfaces
// (cinatra#3374): connector-sharing, connector-sharing-rollup,
// connector-sharing-locked.
//
// Imported by BOTH the harness fixture (connector-sharing-fixture.tsx) and the
// Playwright drivers (tests/e2e/design/conformance/contract.ts), so a field
// assertion compares against the SAME value the harness rendered.
//
// Intentionally dependency-free (no "@/" or workspace imports): the Playwright
// suite imports this file by relative path, outside the Next.js toolchain —
// same contract as connector-setup-seed.ts.
//
// ANTI-LOOKALIKE: the connection's name, its mono line, every person's name and
// address, and the org/team names share no substring with one another, so a
// driver that reads the wrong binding REDS instead of passing on a lookalike.
// ---------------------------------------------------------------------------

/** The owned connection each panel is about (manifest fields `name` / `url`). */
export const CONNECTOR_SHARING_CONNECTION = {
  /** `name` = connection.connectionId */
  name: "quimbly-vetch-0417",
  /** `url` = connection.connectorKey */
  url: "brindlewick",
} as const;

/** The person who connected it — the row that carries a lock, never a remove. */
export const CONNECTOR_SHARING_OWNER = {
  userId: "owner-user-fixture",
  name: "Marlow Kestrel",
  email: "marlow@zephyr.example",
} as const;

/** A co-owner already on the connection — the `remove-co-owner` subject. */
export const CONNECTOR_SHARING_CO_OWNER = {
  userId: "co-owner-user-fixture",
  name: "Dunya Halvorsen",
  email: "dunya@pellucid.example",
} as const;

/** The only person the `search-people` road returns for the query below. */
export const CONNECTOR_SHARING_CANDIDATE = {
  userId: "candidate-user-fixture",
  name: "Ptolemy Ashgrove",
  email: "ptolemy@quillfen.example",
} as const;

/** The query the search-people driver types (a prefix of the candidate's name). */
export const CONNECTOR_SHARING_SEARCH_QUERY = "Ptol";

/** The org (and its team) the picker offers as broad scopes. */
export const CONNECTOR_SHARING_ORG = {
  id: "org-fixture-vantablack",
  name: "Vantablack Holdings",
  team: { id: "team-fixture-solstice", name: "Solstice Crew" },
} as const;

/** How many connections the roll-up counts — the list beneath it has exactly this many. */
export const CONNECTOR_SHARING_PANEL_COUNT = 2;

/**
 * The UNCONSTRAINED panel's stored scope, and the scope the `select-scope`
 * driver moves it to. Both are picker option values
 * (`AgentAuthPolicyVisibility`).
 *
 * ANTI-MASK (cinatra#3374): this value is NOT the picker's default and NOT the
 * value any fixture override supplies, and it is NOT the value the other two
 * visibility fields of the seeded policy carry. A panel that ignored
 * `policy.runListVisibility` — falling back to the owner floor, or echoing an
 * override, or reading a neighbouring visibility field — therefore REDS on the
 * `access` field assertion instead of passing on a lookalike.
 */
export const CONNECTOR_SHARING_INITIAL_SCOPE = "project:project-fixture-ninebark";
export const CONNECTOR_SHARING_SELECTED_SCOPE = "workspace";

/**
 * The owner floor: the value the OTHER two visibility fields of the seeded
 * policy carry, and the scope the RECOMMENDING panel opens on (its sentence
 * reads "Currently: only you", so that panel states it as an override — which
 * is itself distinct from the stored `runListVisibility` above).
 */
export const CONNECTOR_SHARING_OWNER_SCOPE = "owner";

/**
 * The CEILING panel (surface `connector-sharing-locked`). The sentence is the
 * product's own — `decideConnectionShareSurface` composes exactly this string
 * for `only:"admin"`, and its 13 unit tests in
 * src/lib/__tests__/connection-share-ui.test.ts pin that composition; the
 * harness seeds the RESULT so the driver reads the drawn presentation.
 */
export const CONNECTOR_SHARING_LOCK_NOTE =
  'Locked by this connector: access is limited to workspace admins (only:"admin").';
/** Every option ABOVE that ceiling — drawn locked, each carrying the sentence. */
export const CONNECTOR_SHARING_LOCKED_SCOPES = [
  `project:project-fixture-ninebark`,
  `team:${CONNECTOR_SHARING_ORG.team.id}`,
  `org:${CONNECTOR_SHARING_ORG.id}`,
  "workspace",
] as const;
/** The value the locked picker opens on (the canonical only-value). */
export const CONNECTOR_SHARING_LOCKED_VALUE = "admin";

/** The project the picker offers (kept in step with the locked-scope list). */
export const CONNECTOR_SHARING_PROJECT = {
  id: "project-fixture-ninebark",
  name: "Ninebark Rollout",
} as const;

/** The RECOMMENDING connector's line — nothing is shared until Save is pressed. */
export const CONNECTOR_SHARING_RECOMMENDATION_NOTE =
  "This connector recommends sharing with your organization — nothing is shared until you save. Currently: only you.";

/** The helper lines the connection mount overrides (§II, verbatim). */
export const CONNECTOR_SHARING_ACCESS_HELPER =
  "Choose who can use this connection.";
export const CONNECTOR_SHARING_OWNERSHIP_HELPER =
  "Owners can change this connection's sharing and disconnect it.";

/**
 * The picker's own `Type: Name` labels for the three seeded scope values
 * (src/components/access-scope.ts `resolveAccessParts`). The trigger renders the
 * type and the name as two sibling elements, so their text carries no
 * separating space — the drivers match with the suite's own pair pattern.
 */
export const CONNECTOR_SHARING_INITIAL_SCOPE_LABEL = "Project: Ninebark Rollout";
export const CONNECTOR_SHARING_OWNER_SCOPE_LABEL = "Personal: Only me";
export const CONNECTOR_SHARING_SELECTED_SCOPE_LABEL = "Workspace: All";
export const CONNECTOR_SHARING_LOCKED_VALUE_LABEL = "Workspace: Admins only";
