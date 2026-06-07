import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchPublicDetailMock,
  createHttpMarketplaceMcpClientMock,
  requireAdminSessionMock,
  registryEntryDetailScreenMock,
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
    registryEntryDetailScreenMock: vi.fn(),
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
  RegistryEntryDetailScreen: registryEntryDetailScreenMock,
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

vi.mock("@/components/page-header", () => ({
  PageHeader: () => null,
}));

vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: ReactNode }) => children,
  AlertDescription: ({ children }: { children: ReactNode }) => children,
  AlertTitle: ({ children }: { children: ReactNode }) => children,
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

describe("ExtensionMarketplaceEntryPage", () => {
  beforeEach(() => {
    fetchPublicDetailMock.mockReset();
    createHttpMarketplaceMcpClientMock.mockReset();
    requireAdminSessionMock.mockReset();
    registryEntryDetailScreenMock.mockReset();
    notFoundMock.mockClear();
    requireAdminSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
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
    expect(result).toMatchObject({
      type: registryEntryDetailScreenMock,
      props: {
        packageName: "@cinatra-ai/web-research-agent",
        listedVersion: "0.1.16",
      },
    });
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
