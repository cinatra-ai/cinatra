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
//   pairwise DISTINCT (grid 6 ≠ installed-active 4 ≠ installed-archived 2 ≠
//   installed-locked 1 ≠ installed-all 7 ≠ connectors-connected 3 ≠
//   connectors-disconnected 5), so a driver counting the wrong collection
//   cannot accidentally pass. (grid dropped 7→6 and the installed-active
//   workflow row became a connector when the 'workflow' kind was removed —
//   cinatra#1035; the status filter added the Locked view + one locked row —
//   cinatra#1571 — all preserving the distinctness.)
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
  // 'workflow' dropped — Slice C+D removed it as an extension kind and the
  // narrowed installed_extension_kind_chk rejects it, so no workflow row can
  // be seeded into the canonical store (cinatra#1035).
  kind: "agent" | "skill" | "connector" | "artifact";
  kindLabel: string;
  // 'locked' added with the status filter's Locked view (cinatra#1571): a
  // required/system extension the status partition now surfaces on its own.
  status: "active" | "locked" | "archived";
  version: string;
  /** Anti-lookalike: shares no token with `base`. */
  displayName: string;
  description: string;
  vendor: string;
  /**
   * The verdaccio source registryUrl this row installs under (cinatra#1572).
   * Optional — defaults to SEEDED_SOURCE_REGISTRY_URL. Distinct URLs let the
   * seeded §VI harness prove the source-indicator CRUX — a marketplace-identity
   * row and an instance-identity row (plus a matches-neither `unknown` row)
   * rendered TOGETHER — without changing any cardinality constant.
   */
  registryUrl?: string;
};

// Distinct, fake (`.invalid`) registry identities assigned to two seeded rows so
// the seeded §VI harness can later prove the source-indicator crux — a
// marketplace-identity row and an instance-identity row (plus matches-neither
// `unknown` rows) — WITHOUT changing any cardinality constant (cinatra#1572 AC8
// data prerequisite). Declared BEFORE the seed array (module temporal-dead-zone).
// `.invalid` hosts guarantee no real private hostname ever appears. The
// seeded-fixture RENDER of the indicator + its pixel baseline ride the paired
// design-surface follow-up (sequenced behind the spec update), so only the DATA
// lands here.
const SEEDED_MARKETPLACE_REGISTRY_URL = "https://design-marketplace.invalid/registry";
const SEEDED_INSTANCE_REGISTRY_URL = "https://design-instance.invalid/registry";

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
    // Marketplace-identity registry → "from marketplace".
    registryUrl: SEEDED_MARKETPLACE_REGISTRY_URL,
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
    // Instance local-registry identity → "from your instance". Paired with the
    // marketplace row above, this is the crux the render fence proves.
    registryUrl: SEEDED_INSTANCE_REGISTRY_URL,
  },
  {
    // Replaces the removed 'workflow' active row (cinatra#1035): keeps the
    // active count at 4 (pairwise-distinct invariant) and, being a connector,
    // this row plus the archived 'ledger-link' connector below prove the
    // status filter partitions by lifecycle status, not by kind. Org-anchored
    // like every connector (see seededOrgAnchorId / the org-anchor invariant).
    base: "signal-relay",
    kind: "connector",
    kindLabel: "Connector",
    status: "active",
    version: "2.4.0",
    displayName: "Webhook Fan-Out Hub",
    description: "Broadcasts inbound events to subscribed destinations.",
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
    // The ONLY locked row: proves the Locked view (cinatra#1571) surfaces
    // status === 'locked' rows on their own AND that they also appear under All
    // — a status the previous binary Active/Archived filter could never isolate.
    // An agent (platform-anchored, so no org-anchor invariant), locked by the
    // seed route through the REAL `lock` lifecycle transition. Keeps the counts
    // pairwise-distinct: active 4, locked 1, archived 2, all 7.
    base: "sentinel-guard",
    kind: "agent",
    kindLabel: "Agent",
    status: "locked",
    version: "1.0.0",
    displayName: "Perimeter Watchtower",
    description: "Required policy agent that cannot be archived while in force.",
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
).length; // 4 (workflow active row → active connector — cinatra#1035; stays 4 to
// keep the pairwise-distinct cardinality invariant, see the header note)
export const SEEDED_INSTALLED_LOCKED_COUNT = SEEDED_INSTALLED_EXTENSIONS.filter(
  (r) => r.status === "locked",
).length; // 1 (the Locked view, cinatra#1571 — distinct from every other count)
export const SEEDED_INSTALLED_ARCHIVED_COUNT = SEEDED_INSTALLED_EXTENSIONS.filter(
  (r) => r.status === "archived",
).length; // 2
/** Every installed row regardless of status — the "All" view (cinatra#1571). */
export const SEEDED_INSTALLED_ALL_COUNT = SEEDED_INSTALLED_EXTENSIONS.length; // 7

/** Registry/source provenance constants for the seeded verdaccio rows. */
export const SEEDED_SOURCE_REGISTRY_URL = "https://design-conformance.invalid/registry";
export const SEEDED_SOURCE_INTEGRITY = "sha512-design-conformance-fixture-not-a-real-tarball";

// ---------------------------------------------------------------------------
// extension-listing-grid (static seeds — the storefront catalog is an HTTP
// source, not a DB; the grid mount receives these as the server-composed
// card nodes exactly like the real screen composes them)
// ---------------------------------------------------------------------------

/** The six-state CTA identities the marketplace card supports (cinatra#985). */
export type SeededGridCtaState =
  | "install"
  | "installed"
  | "update"
  | "restore"
  | "installing"
  | "incompatible";

/**
 * Sanitized inline logo data URIs for the seeded grid's declared-logo cards
 * (cinatra#2469).
 *
 * PROVENANCE — these are not hand-written strings: each is the EXACT output of
 * the repository's own manifest-generator sanitizer
 * (`sanitizeSvgToDataUri`, scripts/extensions/generate-extension-manifest.mjs)
 * over the committed source glyph in ./logos/<kind>-glyph.svg — the same
 * function that produces `STATIC_EXTENSION_MANIFEST[pkg].logo` for a package
 * that declares `cinatra.logo`. ../__tests__/seeded-declared-logo.test.ts
 * re-derives all three from those .svg sources through the real sanitizer and
 * fails if a literal here ever drifts, so the harness can never render a value
 * the generator would not emit.
 *
 * They are inlined as literals because this file is DEPENDENCY-FREE by
 * contract (see the header): the Playwright suite imports it by relative path
 * outside the Next.js toolchain, so it cannot read a file or import a script.
 *
 * The three glyphs are deliberately DISTINCT in shape and colour (agent = blue
 * ringed disc, skill = green rounded square, artifact = amber diamond) so a
 * render proof shows WHICH kind resolved WHICH logo — a single shared mark
 * could pass while the cards were cross-wired.
 */
export const SEEDED_AGENT_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByb2xlPSJpbWciIGFyaWEtaGlkZGVuPSJ0cnVlIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iIzBCNUZGRiIgLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0IiBmaWxsPSIjRkZGRkZGIiAvPjwvc3ZnPg==";
export const SEEDED_SKILL_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByb2xlPSJpbWciIGFyaWEtaGlkZGVuPSJ0cnVlIj48cmVjdCB4PSIyIiB5PSIyIiB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHJ4PSIzIiBmaWxsPSIjMTBCOTgxIiAvPjxyZWN0IHg9IjgiIHk9IjgiIHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiNGRkZGRkYiIC8+PC9zdmc+";
export const SEEDED_ARTIFACT_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByb2xlPSJpbWciIGFyaWEtaGlkZGVuPSJ0cnVlIj48cG9seWdvbiBwb2ludHM9IjEyLDEgMjMsMTIgMTIsMjMgMSwxMiIgZmlsbD0iI0Y1OUUwQiIgLz48cG9seWdvbiBwb2ludHM9IjEyLDcgMTcsMTIgMTIsMTcgNywxMiIgZmlsbD0iI0ZGRkZGRiIgLz48L3N2Zz4=";

/**
 * The two brand-gate cards' package BASENAMES (cinatra#2469). Both are slugs
 * that ARE mapped in the host client-icon map (`ICON_BY_SLUG`,
 * src/components/connector-brand-icons.tsx).
 *
 * They live in the package NAME rather than a hand-set field on purpose: the
 * production card model derives the client-icon slug from the package name for
 * EVERY kind (`deriveIconSlug`), so injecting a slug directly would have made
 * the gate test unable to fail on broken slug derivation. One
 * card is a connector (the gate must ALLOW it), the other is a SKILL whose
 * basename collides with a mapped connector slug — the exact hazard the
 * cinatra#1325 connector-only gate exists for (the gate must DENY it).
 */
export const SEEDED_BRAND_GATE_CONNECTOR_BASENAME = "github-connector";
export const SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME = "plane-connector";

export type SeededGridCard = {
  packageName: string;
  packageVersion: string;
  /** Anti-lookalike: shares no token with packageName. */
  displayName: string;
  description: string;
  kindSlug: "agent" | "skill" | "connector" | "artifact";
  kindLabel: string;
  /**
   * The extension's OWN `cinatra.logo`, already sanitized into the inline data
   * URI the manifest generator emits — i.e. exactly what
   * `STATIC_EXTENSION_MANIFEST[pkg].logo` holds for a package that declares one
   * (cinatra#2469, closing the #2469 render gap). Absent/undefined = the
   * ABSENT-LOGO CONTROL: the card must fall straight through to its kind
   * emblem, unchanged.
   *
   * Three NON-connector kinds carry one (agent, skill, artifact) because #2469
   * generalized `cinatra.logo` to every extension kind; the tile must render it
   * `size-6 object-contain` (24×24, contained) rather than the full-bleed
   * `object-cover` the catalog/vendor artwork tiers get.
   */
  manifestLogoUrl?: string;
  /**
   * The CTA state this card renders AT REST on the seeded grid (cinatra#2363
   * item 2): one card per six-state identity, so the production-density grid
   * composition exercises every CTA label — including the long "Installing…"
   * pending presentation, which the per-surface harness only reaches
   * mid-flight. The seeded controls stay INERT (per-card CTA behaviour is
   * owned by the extension-listing-card-* surfaces); state coverage here is
   * about geometry + labels at the real grid density.
   */
  ctaState: SeededGridCtaState;
  /** The exact rendered CTA label for `ctaState` — asserted by the geometry suite. */
  ctaLabel: string;
};

// The declared-logo assignment (cinatra#2469) rides the EXISTING six cards — no
// card is added or removed, so every cardinality constant and the pairwise
// distinctness invariant are untouched. The six split into four proof cells:
//
//   DECLARED    agent field-notes / skill page-turner / artifact style-pack —
//               the three kinds #2469 newly admitted; each must render its own
//               24×24 `object-contain` glyph. (A CONNECTOR could always declare
//               one structurally and its render landed with cinatra#1482 — it is
//               not #2469's gap, so the connector card is spent on the gate.)
//   CONTROL     agent quote-mill — no declared logo, no mapped slug: the kind
//               emblem, unchanged. Proves the declared-logo tier is what moved
//               the render, not some unrelated tile change.
//   GATE-ALLOW  connector github-connector — no declared logo, its basename
//               DERIVES a mapped slug: the client-icon brand mark still
//               resolves for a CONNECTOR.
//   GATE-DENY   skill plane-connector — no declared logo, its basename likewise
//               derives a mapped slug: a non-connector must NOT borrow the
//               brand mark; it falls to its kind emblem (the cinatra#1325
//               gate, pinned here on the live surface rather than
//               only in jsdom).
//
// The two gate basenames REPLACE the previous `wire-tap` / `lens-cap` names.
// Nothing outside this file referenced them (every consumer iterates the array),
// and the rename is what makes the gate genuinely derivable rather than injected.
export const SEEDED_GRID_CARDS: SeededGridCard[] = [
  { packageName: "@cinatra-fixtures/field-notes", packageVersion: "1.0.0", displayName: "Survey Companion", description: "Collects structured observations on the go.", kindSlug: "agent", kindLabel: "Agent", ctaState: "install", ctaLabel: "Install now", manifestLogoUrl: SEEDED_AGENT_LOGO_DATA_URI },
  { packageName: "@cinatra-fixtures/page-turner", packageVersion: "2.3.0", displayName: "Longform Skimmer", description: "Summarizes book-length PDFs chapter by chapter.", kindSlug: "skill", kindLabel: "Skill", ctaState: "installed", ctaLabel: "Installed", manifestLogoUrl: SEEDED_SKILL_LOGO_DATA_URI },
  { packageName: `@cinatra-fixtures/${SEEDED_BRAND_GATE_CONNECTOR_BASENAME}`, packageVersion: "1.1.2", displayName: "Event Stream Bridge", description: "Subscribes the workspace to external event feeds.", kindSlug: "connector", kindLabel: "Connector", ctaState: "update", ctaLabel: "Update now" },
  { packageName: "@cinatra-fixtures/style-pack", packageVersion: "4.0.0", displayName: "Voice Guide Bundle", description: "House tone-of-voice templates and examples.", kindSlug: "artifact", kindLabel: "Artifact", ctaState: "restore", ctaLabel: "Restore", manifestLogoUrl: SEEDED_ARTIFACT_LOGO_DATA_URI },
  { packageName: "@cinatra-fixtures/quote-mill", packageVersion: "1.5.0", displayName: "Proposal Drafter", description: "Assembles priced proposals from catalog items.", kindSlug: "agent", kindLabel: "Agent", ctaState: "installing", ctaLabel: "Installing…" },
  { packageName: `@cinatra-fixtures/${SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME}`, packageVersion: "0.2.1", displayName: "Screenshot Annotator", description: "Marks up captures with callouts and blur.", kindSlug: "skill", kindLabel: "Skill", ctaState: "incompatible", ctaLabel: "Install now" },
];

/** The seeded cards that declare their own `cinatra.logo` (cinatra#2469). */
export const SEEDED_DECLARED_LOGO_CARDS = SEEDED_GRID_CARDS.filter(
  (c) => c.manifestLogoUrl != null,
); // 3 — one per non-connector kind (agent, skill, artifact)
/** The seeded cards with NO declared logo — the absent-logo control set. */
export const SEEDED_ABSENT_LOGO_CARDS = SEEDED_GRID_CARDS.filter(
  (c) => c.manifestLogoUrl == null,
); // 3

export const SEEDED_GRID_CARD_COUNT = SEEDED_GRID_CARDS.length; // 6 (workflow card removed — cinatra#1035)

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
/**
 * The ALL-segment cardinality (cinatra#2355, epic #2353): with "All" the new
 * landing filter (#2357), the default view shows EVERY seeded card, so the
 * grid's `present` cardinality is this number rather than the connected 3.
 * It is the union of the two status buckets — asserted as a clean partition,
 * and kept pairwise-distinct from every other seeded count, in
 * ../__tests__/seed-partition.test.ts.
 */
export const SEEDED_CONNECTOR_ALL_COUNT = SEEDED_CONNECTOR_CARDS.length; // 8
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
