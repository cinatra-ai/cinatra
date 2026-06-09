import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchPublicDetailMock,
  createHttpMarketplaceMcpClientMock,
  requireAdminSessionMock,
  registryEntryDetailSectionsMock,
  marketplaceDetailHeaderMock,
  marketplaceReadmeSectionMock,
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
    resolveDetailFreshnessAtMock.mockReset();
    notFoundMock.mockClear();
    requireAdminSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
    resolveDetailFreshnessAtMock.mockReturnValue("2026-06-01T00:00:00.000Z");
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
