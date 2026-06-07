import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the MCP SDK so we can assert transport wiring without a live server.
// vi.hoisted keeps the spies available to the hoisted vi.mock factories; the
// constructor mocks use regular functions so `new` works.
const { connectMock, callToolMock, closeMock, transportCtor } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  callToolMock: vi.fn(),
  closeMock: vi.fn().mockResolvedValue(undefined),
  transportCtor: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function (this: Record<string, unknown>) {
    this.connect = connectMock;
    this.callTool = callToolMock;
    this.close = closeMock;
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (this: unknown, url: URL, opts: unknown) {
    transportCtor(url, opts);
  }),
}));

import {
  createHttpMarketplaceMcpClient,
  fetchPublicMarketplaceExtensionDetail,
  fetchPublicMarketplaceExtensionList,
  resolveMarketplaceBaseUrl,
  MARKETPLACE_BASE_URL,
} from "../src/http-client";
import { MarketplaceMcpError } from "../src/client";

describe("createHttpMarketplaceMcpClient", () => {
  beforeEach(() => {
    connectMock.mockClear();
    callToolMock.mockReset();
    closeMock.mockClear();
    transportCtor.mockClear();
  });

  it("targets the MCP endpoint and uses the cinatra-<kebab> tool name", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { vendor_id: 7, namespace: "@acme" } });
    const client = createHttpMarketplaceMcpClient({ token: "tok-123", baseUrl: "https://mk.test" });

    await client.vendorRegisterSelf({
      namespace: "@acme",
      terms_version: "1",
      terms_digest: "a".repeat(64),
    });

    const [url] = transportCtor.mock.calls[0];
    expect(url.toString()).toBe("https://mk.test/wp-json/cinatra/mcp");
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-vendor-register-self",
      arguments: { namespace: "@acme", terms_version: "1", terms_digest: "a".repeat(64) },
    });
  });

  it("sends a raw token as Bearer and passes a schemed token through unchanged", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });

    await createHttpMarketplaceMcpClient({ token: "raw-token", baseUrl: "https://mk.test" }).vendorGetSelf();
    expect((transportCtor.mock.calls[0][1] as { requestInit: { headers: Record<string, string> } }).requestInit.headers.Authorization).toBe("Bearer raw-token");

    transportCtor.mockClear();
    await createHttpMarketplaceMcpClient({ token: "Basic abc==", baseUrl: "https://mk.test" }).vendorGetSelf();
    expect((transportCtor.mock.calls[0][1] as { requestInit: { headers: Record<string, string> } }).requestInit.headers.Authorization).toBe("Basic abc==");
  });

  it("vendorGetSelf calls the right tool with empty args", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { state: "unregistered" } });
    await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).vendorGetSelf();
    expect(callToolMock).toHaveBeenCalledWith({ name: "cinatra-vendor-get-self", arguments: {} });
  });

  it("prefers structuredContent over text content", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { profile_visibility: "public" },
      content: [{ type: "text", text: '{"profile_visibility":"WRONG"}' }],
    });
    const out = await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" })
      .vendorProfileVisibilitySet({ visibility: "public" });
    expect(out.profile_visibility).toBe("public");
  });

  it("falls back to parsing JSON text content when no structuredContent", async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: '{"namespace":"@acme","profile_visibility":"private"}' }],
    });
    const out = await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" })
      .vendorProfileVisibilitySet({ visibility: "private" });
    expect(out.namespace).toBe("@acme");
  });

  it("throws MarketplaceMcpError when the tool result isError", async () => {
    callToolMock.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).vendorGetSelf(),
    ).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("closes the client even after a successful call", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });
    await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).vendorGetSelf();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("orphaned methods (no backing ability yet) throw a clear 501", async () => {
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).vendorGet({ vendorSlug: "acme" }),
    ).rejects.toMatchObject({ httpStatus: 501 });
  });

  it("extensionList targets cinatra-extension-list, passes snake_case args through, returns structuredContent", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        items: [
          {
            package_name: "@cinatra-ai/blog-skills",
            scope: "cinatra-ai",
            extension_name: "blog-skills",
            version: "0.1.0",
            kind_slug: "skill",
            kind_label: "Skill",
            display_name: "@cinatra-ai/blog-skills",
            description: "Blog skills",
            badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
            freshness_at: "2026-06-01T00:00:00Z",
            rating: { average: 0, count: 0 },
            vendor_logo_key: null,
            permalink: "https://marketplace.cinatra.ai/product/blog-skills",
          },
        ],
        total: 1,
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionList({ kind: "skill", query: "blog", limit: 10, offset: 0 });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-list",
      arguments: { kind: "skill", query: "blog", limit: 10, offset: 0 },
    });
    expect(out.total).toBe(1);
    expect(out.items[0].package_name).toBe("@cinatra-ai/blog-skills");
    expect(out.items[0].version).toBe("0.1.0");
  });

  it("extensionList defaults to empty args and parses JSON text fallback", async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: '{"items":[],"total":0}' }],
    });
    const out = await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionList();
    expect(callToolMock).toHaveBeenCalledWith({ name: "cinatra-extension-list", arguments: {} });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("extensionList propagates a tool isError as MarketplaceMcpError (no swallow)", async () => {
    callToolMock.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionList(),
    ).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("fetchPublicMarketplaceExtensionList uses the anonymous REST catalog without Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await fetchPublicMarketplaceExtensionList(
        { kind: "skill", query: "blog", limit: 10, offset: 20 },
        { baseUrl: "https://mk.test" },
      );

      expect(out).toEqual({ items: [], total: 0 });
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(
        "https://mk.test/wp-json/cinatra/v1/extensions?kind=skill&query=blog&limit=10&offset=20",
      );
      expect(init.headers).toEqual({ Accept: "application/json" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetchPublicMarketplaceExtensionList throws MarketplaceMcpError on non-404 5xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublicMarketplaceExtensionList({}, { baseUrl: "https://mk.test" }),
      ).rejects.toMatchObject({ httpStatus: 502 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetchPublicMarketplaceExtensionList throws MarketplaceMcpError when the response is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublicMarketplaceExtensionList({}, { baseUrl: "https://mk.test" }),
      ).rejects.toBeInstanceOf(MarketplaceMcpError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetchPublicMarketplaceExtensionDetail uses anonymous REST detail without Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "@cinatra-ai/web-research-agent",
          scope: "cinatra-ai",
          extension_name: "web-research-agent",
          kind: "agent",
          latest_version: "0.1.16",
          description: "Research the web.",
          current_visibility: "public",
          last_published_at: "2026-06-07T00:00:00Z",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await fetchPublicMarketplaceExtensionDetail(
        { packageName: "@cinatra-ai/web-research-agent" },
        { baseUrl: "https://mk.test" },
      );

      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(
        "https://mk.test/wp-json/cinatra/v1/extensions/cinatra-ai/web-research-agent",
      );
      expect(init.headers).toEqual({ Accept: "application/json" });
      expect(out.packageName).toBe("@cinatra-ai/web-research-agent");
      expect(out.kind).toBe("agent");
      expect(out.latestVersion).toBe("0.1.16");
      expect(out.currentVisibility).toBe("public");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetchPublicMarketplaceExtensionDetail maps public REST 404 to MarketplaceMcpError without fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublicMarketplaceExtensionDetail(
          { packageName: "@scope/missing" },
          { baseUrl: "https://mk.test" },
        ),
      ).rejects.toMatchObject({ httpStatus: 404 });
      expect(connectMock).not.toHaveBeenCalled();
      expect(callToolMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetchPublicMarketplaceExtensionDetail throws MarketplaceMcpError when the response is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublicMarketplaceExtensionDetail(
          { packageName: "@scope/ext" },
          { baseUrl: "https://mk.test" },
        ),
      ).rejects.toBeInstanceOf(MarketplaceMcpError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("extensionSubmitForReview targets the right tool with the input shape", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { submission_id: "sub-1", target_final_identity: "@acme/foo@1.0.0", status: "pending", idempotent_replay: false },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const result = await client.extensionSubmitForReview({
      namespace: "@acme",
      extension_name: "foo",
      version: "1.0.0",
      artifact_digest_sha256: "a".repeat(64),
      artifact_size_bytes: 12,
      tarball_base64: "AAAA",
    });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submit-for-review",
      arguments: expect.objectContaining({ namespace: "@acme", extension_name: "foo", version: "1.0.0" }),
    });
    expect(result.submission_id).toBe("sub-1");
    expect(result.idempotent_replay).toBe(false);
  });

  it("extensionSubmissionListSelf calls the right tool with empty args", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { submissions: [] } });
    await createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionSubmissionListSelf();
    expect(callToolMock).toHaveBeenCalledWith({ name: "cinatra-extension-submission-list-self", arguments: {} });
  });

  it("extensionSubmissionListAdmin forwards status filter and defaults to empty input", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { submissions: [] } });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    await client.extensionSubmissionListAdmin({ status: "approved", limit: 10 });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-list-admin",
      arguments: { status: "approved", limit: 10 },
    });

    callToolMock.mockClear();
    await client.extensionSubmissionListAdmin();
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-list-admin",
      arguments: {},
    });
  });

  it("extensionSubmissionWithdraw forwards submission_id", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { submission_id: "sub-1", status: "withdrawn" },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    await client.extensionSubmissionWithdraw({ submission_id: "sub-1" });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-withdraw",
      arguments: { submission_id: "sub-1" },
    });
  });

  it("extensionSubmissionApprove forwards submission_id", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        submission_id: "sub-1",
        status: "approved",
        promotion_state: "in_flight",
        target_final_identity: "@acme/foo@1.0.0",
        promotion_error: null,
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    await client.extensionSubmissionApprove({ submission_id: "sub-1" });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-approve",
      arguments: { submission_id: "sub-1" },
    });
  });

  it("extensionSubmissionReject forwards both submission_id and reason", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { submission_id: "sub-1", status: "rejected" },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    await client.extensionSubmissionReject({
      submission_id: "sub-1",
      reason: "missing license",
    });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-reject",
      arguments: { submission_id: "sub-1", reason: "missing license" },
    });
  });

  it("extensionSubmissionPromotionRetry forwards submission_id", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        submission_id: "sub-1",
        status: "approved",
        promotion_state: "in_flight",
        promotion_error: null,
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    await client.extensionSubmissionPromotionRetry({ submission_id: "sub-1" });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submission-promotion-retry",
      arguments: { submission_id: "sub-1" },
    });
  });

  it("extensionGet targets cinatra-extension-get and maps the snake_case wire to what the page reads (kind, latestVersion, currentVisibility)", async () => {
    // The live ability returns snake_case (current_visibility / latest_version /
    // kind). The page reads detail.kind, detail.latestVersion, detail.currentVisibility.
    callToolMock.mockResolvedValue({
      structuredContent: {
        package_name: "@cinatra-ai/blog-skills",
        name: "Blog skills",
        description: "Blog skills bundle",
        kind: "skill",
        category: "skill",
        latest_version: "0.1.0",
        vendor_slug: "cinatra-ai",
        icon_asset_url: null,
        publication_state: "published",
        current_visibility: "public",
        long_description: null,
        readme_markdown: "# Readme",
        marketplace_assets: [],
        license: "Apache-2.0",
        version_history: [{ version: "0.1.0", released_at: "2026-06-01T00:00:00Z", state: "approved" }],
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionGet({ packageName: "@cinatra-ai/blog-skills" });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-get",
      arguments: { packageName: "@cinatra-ai/blog-skills" },
    });
    // The three fields the page reads must be defined (snake → camel mapping ran).
    expect(out.kind).toBe("skill");
    expect(out.latestVersion).toBe("0.1.0");
    expect(out.currentVisibility).toBe("public");
    // Rest of the wire is mapped too.
    expect(out.packageName).toBe("@cinatra-ai/blog-skills");
    expect(out.vendorSlug).toBe("cinatra-ai");
    expect(out.publicationState).toBe("published");
    expect(out.readmeMarkdown).toBe("# Readme");
    expect(out.versionHistory).toEqual([
      { version: "0.1.0", releasedAt: "2026-06-01T00:00:00Z", state: "approved" },
    ]);
  });

  it("extensionGet maps current_visibility:'unknown' (200 not-found shape, null kind/version) → currentVisibility 'unknown' for the page to notFound()", async () => {
    // The ability returns 200 (NOT a 404 throw) for a missing/unlisted package,
    // with current_visibility:"unknown" and null kind/version. The page treats
    // currentVisibility !== "public" as notFound().
    callToolMock.mockResolvedValue({
      structuredContent: {
        package_name: "@scope/missing",
        name: null,
        kind: null,
        latest_version: null,
        current_visibility: "unknown",
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionGet({ packageName: "@scope/missing" });
    expect(out.currentVisibility).toBe("unknown");
    expect(out.latestVersion).toBeNull();
    // null kind coalesces to the legacy "agent" default in the mapper.
    expect(out.kind).toBe("agent");
  });

  it("extensionGet maps current_visibility:'private' → currentVisibility 'private' (not visible to this caller → page notFound())", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        package_name: "@scope/private-ext",
        name: "Private ext",
        kind: "agent",
        latest_version: "2.0.0",
        current_visibility: "private",
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionGet({ packageName: "@scope/private-ext" });
    expect(out.currentVisibility).toBe("private");
    // Even though it is "listed" with a version, "private" is NOT public → the
    // page's `detail.currentVisibility !== "public"` guard fires notFound().
    expect(out.currentVisibility === "public").toBe(false);
  });

  it("extensionGet defaults currentVisibility to 'unknown' when the wire omits the field entirely (fail-closed)", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        package_name: "@scope/no-visibility",
        kind: "agent",
        latest_version: "1.0.0",
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionGet({ packageName: "@scope/no-visibility" });
    // An absent visibility field is NOT treated as public — the page notFound()s.
    expect(out.currentVisibility).toBe("unknown");
  });

  it("extensionInstallAuthorize targets cinatra-extension-install-authorize with snake_case input", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        grant: "opaque.grant.value",
        kind: "agent",
        resolved_version: "1.2.3",
        broker_base_url: "https://marketplace.cinatra.ai/install/v1",
        closure: [{ name: "@scope/dep", version: "1.0.0" }],
        expires_at: "2026-06-04T00:02:00Z",
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.extensionInstallAuthorize({
      package_name: "@scope/ext",
      version: "1.2.3",
    });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-install-authorize",
      arguments: { package_name: "@scope/ext", version: "1.2.3" },
    });
    expect(out.grant).toBe("opaque.grant.value");
    expect(out.broker_base_url).toBe("https://marketplace.cinatra.ai/install/v1");
    expect(out.resolved_version).toBe("1.2.3");
    expect(out.closure).toEqual([{ name: "@scope/dep", version: "1.0.0" }]);
  });

  it("extensionGet not-found result yields MarketplaceMcpError with httpStatus 404 (structuredContent code)", async () => {
    callToolMock.mockResolvedValue({
      isError: true,
      structuredContent: { code: "not_found", message: "no such package" },
      content: [{ type: "text", text: "no such package" }],
    });
    const promise = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionGet({
      packageName: "@scope/missing",
    });
    await expect(promise).rejects.toBeInstanceOf(MarketplaceMcpError);
    await expect(promise).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("extensionGet not-found result yields httpStatus 404 from a JSON text block (no structuredContent)", async () => {
    callToolMock.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: '{"code":"rest_post_invalid_id","status":404}' }],
    });
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionGet({
        packageName: "@scope/missing",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("extensionGet non-not-found error keeps httpStatus 502 (no false-positive downgrade)", async () => {
    callToolMock.mockResolvedValue({
      isError: true,
      structuredContent: { code: "forbidden", status: 403 },
      content: [{ type: "text", text: "could not find a valid bearer token" }],
    });
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionGet({
        packageName: "@scope/ext",
      }),
    ).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("extensionInstallAuthorize propagates a tool isError as MarketplaceMcpError (denial)", async () => {
    callToolMock.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "not entitled" }],
    });
    await expect(
      createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" }).extensionInstallAuthorize({
        package_name: "@scope/ext",
        version: "1.2.3",
      }),
    ).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("instanceAttachSelf forwards the gatekept_install flag verbatim when supplied", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: {
        marketplace_user_id: 1,
        marketplace_username: "cinatra-instance-abc",
        marketplace_token: "tok",
        attached_at: "2026-06-04T00:00:00Z",
        rotated: false,
      },
    });
    const client = createHttpMarketplaceMcpClient({ baseUrl: "https://mk.test" });
    const out = await client.instanceAttachSelf({
      instance_id: "11111111-1111-4111-8111-111111111111",
      instance_attach_secret: "secret",
      display_name: "Inst",
      gatekept_install: true,
    });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-instance-attach-self",
      arguments: expect.objectContaining({ gatekept_install: true }),
    });
    // The gatekept-mode response omits verdaccio_* fields (optional on the type).
    expect(out.verdaccio_read_token).toBeUndefined();
    expect(out.verdaccio_username).toBeUndefined();
  });

  it("ignores a caller-supplied baseUrl in production (single hardcoded marketplace)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    callToolMock.mockResolvedValue({ structuredContent: {} });
    try {
      await createHttpMarketplaceMcpClient({ baseUrl: "https://evil.test" }).vendorGetSelf();
      const [url] = transportCtor.mock.calls[0];
      expect(url.toString()).toBe(`${MARKETPLACE_BASE_URL}/wp-json/cinatra/mcp`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("resolveMarketplaceBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors MARKETPLACE_BASE_URL override outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://localhost:8081/");
    expect(resolveMarketplaceBaseUrl()).toBe("http://localhost:8081");
  });

  it("ignores the override in production (single hardcoded marketplace)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://evil.test");
    expect(resolveMarketplaceBaseUrl()).toBe(MARKETPLACE_BASE_URL);
  });
});
