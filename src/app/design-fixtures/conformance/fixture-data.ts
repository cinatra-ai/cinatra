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
  kindSlug: "agent" | "skill" | "workflow" | "connector" | "artifact";
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
    surfaceId: "extension-listing-card-update",
    packageName: "@cinatra-fixtures/weekly-digest",
    packageVersion: "3.0.0",
    displayName: "Weekly Digest Workflow",
    description: "Assembles and schedules the weekly digest run.",
    kindSlug: "workflow",
    kindLabel: "Workflow",
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
