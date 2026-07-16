// ---------------------------------------------------------------------------
// Deterministic fixture data for the design-conformance functional-acceptance
// harness (cinatra#985). Imported by BOTH the harness client component
// (card-fixtures.tsx) and the Playwright suite
// (tests/e2e/design/conformance/functional-acceptance.spec.ts), so the suite's
// field-binding assertions ("name renders manifest.displayName, never the
// package name") compare against the SAME values the harness rendered.
//
// Intentionally dependency-free (no "@/" or workspace imports): the Playwright
// suite imports this file by relative path outside the Next.js toolchain.
// ---------------------------------------------------------------------------

export type ConformanceCardFixture = {
  /** Conformance-manifest surface id this fixture instantiates. */
  surfaceId:
    | "extension-listing-card-available"
    | "extension-listing-card-installed"
    | "extension-listing-card-update"
    | "extension-listing-card-restore"
    | "extension-listing-card-installing"
    | "extension-listing-card-incompatible";
  packageName: string;
  /** Catalog (latest) version. Bare semver — presentation adds any prefix. */
  packageVersion: string;
  /**
   * manifest.displayName — deliberately UNRELATED to packageName so the
   * field-binding assertion can prove the card binds the display name and
   * not the package name (the exact drift the annotated spec forbids).
   */
  displayName: string;
  description: string;
  kindSlug: "agent" | "skill" | "connector" | "artifact";
  kindLabel: string;
  /** Declared ABI range: "*" reads compatible; an unsatisfiable range reads incompatible. */
  sdkAbiRange: string | null;
  /** Installed-state input for the REAL resolveMarketplaceCardCta resolver. */
  installed: { version: string; isArchived: boolean } | null;
  /**
   * Harness action latency. The "installing" fixture uses a LONG delay so the
   * suite can assert the loading state mid-flight without racing completion.
   */
  ctaDelayMs: number;
};

export const CONFORMANCE_CARD_FIXTURES: ConformanceCardFixture[] = [
  {
    surfaceId: "extension-listing-card-available",
    packageName: "@cinatra-fixtures/outreach-pipeline",
    packageVersion: "1.4.0",
    displayName: "Research Outreach Agent",
    description: "Plans multi-step outreach research and drafts cited briefs.",
    kindSlug: "agent",
    kindLabel: "Agent",
    sdkAbiRange: "*",
    installed: null,
    ctaDelayMs: 250,
  },
  {
    surfaceId: "extension-listing-card-installed",
    packageName: "@cinatra-fixtures/summarize-notes",
    packageVersion: "2.1.0",
    displayName: "Meeting Summarizer Skill",
    description: "Summarizes meeting notes into action items.",
    kindSlug: "skill",
    kindLabel: "Skill",
    sdkAbiRange: "*",
    installed: { version: "2.1.0", isArchived: false },
    ctaDelayMs: 0,
  },
  {
    // Spec demo card changed kind workflow → agent (design#71,
    // specs/app-extensions.html §III: data-state="kind:agent"). The fixture kind
    // flips with it; the cardDriver auto-derives the required kind:agent state
    // variant + the "Agent" publisher-byline label from kindSlug/kindLabel.
    surfaceId: "extension-listing-card-update",
    packageName: "@cinatra-fixtures/pipeline-board",
    packageVersion: "3.0.0",
    displayName: "Revenue Pulse Agent",
    description: "Live revenue, churn and pipeline metrics, refreshed from your billing and CRM.",
    kindSlug: "agent",
    kindLabel: "Agent",
    sdkAbiRange: "*",
    installed: { version: "2.2.0", isArchived: false },
    ctaDelayMs: 250,
  },
  {
    surfaceId: "extension-listing-card-restore",
    packageName: "@cinatra-fixtures/crm-bridge",
    packageVersion: "1.0.3",
    displayName: "CRM Bridge Connector",
    description: "Connects the workspace to the CRM change feed.",
    kindSlug: "connector",
    kindLabel: "Connector",
    sdkAbiRange: "*",
    installed: { version: "1.0.3", isArchived: true },
    ctaDelayMs: 250,
  },
  {
    surfaceId: "extension-listing-card-installing",
    packageName: "@cinatra-fixtures/brand-kit",
    packageVersion: "0.9.1",
    displayName: "Brand Kit Artifact",
    description: "Curated brand asset bundle for campaign runs.",
    kindSlug: "artifact",
    kindLabel: "Artifact",
    sdkAbiRange: "*",
    installed: null,
    // Long enough that the suite can click Install and assert the pending
    // ("Installing…") presentation without racing the resolved state.
    ctaDelayMs: 8000,
  },
  {
    surfaceId: "extension-listing-card-incompatible",
    packageName: "@cinatra-fixtures/future-agent",
    packageVersion: "5.0.0",
    displayName: "Future Host Agent",
    description: "Declares an ABI range this host cannot satisfy.",
    kindSlug: "agent",
    kindLabel: "Agent",
    // Unsatisfiable on any current host: the REAL deriveExtensionCompatState
    // verdict turns this into the greyed six-state "Incompatible" CTA.
    sdkAbiRange: ">=999.0.0",
    installed: null,
    ctaDelayMs: 0,
  },
];

/** Status-pill statuses rendered by the harness (design system §VI set). */
export const CONFORMANCE_STATUS_PILL_STATUSES = [
  "running",
  "approved",
  "hold",
  "needs-review",
  "scheduled",
  "queued",
  "idle",
  "archived",
  "failed",
  "declined",
] as const;

/** Button variants rendered by the harness (ui/button.tsx cva variants). */
export const CONFORMANCE_BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;

/**
 * Post-install "needs configuration" callout fixture (cinatra#1057 surface,
 * conformance id `install-config-needs-callout`; design#71
 * specs/app-extensions.html §VI). A freshly-installed AGENT with an
 * unconfigured REQUIRED connector dependency wears the greyed needs-review
 * treatment, and a thin status strip attached to the bottom of its §III card
 * lists each unconfigured connector by its human `manifest.displayName`, linked
 * to that connector's own `/connectors/<vendor>/<slug>/setup` page (the
 * `configure -> connector-setup` affordance). The `empty` variant (every
 * required connector configured) drops the strip and returns the card to its
 * active colours.
 *
 * The connector `displayName` deliberately shares NO token with its `slug` or
 * `packageName`, so the name-binding assertion proves the strip binds the
 * displayName — never the slug or package name (the same anti-lookalike
 * discipline the seeded connector-grid fixture uses).
 */
export const CONFORMANCE_INSTALL_CONFIG_CALLOUT = {
  surfaceId: "install-config-needs-callout",
  /** The host agent the strip hangs off — greyed, cannot-run until configured. */
  agent: {
    packageName: "@cinatra-fixtures/apollo-prospecting-agent",
    displayName: "Apollo Prospecting Agent",
    description:
      "Finds prospecting contacts by organisation and title, then upserts each into your CRM.",
    kindLabel: "Agent",
    // Bare semver (the sibling card fixtures' convention) — the §VI spec line's
    // v-prefix is the card caller's; this string is fixture-cosmetic, asserted
    // by no driver.
    version: "1.2.0",
    vendorName: "Cinatra Fixtures",
  },
  /** The single unconfigured REQUIRED connector dependency the strip lists. */
  connector: {
    packageName: "@cinatra-fixtures/prospecting-data-connector",
    displayName: "Apollo",
    slug: "prospecting-data",
    /**
     * Deep-link to the connector's OWN setup page — the real
     * `/connectors/<vendor>/<slug>/setup` route the affordance routes to
     * (outcome: connector-setup).
     */
    settingsHref: "/connectors/cinatra-fixtures/prospecting-data/setup",
  },
} as const;
