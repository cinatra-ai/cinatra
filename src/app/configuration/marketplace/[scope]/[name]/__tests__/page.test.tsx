import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchPublicDetailMock,
  createHttpMarketplaceMcpClientMock,
  requireAdminSessionMock,
  registryEntryDetailSectionsMock,
  marketplaceDetailHeaderMock,
  marketplaceReadmeSectionMock,
  marketplaceReadmeMarkdownSectionMock,
  hasRenderableReadmeMarkdownMock,
  resolveDetailFreshnessAtMock,
  notFoundMock,
  MarketplaceMcpErrorStub,
} = vi.hoisted(() => {
  class MarketplaceMcpErrorStub extends Error {
    constructor(
      message: string,
      public httpStatus?: number,
      public responseBody?: string,
    ) {
      super(message);
      this.name = "MarketplaceMcpError";
    }
  }

  return {
    fetchPublicDetailMock: vi.fn(),
    createHttpMarketplaceMcpClientMock: vi.fn(),
    requireAdminSessionMock: vi.fn(),
    registryEntryDetailSectionsMock: vi.fn(),
    marketplaceDetailHeaderMock: vi.fn(),
    marketplaceReadmeSectionMock: vi.fn(),
    marketplaceReadmeMarkdownSectionMock: vi.fn(),
    hasRenderableReadmeMarkdownMock: vi.fn(),
    resolveDetailFreshnessAtMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    MarketplaceMcpErrorStub,
  };
});

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

vi.mock("@cinatra-ai/agents/screens", () => ({
  RegistryEntryDetailSections: registryEntryDetailSectionsMock,
}));

vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  fetchPublicMarketplaceExtensionDetail: fetchPublicDetailMock,
  createHttpMarketplaceMcpClient: createHttpMarketplaceMcpClientMock,
}));

vi.mock("@cinatra-ai/marketplace-mcp-client", () => ({
  MarketplaceMcpError: MarketplaceMcpErrorStub,
}));

vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/marketplace-detail-header", () => ({
  MarketplaceDetailHeader: marketplaceDetailHeaderMock,
  resolveDetailFreshnessAt: resolveDetailFreshnessAtMock,
}));

vi.mock("@/components/marketplace-readme-section", () => ({
  MarketplaceReadmeSection: marketplaceReadmeSectionMock,
  MarketplaceReadmeMarkdownSection: marketplaceReadmeMarkdownSectionMock,
  hasRenderableReadmeMarkdown: hasRenderableReadmeMarkdownMock,
}));

import ExtensionMarketplaceEntryPage from "../page";

function publicDetail(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "@cinatra-ai/web-research-agent",
    name: "@cinatra-ai/web-research-agent",
    description: "Research the web.",
    kind: "agent",
    category: "agent",
    latestVersion: "0.1.16",
    vendorSlug: "",
    iconAssetUrl: null,
    publicationState: "published",
    currentVisibility: "public",
    longDescription: null,
    readmeMarkdown: null,
    marketplaceAssets: [],
    license: null,
    versionHistory: [],
    ...overrides,
  };
}

/** Depth-first walk of a (non-rendered) React element tree collecting
 * elements whose type matches. Mocked child components (vi.fn — they carry a
 * `.mock` property) are treated as leaves so their elements stay in the tree
 * as-is; plain local function components (e.g. the page's non-agent body) are
 * expanded by invoking them with their props. */
function findElementsByType(node: unknown, type: unknown): ReactElement[] {
  const found: ReactElement[] = [];
  const isMockFn = (fn: unknown): boolean =>
    typeof fn === "function" && Object.prototype.hasOwnProperty.call(fn, "mock");
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") {
      return;
    }
    const el = current as ReactElement & { props?: { children?: unknown } };
    if (el.type === type) {
      found.push(el);
    }
    if (typeof el.type === "function" && !isMockFn(el.type) && el.type !== type) {
      visit((el.type as (props: unknown) => unknown)(el.props));
      return;
    }
    if (el.props && "children" in el.props) {
      visit(el.props.children);
    }
  };
  visit(node);
  return found;
}

describe("ExtensionMarketplaceEntryPage", () => {
  beforeEach(() => {
    fetchPublicDetailMock.mockReset();
    createHttpMarketplaceMcpClientMock.mockReset();
    requireAdminSessionMock.mockReset();
    registryEntryDetailSectionsMock.mockReset();
    marketplaceDetailHeaderMock.mockReset();
    marketplaceReadmeSectionMock.mockReset();
    marketplaceReadmeMarkdownSectionMock.mockReset();
    hasRenderableReadmeMarkdownMock.mockReset();
    resolveDetailFreshnessAtMock.mockReset();
    notFoundMock.mockClear();
    requireAdminSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
    resolveDetailFreshnessAtMock.mockReturnValue("2026-06-01T00:00:00.000Z");
    // Default to the real helper's happy-path shape: any non-blank markdown
    // counts as renderable. The sanitized-empty edge overrides per test.
    hasRenderableReadmeMarkdownMock.mockImplementation(
      (markdown: string | null | undefined) => (markdown ?? "").trim() !== "",
    );
  });

  it("uses the anonymous public detail endpoint for the marketplace preflight", async () => {
    fetchPublicDetailMock.mockResolvedValue(publicDetail());

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "web-research-agent" }),
    });

    expect(requireAdminSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchPublicDetailMock).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/web-research-agent",
    });
    expect(createHttpMarketplaceMcpClientMock).not.toHaveBeenCalled();
    const sections = findElementsByType(result, registryEntryDetailSectionsMock);
    expect(sections).toHaveLength(1);
    expect(sections[0].props).toMatchObject({
      packageName: "@cinatra-ai/web-research-agent",
      listedVersion: "0.1.16",
      readmeMarkdown: null,
    });
  });

  it("threads the marketplace readmeMarkdown into the agent detail sections", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({ readmeMarkdown: "# Acme Agent\n\nFull readme body." }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "web-research-agent" }),
    });

    const sections = findElementsByType(result, registryEntryDetailSectionsMock);
    expect(sections).toHaveLength(1);
    // The agent sections receive the marketplace-sourced README — the same
    // field the public Description tab renders — so the primary body never
    // falls back to Verdaccio's entry.readme.
    expect(sections[0].props).toMatchObject({
      packageName: "@cinatra-ai/web-research-agent",
      readmeMarkdown: "# Acme Agent\n\nFull readme body.",
    });
  });

  it("renders the marketplace hero shell from the fetched ExtensionDetail for agents", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({
        name: "Web Research Agent",
        license: "Apache-2.0",
        versionHistory: [
          { version: "0.1.16", releasedAt: "2026-05-01T00:00:00Z", state: "approved" },
        ],
      }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "web-research-agent" }),
    });

    const headers = findElementsByType(result, marketplaceDetailHeaderMock);
    expect(headers).toHaveLength(1);
    expect(headers[0].props).toMatchObject({
      packageName: "@cinatra-ai/web-research-agent",
      name: "Web Research Agent",
      kind: "agent",
      license: "Apache-2.0",
      version: "0.1.16",
      // Freshness is derived by the shared helper from the SAME detail payload.
      freshnessAt: "2026-06-01T00:00:00.000Z",
    });
    expect(resolveDetailFreshnessAtMock).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: "0.1.16" }),
    );
  });

  it("renders the same hero + README slot (no agent sections) for non-agent kinds", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({
        name: "Slide Deck Skill",
        kind: "skill",
        license: "MIT",
        longDescription: "Builds slide decks from briefs.",
      }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "slide-deck-skill" }),
    });

    const headers = findElementsByType(result, marketplaceDetailHeaderMock);
    expect(headers).toHaveLength(1);
    expect(headers[0].props).toMatchObject({
      name: "Slide Deck Skill",
      kind: "skill",
      license: "MIT",
    });

    // Non-agent kinds render purely from the marketplace detail — they must
    // never route through the Verdaccio-backed agent sections.
    expect(findElementsByType(result, registryEntryDetailSectionsMock)).toHaveLength(0);
    expect(registryEntryDetailSectionsMock).not.toHaveBeenCalled();

    // README slot occupies the primary body, fed by the marketplace text.
    const readmeSlots = findElementsByType(result, marketplaceReadmeSectionMock);
    expect(readmeSlots).toHaveLength(1);
    const slotHtml = JSON.stringify(readmeSlots[0].props);
    expect(slotHtml).toContain("Builds slide decks from briefs.");
  });

  it("renders the marketplace readmeMarkdown as the non-agent primary body, over the plain-text fallback", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({
        kind: "skill",
        longDescription: "Plain fallback text.",
        readmeMarkdown: "# Slide Deck Skill\n\nFull readme body.",
      }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "slide-deck-skill" }),
    });

    // The markdown README (the field the public Description tab renders)
    // takes the primary-body slot...
    const markdownSlots = findElementsByType(
      result,
      marketplaceReadmeMarkdownSectionMock,
    );
    expect(markdownSlots).toHaveLength(1);
    expect(markdownSlots[0].props).toMatchObject({
      markdown: "# Slide Deck Skill\n\nFull readme body.",
    });
    // ...and the plain-text fallback section does not also render.
    expect(findElementsByType(result, marketplaceReadmeSectionMock)).toHaveLength(0);
  });

  it("falls back to the plain-text description when the README sanitizes down to nothing", async () => {
    // e.g. a README consisting solely of raw HTML — non-blank as a string,
    // but the sanitizing renderer strips it to empty output.
    hasRenderableReadmeMarkdownMock.mockReturnValue(false);
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({
        kind: "skill",
        longDescription: "Plain fallback text.",
        readmeMarkdown: "<div><script>x</script></div>",
      }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "slide-deck-skill" }),
    });

    expect(
      findElementsByType(result, marketplaceReadmeMarkdownSectionMock),
    ).toHaveLength(0);
    const readmeSlots = findElementsByType(result, marketplaceReadmeSectionMock);
    expect(readmeSlots).toHaveLength(1);
    expect(JSON.stringify(readmeSlots[0].props)).toContain("Plain fallback text.");
  });

  it("omits the README slot cleanly when a non-agent listing has no descriptive text", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({
        kind: "connector",
        description: null,
        longDescription: null,
        readmeMarkdown: null,
      }),
    );

    const result = await ExtensionMarketplaceEntryPage({
      params: Promise.resolve({ scope: "cinatra-ai", name: "bare-connector" }),
    });

    expect(findElementsByType(result, marketplaceReadmeSectionMock)).toHaveLength(0);
    expect(
      findElementsByType(result, marketplaceReadmeMarkdownSectionMock),
    ).toHaveLength(0);
    expect(findElementsByType(result, marketplaceDetailHeaderMock)).toHaveLength(1);
  });

  it("maps public detail 404 to notFound with no authenticated fallback", async () => {
    fetchPublicDetailMock.mockRejectedValue(
      new MarketplaceMcpErrorStub("missing", 404, ""),
    );

    await expect(
      ExtensionMarketplaceEntryPage({
        params: Promise.resolve({ scope: "cinatra-ai", name: "missing" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(fetchPublicDetailMock).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/missing",
    });
    expect(createHttpMarketplaceMcpClientMock).not.toHaveBeenCalled();
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a malformed public detail payload is not public", async () => {
    fetchPublicDetailMock.mockResolvedValue(
      publicDetail({ currentVisibility: "unknown" }),
    );

    await expect(
      ExtensionMarketplaceEntryPage({
        params: Promise.resolve({ scope: "cinatra-ai", name: "hidden" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(createHttpMarketplaceMcpClientMock).not.toHaveBeenCalled();
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
