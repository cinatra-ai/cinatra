// ---------------------------------------------------------------------------
// The ARTIFACT-KIND DISPLAY surfaces of the artifact-review drawing, standalone
// (cinatra#3158, epic #3155 W2).
//
// One row per manifest surface this wave covers, carrying exactly what the
// ratified drawing declares for it — the field and its source, the action and
// its outcome, the state variants — and, where the display is not on the default
// branch yet, what it is waiting for.
//
// WHY THE ROWS LIVE IN THEIR OWN FILE. contract.ts is a Playwright module: it
// cannot be read by the ordinary node unit tier. These rows are the wave's
// COVERAGE RECORD as much as they are driver input — "every surface listed in
// the wave has a driver, and the three that share one shape ride one factory" is
// a claim a unit test has to be able to check without opening a browser
// (scripts/design/__tests__/conformance-artifact-review-wave.test.mjs). So the
// rows are pure data here, with no Playwright import, and contract.ts builds the
// driver map FROM them — being in this list IS being in the map.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR AND NO ASSERTION. It carries the
// drawing's own declarations, keyed by the manifest surface they belong to. The
// assertions are contract.ts's; the manifest is the contract they are reconciled
// against by the suite itself.
// ---------------------------------------------------------------------------

/** The manifest surfaces this wave covers. */
export const ARTIFACT_KIND_DISPLAY_SURFACES = [
  "email-body-display",
  "mixed-kind-display",
  "screenshot-display",
  "slide-deck-display",
  "dashboard-display",
  "portlet-display",
  "drupal-pointer-display",
  "cms-page-display",
  "markdown-display-tabs",
  "binary-download-card",
  "chart-display-only",
] as const;

export type ArtifactKindDisplaySurfaceId = (typeof ARTIFACT_KIND_DISPLAY_SURFACES)[number];

export type ArtifactKindDisplayField = { readonly name: string; readonly source: string };
export type ArtifactKindDisplayAction = { readonly name: string; readonly outcome: string };

export type ArtifactKindDisplay = {
  /** The manifest surface id — and the harness mount's `data-surface-id`. */
  readonly surface: ArtifactKindDisplaySurfaceId;
  /** The section of the drawing this display is drawn in. */
  readonly section: string;
  /**
   * TRUE for the three surfaces whose per-kind display shape is the whole of
   * what the drawing gives them, so the shared factory drives them alone; FALSE
   * for the eight that carry a drawn structure of their own on top of it
   * (cinatra#3158: "markdown-display-tabs, binary-download-card, and
   * chart-display-only share the same per-kind display shape closely enough to
   * ride the same factory rather than getting individual drivers").
   */
  readonly factoryOnly: boolean;
  /** The one field the manifest binds on this surface, or null where it binds none. */
  readonly field: ArtifactKindDisplayField | null;
  /** The one action the manifest declares on this surface, or null where it declares none. */
  readonly action: ArtifactKindDisplayAction | null;
  /** The state variants the manifest declares, in the manifest's own order. */
  readonly states: readonly string[];
  /**
   * What this display is waiting for on the default branch, named on every
   * skipped test. Grounded by reading the shipped tree, never assumed.
   */
  readonly readiness: string;
};

export const ARTIFACT_KIND_DISPLAYS: Readonly<
  Record<ArtifactKindDisplaySurfaceId, ArtifactKindDisplay>
> = {
  "email-body-display": {
    surface: "email-body-display",
    section: "XI.1",
    factoryOnly: false,
    field: { name: "body", source: "representation.body-markdown" },
    action: { name: "edit-email-body", outcome: "revision-saved" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the email extension ships review renderers (the drafts review, the recipients review, the sender and the send confirmation) and no BODY display — the mail detail pane the drawing gives the body type is not in the tree, so nothing draws the sender block, the subject and the body under a rule",
  },
  "mixed-kind-display": {
    surface: "mixed-kind-display",
    section: "XI.2",
    factoryOnly: false,
    field: { name: "form", source: "representation.content-form" },
    action: null,
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "each of the seven kind extensions ships a type declaration and no display of its own, so no shell branches on the artifact's content form — the drawing's whole point here is that an own display never falls through to a form provider, which is exactly what a kind without a display does today",
  },
  "screenshot-display": {
    surface: "screenshot-display",
    section: "XI.3",
    factoryOnly: false,
    field: { name: "source", source: "representation.captured-url" },
    action: null,
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the screenshot extension declares its type and ships no renderer, so nothing draws the captured picture, the facts beneath it, or the named gap where the bytes are refused",
  },
  "slide-deck-display": {
    surface: "slide-deck-display",
    section: "XI.4",
    factoryOnly: false,
    field: null,
    action: null,
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the deck extension declares its type and ships no renderer, so the embedded viewer the drawing mounts for the exported pdf is not drawn anywhere",
  },
  "dashboard-display": {
    surface: "dashboard-display",
    section: "XI.5",
    factoryOnly: false,
    field: { name: "layout", source: "representation.pinned-configuration" },
    action: { name: "open-live-dashboard", outcome: "dashboard-canonical" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the dashboard extension ships no renderer bundle at all (it says so in its own module header), so the shared read-only composition the drawing renders the pinned configuration through is not drawn on an artifact surface",
  },
  "portlet-display": {
    surface: "portlet-display",
    section: "XI.6",
    factoryOnly: false,
    field: { name: "entry", source: "representation.portlet-instance-id" },
    action: { name: "open-live-dashboard", outcome: "dashboard-canonical" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "no portlet artifact extension exists in the tree, so there is no display for one entry of a dashboard cut on its own, and no cut that mints one",
  },
  "drupal-pointer-display": {
    surface: "drupal-pointer-display",
    section: "XI.7",
    factoryOnly: false,
    field: { name: "target", source: "representation.node-id" },
    action: { name: "open-in-cms", outcome: "cms-opened" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the pointer draws through the ONE page renderer the drawing names — @cinatra-ai/website-artifacts:page-diff — and no package in the tree ships it, so the pointer's own extension declares its type and draws nothing",
  },
  "cms-page-display": {
    surface: "cms-page-display",
    section: "XI.8",
    factoryOnly: false,
    field: { name: "excerpts", source: "representation.changed-excerpts" },
    action: { name: "open-in-cms", outcome: "cms-opened" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "@cinatra-ai/website-artifacts:page-diff — the one renderer both CMS extensions draw through — is not in the tree; the snapshot renderer that IS shipped draws a read-only list of reviewed FIELDS with a scope chip row, which is a different display: no page embedded in a frame, no diff of the changed excerpts, and no Open in the CMS",
  },
  "markdown-display-tabs": {
    surface: "markdown-display-tabs",
    section: "V.1",
    factoryOnly: true,
    field: { name: "content", source: "representation.markdown" },
    action: { name: "edit-markdown", outcome: "revision-saved" },
    states: ["error", "loading"],
    readiness:
      "the shipped markdown display draws the rendered reading and the raw source SIDE BY SIDE in one grid, which the drawing forbids outright (\"They are never drawn side by side\"): there is no tab strip, no Code and Preview, no saving indicator, and no edit in place",
  },
  "binary-download-card": {
    surface: "binary-download-card",
    section: "V.2",
    factoryOnly: true,
    field: { name: "name", source: "artifact.fileName" },
    action: { name: "download-artifact", outcome: "file-downloaded" },
    states: ["error", "kind:artifact", "loading"],
    readiness:
      "the download card itself IS shipped — the file's name, its form, its size and one download, and no reading of the bytes — but it carries none of the conformance anchors this contract addresses (no surface anchor, no declared action-and-outcome control), it has no loading and no error presentation, and it is an extension renderer the conformance harness may not mount: a fixture naming a real extension instance is what the core/extension instance-coupling ban exists to stop",
  },
  "chart-display-only": {
    surface: "chart-display-only",
    section: "XI.9",
    factoryOnly: true,
    field: null,
    action: null,
    states: ["empty", "kind:artifact"],
    readiness:
      "the chart extension already declares no artifact display, which is the drawing's own reading of this surface; what is missing is the artifact-page mount that draws the form provider's reading for a stored chart file, so there is nothing yet on which to assert that no chart display is drawn beside it",
  },
};

/** The rows, in the wave's own declared order. */
export const ARTIFACT_KIND_DISPLAY_ROWS: readonly ArtifactKindDisplay[] =
  ARTIFACT_KIND_DISPLAY_SURFACES.map((id) => ARTIFACT_KIND_DISPLAYS[id]);
