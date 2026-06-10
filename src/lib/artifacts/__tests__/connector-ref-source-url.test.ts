import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Connector-ref source URL projection (issue #68).
//
// `objects.data.connectorRef.url` is the canonical persisted shape for the
// "Open in source application" pointer; `connectorRefSourceUrl` is the typed
// accessor that validates it (http/https only — objects.data is org-supplied
// JSONB that ends up in an <a href>), and the service projects it onto
// `ArtifactSummary.sourceUrl` for both the list and get read paths. Object
// store mocked (no DB), mirroring service-and-mcp.test.ts.

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();

vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({
  tombstoneArtifact: vi.fn(),
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
}));
// Summary enrichment reads the assertion store; return no rows so the
// summaries fall back to floor-default semantic identity.
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  listArtifactIdsForExtension: vi.fn(),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));

const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

function objectRow(data: Record<string, unknown>) {
  return {
    id: "a1",
    type: ARTIFACT_TYPE,
    data: {
      artifactType: "file",
      title: "T",
      mime: "application/octet-stream",
      size: 1,
      originKind: "upload",
      ...data,
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("connectorRefSourceUrl — typed, validating accessor", () => {
  it("accepts absolute https URLs and returns the canonical href", async () => {
    const { connectorRefSourceUrl } = await import("../artifact-service");
    expect(
      connectorRefSourceUrl({
        connectorRef: { url: "https://docs.example.com/d/abc?tab=1" },
      }),
    ).toBe("https://docs.example.com/d/abc?tab=1");
    // Canonicalized via URL parsing, not echoed raw.
    expect(
      connectorRefSourceUrl({ connectorRef: { url: "HTTPS://Example.COM" } }),
    ).toBe("https://example.com/");
  });

  it("accepts absolute http URLs (self-hosted / LAN connector sources)", async () => {
    const { connectorRefSourceUrl } = await import("../artifact-service");
    expect(
      connectorRefSourceUrl({
        connectorRef: { url: "http://wordpress.internal:8080/wp-admin/post.php?post=5" },
      }),
    ).toBe("http://wordpress.internal:8080/wp-admin/post.php?post=5");
  });

  it("rejects non-http(s) protocols (href injection)", async () => {
    const { connectorRefSourceUrl } = await import("../artifact-service");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
      "blob:https://example.com/x",
    ]) {
      expect(connectorRefSourceUrl({ connectorRef: { url } })).toBeNull();
    }
  });

  it("rejects relative, empty, and malformed URLs", async () => {
    const { connectorRefSourceUrl } = await import("../artifact-service");
    expect(connectorRefSourceUrl({ connectorRef: { url: "/docs/abc" } })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: { url: "example.com/x" } })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: { url: "" } })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: { url: "http://" } })).toBeNull();
  });

  it("returns null for missing or malformed connectorRef shapes", async () => {
    const { connectorRefSourceUrl } = await import("../artifact-service");
    expect(connectorRefSourceUrl(undefined)).toBeNull();
    expect(connectorRefSourceUrl(null)).toBeNull();
    expect(connectorRefSourceUrl("https://example.com")).toBeNull();
    expect(connectorRefSourceUrl({})).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: null })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: "https://example.com" })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: { url: 42 } })).toBeNull();
    expect(connectorRefSourceUrl({ connectorRef: {} })).toBeNull();
  });
});

describe("ArtifactSummary.sourceUrl projection (list + get read paths)", () => {
  beforeEach(() => {
    listObjectsByFilter.mockReset();
    getObjectById.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("getArtifact surfaces a validated connectorRef.url as sourceUrl", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(
      objectRow({ connectorRef: { url: "https://app.example.com/doc/9" } }),
    );
    const summary = getArtifact({ artifactId: "a1", orgId: "org1" });
    expect(summary?.sourceUrl).toBe("https://app.example.com/doc/9");
  });

  it("getArtifact yields sourceUrl null for blob artifacts (no connectorRef) and for unsafe URLs", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(objectRow({}));
    expect(getArtifact({ artifactId: "a1", orgId: "org1" })?.sourceUrl).toBeNull();

    getObjectById.mockReturnValue(
      objectRow({ connectorRef: { url: "javascript:alert(1)" } }),
    );
    expect(getArtifact({ artifactId: "a1", orgId: "org1" })?.sourceUrl).toBeNull();
  });

  it("listArtifacts surfaces sourceUrl per row", async () => {
    const { listArtifacts } = await import("../artifact-service");
    listObjectsByFilter.mockReturnValue([
      objectRow({ connectorRef: { url: "https://app.example.com/doc/9" } }),
      { ...objectRow({}), id: "a2" },
    ]);
    const rows = listArtifacts({ orgId: "org1" });
    const byId = new Map(rows.map((r) => [r.artifactId, r.sourceUrl]));
    expect(byId.get("a1")).toBe("https://app.example.com/doc/9");
    expect(byId.get("a2")).toBeNull();
  });
});
