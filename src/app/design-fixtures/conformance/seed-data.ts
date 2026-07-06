// ---------------------------------------------------------------------------
// Deterministic SEEDED fixture kit for the design-conformance data-contract
// suite (cinatra#986). Imported by:
//
//   - the seeded harness route (src/app/design-fixtures/conformance/seeded/*),
//   - the seed provisioning route handler (../seed/route.ts), and
//   - the Playwright suite (tests/e2e/design/conformance/*), by relative path
//     outside the Next.js toolchain — so this file stays DEPENDENCY-FREE
//     (no "@/" or workspace imports), like fixture-data.ts (cinatra#985).
//
// Design rules the kit enforces (cinatra#986 acceptance criteria):
//
//   ANTI-LOOKALIKE SEEDS — competing sources always get DISTINCT values: every
//   displayName shares NO token with its packageName/slug, so a surface bound
//   to the wrong source (e.g. rendering the package slug where the manifest
//   binds displayName) is a RED, never a lookalike pass.
//
//   EXACT CARDINALITY — every cardinality-bearing surface has its own count
//   constant, and counts of collections that could be cross-wired are
//   pairwise DISTINCT (grid 7 ≠ installed-active 4 ≠ installed-archived 2 ≠
//   connectors-connected 3 ≠ connectors-disconnected 5), so a driver counting
//   the wrong collection cannot accidentally pass.
//
//   PER-RUN ISOLATION — DB-backed seeds are namespaced by a run id
//   (CINATRA_CONFORMANCE_RUN_ID; "local" fallback). Provisioning converges the
//   namespace to EXACTLY this kit (extra rows in the namespace are removed),
//   so retries and re-runs cannot cross-contaminate exact-count assertions,
//   and distinct runs never share rows.
// ---------------------------------------------------------------------------

/** Allowed run-id shape (also enforced server-side by the seed route). */
export const CONFORMANCE_RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function conformanceRunId(): string {
  const raw = (process.env.CINATRA_CONFORMANCE_RUN_ID ?? "local").toLowerCase();
  return CONFORMANCE_RUN_ID_RE.test(raw) ? raw : "local";
}

/** npm scope every DB-seeded fixture row lives under, namespaced per run. */
export function seededPackagePrefix(runId: string): string {
  return `@cinatra-e2e/${runId}--`;
}

export function seededPackageName(runId: string, base: string): string {
  return `${seededPackagePrefix(runId)}${base}`;
}

/** Deterministic canonical-row id for a seeded installed_extension row. */
export function seededRowId(runId: string, base: string): string {
  return `design-conformance--${runId}--${base}`;
}

// ---------------------------------------------------------------------------
// installed-extensions-list / installed-extensions-filter (DB-backed)
//
// These rows are provisioned into the REAL canonical `installed_extension`
// store (through the real lifecycle primitive) by the seed route, and read
// back through the REAL `listInstalledExtensions()` store read on the seeded
// harness route. displayName/description are DISPLAY hydration owned by this
// kit (per-kind native descriptor sources are build-time catalogs/registries,
// not seedable data); the DATA-bearing bindings — kind, lifecycle status,
// version, cardinality — come from the live DB rows.
// ---------------------------------------------------------------------------

export type SeededInstalledExtension = {
  /** Package basename inside the run namespace (see seededPackageName). */
  base: string;
  kind: "agent" | "skill" | "workflow" | "connector" | "artifact";
  kindLabel: string;
  status: "active" | "archived";
  version: string;
  /** Anti-lookalike: shares no token with `base`. */
  displayName: string;
  description: string;
  vendor: string;
};

export const SEEDED_INSTALLED_EXTENSIONS: SeededInstalledExtension[] = [
  {
    base: "quarterly-brief",
    kind: "agent",
    kindLabel: "Agent",
    status: "active",
    version: "1.2.0",
    displayName: "Horizon Research Copilot",
    description: "Plans retrievals and drafts cited answers from team sources.",
    vendor: "Cinatra Fixtures",
  },
  {
    base: "minutes-digest",
    kind: "skill",
    kindLabel: "Skill",
    status: "active",
    version: "2.0.1",
    displayName: "Standup Note Condenser",
    description: "Turns raw meeting transcripts into action items.",
    vendor: "Cinatra Fixtures",
  },
  {
    base: "release-cadence",
    kind: "workflow",
    kindLabel: "Workflow",
    status: "active",
    version: "0.9.4",
    displayName: "Shipday Orchestrator",
    description: "Schedules and runs the recurring release checklist.",
    vendor: "Cinatra Fixtures",
  },
  {
    base: "asset-vault",
    kind: "artifact",
    kindLabel: "Artifact",
    status: "active",
    version: "3.1.0",
    displayName: "Campaign Media Locker",
    description: "Curated brand asset bundle for campaign runs.",
    vendor: "Cinatra Fixtures",
  },
  {
    base: "ledger-link",
    kind: "connector",
    kindLabel: "Connector",
    status: "archived",
    version: "1.0.7",
    displayName: "Bookkeeping Bridge",
    description: "Streams accounting events into the workspace.",
    vendor: "Cinatra Fixtures",
  },
  {
    base: "inbox-triage",
    kind: "agent",
    kindLabel: "Agent",
    status: "archived",
    version: "0.4.2",
    displayName: "Mail Sorting Copilot",
    description: "Classifies and routes shared-inbox conversations.",
    vendor: "Cinatra Fixtures",
  },
];

export const SEEDED_INSTALLED_ACTIVE_COUNT = SEEDED_INSTALLED_EXTENSIONS.filter(
  (r) => r.status === "active",
).length; // 4
export const SEEDED_INSTALLED_ARCHIVED_COUNT = SEEDED_INSTALLED_EXTENSIONS.filter(
  (r) => r.status === "archived",
).length; // 2

/** Registry/source provenance constants for the seeded verdaccio rows. */
export const SEEDED_SOURCE_REGISTRY_URL = "https://design-conformance.invalid/registry";
export const SEEDED_SOURCE_INTEGRITY = "sha512-design-conformance-fixture-not-a-real-tarball";

// ---------------------------------------------------------------------------
// extension-listing-grid (static seeds — the storefront catalog is an HTTP
// source, not a DB; the grid mount receives these as the server-composed
// card nodes exactly like the real screen composes them)
// ---------------------------------------------------------------------------

export type SeededGridCard = {
  packageName: string;
  packageVersion: string;
  /** Anti-lookalike: shares no token with packageName. */
  displayName: string;
  description: string;
  kindSlug: "agent" | "skill" | "workflow" | "connector" | "artifact";
  kindLabel: string;
};

export const SEEDED_GRID_CARDS: SeededGridCard[] = [
  { packageName: "@cinatra-fixtures/field-notes", packageVersion: "1.0.0", displayName: "Survey Companion", description: "Collects structured observations on the go.", kindSlug: "agent", kindLabel: "Agent" },
  { packageName: "@cinatra-fixtures/page-turner", packageVersion: "2.3.0", displayName: "Longform Skimmer", description: "Summarizes book-length PDFs chapter by chapter.", kindSlug: "skill", kindLabel: "Skill" },
  { packageName: "@cinatra-fixtures/drip-feed", packageVersion: "0.8.0", displayName: "Nurture Sequencer", description: "Schedules multi-step outreach cadences.", kindSlug: "workflow", kindLabel: "Workflow" },
  { packageName: "@cinatra-fixtures/wire-tap", packageVersion: "1.1.2", displayName: "Event Stream Bridge", description: "Subscribes the workspace to external event feeds.", kindSlug: "connector", kindLabel: "Connector" },
  { packageName: "@cinatra-fixtures/style-pack", packageVersion: "4.0.0", displayName: "Voice Guide Bundle", description: "House tone-of-voice templates and examples.", kindSlug: "artifact", kindLabel: "Artifact" },
  { packageName: "@cinatra-fixtures/quote-mill", packageVersion: "1.5.0", displayName: "Proposal Drafter", description: "Assembles priced proposals from catalog items.", kindSlug: "agent", kindLabel: "Agent" },
  { packageName: "@cinatra-fixtures/lens-cap", packageVersion: "0.2.1", displayName: "Screenshot Annotator", description: "Marks up captures with callouts and blur.", kindSlug: "skill", kindLabel: "Skill" },
];

export const SEEDED_GRID_CARD_COUNT = SEEDED_GRID_CARDS.length; // 7

// ---------------------------------------------------------------------------
// connector-grid / connector-connection-filter (static seeds — the /connectors
// card model is built server-side from the connector catalog + readiness
// probes; the seeded harness runs the REAL fail-soft readiness resolution over
// these, then mounts the REAL ConnectorsClient)
// ---------------------------------------------------------------------------

export type SeededConnectorCard = {
  slug: string;
  /**
   * connector.displayName — the manifest source of truth the card `name`
   * binds to. Anti-lookalike: shares no token with `slug`.
   */
  displayName: string;
  connected: boolean;
  connectedLabel?: string;
  /**
   * When true, the harness resolves this card's readiness through the REAL
   * `resolveReadinessFailSoft` with a probe that THROWS — the surface's
   * documented error treatment (cinatra#110): the failing card degrades to
   * "not connected", never a 500. The suite asserts this as the
   * connector-grid `error` state variant.
   */
  probeThrows?: boolean;
};

export const SEEDED_CONNECTOR_CARDS: SeededConnectorCard[] = [
  { slug: "fixture-ticket-desk", displayName: "Support Queue Link", connected: true, connectedLabel: "2 connections" },
  { slug: "fixture-mail-relay", displayName: "Outbound Post Bridge", connected: true },
  { slug: "fixture-calendar-sync", displayName: "Agenda Mirror", connected: true },
  { slug: "fixture-crm-pipe", displayName: "Deal Ledger Feed", connected: false },
  { slug: "fixture-chat-hub", displayName: "Team Room Gateway", connected: false },
  { slug: "fixture-doc-store", displayName: "Archive Shelf Access", connected: false },
  { slug: "fixture-data-well", displayName: "Metrics Basin Tap", connected: false },
  // The forced-error card: its readiness probe THROWS; the REAL fail-soft
  // containment renders it disconnected.
  { slug: "fixture-broken-probe", displayName: "Faulty Sensor Uplink", connected: false, probeThrows: true },
];

export const SEEDED_CONNECTOR_CONNECTED_COUNT = SEEDED_CONNECTOR_CARDS.filter(
  (c) => c.connected,
).length; // 3
export const SEEDED_CONNECTOR_DISCONNECTED_COUNT = SEEDED_CONNECTOR_CARDS.filter(
  (c) => !c.connected,
).length; // 5
/** Slug of the forced-probe-failure card (connector-grid `error` variant). */
export const SEEDED_CONNECTOR_ERROR_SLUG = "fixture-broken-probe";

// ---------------------------------------------------------------------------
// extension-detail-modal (static seed — the §V modal fetches its detail via an
// injected loader on the fixture routes; the conformance instance re-derives
// its footer CTA through the REAL resolveMarketplaceCardCta after the harness
// install action mutates the installed-state input)
// ---------------------------------------------------------------------------

export const SEEDED_MODAL_FIXTURE = {
  packageName: "@cinatra-fixtures/wire-hub",
  packageVersion: "2.4.0",
  /** Anti-lookalike: shares no token with packageName. */
  displayName: "Signal Relay Agent",
  description: "Routes structured signals between workspace agents.",
  kindSlug: "agent" as const,
  kindLabel: "Agent",
  vendorName: "Cinatra Fixtures",
} as const;
