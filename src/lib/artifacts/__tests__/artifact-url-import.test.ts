/**
 * artifact-url-import lib service tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/artifact-url-import.test.ts
 *
 * WRITER CUTOVER (epic #1785, wave A3): URL import is now a SYNCHRONOUS
 * mime-map-or-refuse. It produces `text/markdown`, and no installed system-base
 * artifact pack (pdf/audio/video/image) accepts that MIME — so the import fails
 * CLOSED, BEFORE any network fetch, with `reason:"type-not-registered"`, and
 * never calls the writer. (The generic catch-all it used to land under is
 * retired; a text/document base pack would re-enable it via the same map.) The
 * SSRF / fetch-status paths in `url-import.ts` are covered by that module's own
 * tests; here the type refusal short-circuits before the fetch is attempted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSemanticArtifactMock, registerAllObjectTypesMock } = vi.hoisted(() => ({
  createSemanticArtifactMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
}));

vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
// No-op the heavy registry warm; with nothing registered the mime-map has no
// candidate for text/markdown and refuses — exactly the production posture until
// a text/document base pack ships.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
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
  <p>ACME Corp builds enterprise-grade gizmos for mid-market financial services firms across North America and Europe.</p>
</main></body>
</html>
`;

describe("importArtifactFromUrlService — mime-map-or-refuse (epic #1785 A3)", () => {
  beforeEach(() => {
    createSemanticArtifactMock.mockReset();
    registerAllObjectTypesMock.mockReset();
  });

  it("REFUSES a text/markdown URL import (no system-base pack accepts it) before fetching or writing", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(HAPPY_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await importArtifactFromUrlServiceForTest({
      url: "https://example.com/about",
      orgId: "org-a",
      actor: ACTOR,
      deps: { fetch: fetchSpy, dnsLookup: PUBLIC_DNS },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("type-not-registered");
    // Fail closed BEFORE the network fetch and BEFORE any writer call.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("refuses regardless of the target URL (the refusal is a static type property, not per-URL)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope"));
    const res = await importArtifactFromUrlServiceForTest({
      url: "http://192.168.1.50/admin",
      orgId: "org-a",
      actor: ACTOR,
      deps: { fetch: fetchSpy, dnsLookup: PUBLIC_DNS },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("type-not-registered");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});
