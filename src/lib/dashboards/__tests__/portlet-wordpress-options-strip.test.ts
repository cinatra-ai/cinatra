/**
 * loadWordpressInstanceOptions secret-stripping guard.
 * `listWordPressInstances()` returns full WordPressInstanceSettings (incl.
 * applicationPassword, siteUrl, username). The portlet loader MUST project to
 * { id, label } only — credentials never reach the client.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => ({ orgId: "sess-org", primitiveActor: {}, roleHints: undefined, actorContext: undefined })),
  resolvePortletPrimitiveActor: vi.fn(async () => ({ actorType: "human", source: "ui", userId: "u", orgId: "sess-org" })),
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
}));
vi.mock("@/lib/objects-store", () => ({ getObjectById: vi.fn(() => null) }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: vi.fn(async () => undefined) }));
vi.mock("@/lib/artifacts/artifact-authoring", () => ({ authorArtifact: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ getArtifact: vi.fn() }));
vi.mock("@/lib/blog/mcp/client/deterministic-client", () => ({ createDeterministicBlogContentClient: () => ({ post: { update: vi.fn() } }) }));
vi.mock("@cinatra-ai/agents/mcp-client", () => ({ createDeterministicAgentsClient: () => ({ agent: { run: vi.fn() } }) }));
vi.mock("@cinatra-ai/workflows/mcp-client", () => ({ createDeterministicWorkflowsClient: () => ({ template: { list: vi.fn(), get: vi.fn(), instantiate: vi.fn() } }) }));
vi.mock("@/lib/workflow-host-deps", () => ({ buildWorkflowHandlerDeps: () => ({}) }));
vi.mock("@/lib/wordpress-api", () => ({
  listWordPressInstances: vi.fn(async () => [
    {
      id: "wp-1",
      name: "Primary WP",
      siteUrl: "https://wp.example",
      username: "admin",
      applicationPassword: "TOP-SECRET-PASSWORD",
      blogConnectorId: "example-namespace",
    },
  ]),
}));

import { loadWordpressInstanceOptions } from "../portlet-actions";

describe("BCW-02 loadWordpressInstanceOptions — strips secrets", () => {
  it("returns ONLY { id, label } — never applicationPassword/username/siteUrl", async () => {
    const out = await loadWordpressInstanceOptions();
    expect(out).toEqual([{ id: "wp-1", label: "Primary WP" }]);
    // Belt-and-braces: any sensitive field is structurally absent.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("TOP-SECRET-PASSWORD");
    expect(serialized).not.toContain("applicationPassword");
    expect(serialized).not.toContain("admin");
    expect(serialized).not.toContain("wp.example");
  });
});
