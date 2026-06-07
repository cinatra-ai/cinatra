/**
 * artifact-url-import lib service tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/artifact-url-import.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSemanticArtifactMock } = vi.hoisted(() => ({
  createSemanticArtifactMock: vi.fn(),
}));

vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));

import { importArtifactFromUrlServiceForTest } from "../artifact-url-import";
import type { ActorContext } from "@/lib/authz/actor-context";

const ACTOR: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-a",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

const PUBLIC_DNS = async () => ({
  address: "93.184.216.34",
  family: 4 as const,
});

const HAPPY_HTML = `
<html>
<head><title>ACME — About</title></head>
<body><main>
  <h1>About ACME</h1>
  <p>ACME Corp builds enterprise-grade gizmos for mid-market financial services firms across North America and Europe. We have 250 employees and a track record of serving banking and insurance customers.</p>
</main></body>
</html>
`;

describe("importArtifactFromUrlService — happy path", () => {
  beforeEach(() => {
    createSemanticArtifactMock.mockReset();
    createSemanticArtifactMock.mockResolvedValue({
      objectId: "art-url-1",
      artifactId: "art-url-1",
      resourceId: "res-url-1",
      representationRevisionId: "rep-url-1",
      representationRevision: 1,
      ref: { artifactId: "art-url-1", representationRevisionId: "rep-url-1" },
    });
  });

  it("writes via createSemanticArtifact with the canonical artifact shape", async () => {
    const res = await importArtifactFromUrlServiceForTest({
      url: "https://example.com/about",
      orgId: "org-a",
      actor: ACTOR,
      deps: {
        fetch: async () =>
          new Response(HAPPY_HTML, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        dnsLookup: PUBLIC_DNS,
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-url-1");
    expect(res.representationRevisionId).toBe("rep-url-1");
    expect(res.title).toBe("ACME — About");
    expect(res.finalUrl).toBe("https://example.com/about");

    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    const call = createSemanticArtifactMock.mock.calls[0][0];
    // Four-tier ownership, org-level for URL imports.
    expect(call.orgId).toBe("org-a");
    expect(call.ownerLevel).toBe("organization");
    expect(call.ownerId).toBe("org-a");
    expect(call.createdBy).toBe("user-1");
    // text/markdown so matchers that gate on markdown can fire.
    expect(call.declaredMime).toBe("text/markdown");
    // URL imports get the `external_link` origin.
    expect(call.originKind).toBe("external_link");
    // URL imports must allow matchers to run; that's the entire point of Add URL.
    expect(call.skipFallbackClassification).toBe(false);
    // Title pulled from <title>.
    expect(call.title).toBe("ACME — About");
    // 5 MiB writer cap.
    expect(call.maxBytes).toBe(5 * 1024 * 1024);
  });
});

describe("importArtifactFromUrlService — error paths (NO artifact write)", () => {
  beforeEach(() => {
    createSemanticArtifactMock.mockReset();
  });

  it("returns the fetch error verbatim when SSRF gate fires", async () => {
    const res = await importArtifactFromUrlServiceForTest({
      url: "http://192.168.1.50/admin",
      orgId: "org-a",
      actor: ACTOR,
      deps: {
        fetch: async () => new Response("nope"),
        dnsLookup: PUBLIC_DNS,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("private-ip-blocked");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("returns the fetch error verbatim on bad-status", async () => {
    const res = await importArtifactFromUrlServiceForTest({
      url: "https://example.com/missing",
      orgId: "org-a",
      actor: ACTOR,
      deps: {
        fetch: async () => new Response("not found", { status: 404 }),
        dnsLookup: PUBLIC_DNS,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("bad-status");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("returns no-readable-content on SPA shell", async () => {
    const res = await importArtifactFromUrlServiceForTest({
      url: "https://spa.example.com/",
      orgId: "org-a",
      actor: ACTOR,
      deps: {
        fetch: async () =>
          new Response(
            `<html><head><title>App</title></head><body><div id="root"></div></body></html>`,
            { status: 200, headers: { "content-type": "text/html" } },
          ),
        dnsLookup: PUBLIC_DNS,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-readable-content");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});
