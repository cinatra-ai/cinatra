// The merge proposal page's title is also the trail's leaf (cinatra#4453).
//
// The components drawing, Breadcrumb section: "While a name is genuinely
// unavailable, the crumb shows the id's first eight characters plus an ellipsis".
// The page used sixteen characters.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "viewer" },
    session: { activeOrganizationId: "org-1" },
  })),
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  isPlatformAdmin: () => true,
}));
vi.mock("@/lib/object-history", () => ({
  readMergeProposalById: vi.fn((id: string) => ({
    id,
    objectId: "object-1",
    objectType: "contact",
    baseVersion: 3,
    sourceKind: "import",
    status: "rejected",
    proposedFields: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({ actorFromSession: () => ({}) }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn(async () => undefined),
}));
vi.mock("@/lib/objects-store", () => ({
  getObjectById: vi.fn(() => ({ id: "object-1", orgId: "org-1", ownerLevel: "organization" })),
}));
vi.mock("@/components/data-safety/merge-proposal-actions", () => ({
  MergeProposalActions: () => null,
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-title={title} />,
}));

import MergeProposalDetailPage from "../artifacts/merge-proposals/[proposalId]/page";

const PROPOSAL_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";

describe("the merge proposal page title", () => {
  it("carries the id's first eight characters plus an ellipsis, and no more of it", async () => {
    const tree = await MergeProposalDetailPage({
      params: Promise.resolve({ proposalId: PROPOSAL_ID }),
    });
    const html = renderToStaticMarkup(tree as React.ReactElement);
    const title = /data-title="([^"]*)"/.exec(html)?.[1];
    expect(title).toBe(`Merge proposal ${PROPOSAL_ID.slice(0, 8)}…`);
    expect(title).not.toContain(PROPOSAL_ID.slice(0, 9));
  });
});
