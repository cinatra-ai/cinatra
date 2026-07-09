// ---------------------------------------------------------------------------
// Renderable-view fixtures (cinatra#1220, S4).
//
// Canonical + hostile/edge payloads for each registered view, used by the
// renderer render tests here and available to the S6 conformance corpus (#1222)
// as the S4 contribution. Each fixture is the RAW `DATA_PART` payload (as it
// arrives on the wire), so tests exercise the full parse→dispatch→render path.
// ---------------------------------------------------------------------------

export const validRenderableViewFixtures = {
  content_change_proposal: {
    viewType: "content_change_proposal",
    schemaVersion: 1,
    surface: "wordpress",
    postId: "42",
    rich: false,
    fields: [
      { field: "title", before: "Old title", after: "New title" },
      { field: "excerpt", after: "A fresh excerpt" },
    ],
  },
  content_change_proposal_rich: {
    viewType: "content_change_proposal",
    schemaVersion: 1,
    surface: "drupal",
    nodeId: "7",
    rich: true,
    fields: [],
  },
  artifact_preview: {
    viewType: "artifact_preview",
    schemaVersion: 1,
    name: "quarterly-report.pdf",
    kind: "document",
    mimeType: "application/pdf",
    href: "https://example.com/quarterly-report.pdf",
    sizeBytes: 2_500_000,
    description: "Q3 financials",
  },
  citation_group: {
    viewType: "citation_group",
    schemaVersion: 1,
    label: "References",
    sources: [
      { title: "Cinatra docs", url: "https://docs.example.com", snippet: "Getting started" },
      { title: "An unlinked source", snippet: "no url" },
    ],
  },
  change_history: {
    viewType: "change_history",
    schemaVersion: 1,
    entries: [
      { runId: "run_1", label: "Updated the page title", undoable: true },
      { runId: "run_2", label: "Fixed a typo", undoable: false },
    ],
  },
} as const;

// Hostile / edge payloads — must render safely (fallback or inert text), never
// execute script and never throw.
export const hostileRenderableViewFixtures = {
  // A <script>-bearing before/after value: valid shape, must render as text.
  script_in_change_field: {
    viewType: "content_change_proposal",
    schemaVersion: 1,
    rich: false,
    fields: [
      { field: "body", before: "clean", after: "<script>alert('xss')</script>" },
    ],
  },
  // A javascript: artifact href — sanitized to undefined at parse; renders inert.
  javascript_href_artifact: {
    viewType: "artifact_preview",
    schemaVersion: 1,
    name: "<img src=x onerror=alert(1)>",
    href: "javascript:alert(1)",
  },
  // Unknown viewType — dispatcher renders the fallback.
  unknown_view: {
    viewType: "some_future_view_v9",
    schemaVersion: 1,
    payload: "whatever",
  },
  // Forward-incompatible schemaVersion of a known view — fallback.
  future_version_change_proposal: {
    viewType: "content_change_proposal",
    schemaVersion: 99,
    rich: false,
    fields: [{ field: "title", after: "x" }],
  },
  // Not a renderable view at all (no viewType) — fallback with no rawViewType.
  plain_data_part: { some: "structured", data: true },
} as const;
