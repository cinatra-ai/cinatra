/**
 * "Add URL" cross-cutting lifecycle test.
 *
 * Verifies the pipeline from `importArtifactFromUrlServiceForTest`
 * down through `createSemanticArtifact`'s matcher enqueue. We mock
 * `createSemanticArtifact` itself to capture the matcher-enqueue
 * decision (the real writer's behavior — fallback classification stays
 * enabled for URL imports). The flow asserted:
 *
 *   1. URL → fetchUrlAsMarkdown completes (cheerio extracts markdown).
 *   2. createSemanticArtifact is called with:
 *        - declaredMime: text/markdown
 *        - originKind: external_link
 *        - skipFallbackClassification: false
 *      → matcher BullMQ job enqueue fires after the semantic artifact write.
 *   3. The matcher job payload carries the new artifactId — i.e. the
 *      matcher will classify the page on the next worker turn.
 *
 * This is a wiring-focused test: `createSemanticArtifact` is mocked, so the
 * real write transaction and production-path post-commit enqueue are not
 * exercised. This verifies fallback classification stays enabled on URL
 * imports. The bug it would catch is silently disabling classification.
 *
 *   npx vitest run src/app/artifacts/__tests__/add-url-lifecycle.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const HAPPY_HTML = `
<html>
<head><title>ACME Corp — Ideal Customer Profile</title></head>
<body>
  <main>
    <h1>ACME Corp Ideal Customer Profile</h1>
    <p>ACME's ideal customer is a VP of Engineering at a 500-2000 person fintech or insurance company. Buyer cares about uptime, regulatory compliance, and quarterly KPI delivery.</p>
    <h2>Buyer Persona</h2>
    <ul>
      <li>Role: VP of Engineering</li>
      <li>Company size: 500-2000 employees</li>
      <li>Industry: fintech or insurance</li>
    </ul>
    <h2>Pain Points</h2>
    <ul>
      <li>Downtime costs $50k+/hour</li>
      <li>Compliance audits every quarter</li>
      <li>KPI pressure from CFO</li>
    </ul>
  </main>
</body>
</html>
`;

beforeEach(() => {
  vi.resetModules();
});

const PUBLIC_DNS = async () => ({
  address: "93.184.216.34",
  family: 4 as const,
});

describe("Add URL lifecycle — through-the-service matcher enqueue", () => {
  it("URL → fetch → cheerio → createSemanticArtifact → matcher enqueue fires (skipFallbackClassification stays false)", async () => {
    const enqueueMatcherCalls: Array<{
      jobName: string;
      payload: Record<string, unknown>;
    }> = [];
    const createSemanticArtifactMock = vi.fn(
      async (input: Record<string, unknown>) => {
        const artifactId = "art-url-e2e-1";
        const representationRevisionId = "rep-url-e2e-1";
        if (!input.skipFallbackClassification) {
          enqueueMatcherCalls.push({
            jobName: "ARTIFACT_MATCH_RUN",
            payload: {
              orgId: input.orgId,
              artifactId,
              representationRevisionId,
              createdByRunId: input.createdByRunId ?? null,
            },
          });
        }
        return {
          objectId: artifactId,
          artifactId,
          resourceId: "res-url-e2e-1",
          representationRevisionId,
          representationRevision: 1,
          ref: { artifactId, representationRevisionId },
        };
      },
    );

    vi.doMock("../../../lib/artifacts/artifact-creation", () => ({
      createSemanticArtifact: createSemanticArtifactMock,
    }));

    // Use the test-only service entry point; the public service has no deps param.
    const { importArtifactFromUrlServiceForTest } = await import(
      "@/lib/artifacts/artifact-url-import"
    );

    const res = await importArtifactFromUrlServiceForTest({
      url: "https://acme.example.com/about",
      orgId: "org-acme",
      actor: {
        principalType: "HumanUser",
        principalId: "user-alice",
        organizationId: "org-acme",
        teamIds: [],
        projectIds: [],
        authSource: "ui",
        policyVersion: "v2",
      },
      deps: {
        fetch: async () =>
          new Response(HAPPY_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        dnsLookup: PUBLIC_DNS,
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-url-e2e-1");

    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    const writerCall = createSemanticArtifactMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(writerCall.orgId).toBe("org-acme");
    expect(writerCall.ownerLevel).toBe("organization");
    expect(writerCall.ownerId).toBe("org-acme");
    expect(writerCall.declaredMime).toBe("text/markdown");
    expect(writerCall.originKind).toBe("external_link");
    expect(writerCall.title).toBe("ACME Corp — Ideal Customer Profile");
    expect(writerCall.skipFallbackClassification).toBe(false);

    expect(enqueueMatcherCalls).toHaveLength(1);
    expect(enqueueMatcherCalls[0].jobName).toBe("ARTIFACT_MATCH_RUN");
    expect(enqueueMatcherCalls[0].payload).toEqual({
      orgId: "org-acme",
      artifactId: "art-url-e2e-1",
      representationRevisionId: "rep-url-e2e-1",
      createdByRunId: null,
    });
  });

  it("matcher enqueue does NOT fire on SSRF rejection (no orphan artifact rows)", async () => {
    const createSemanticArtifactMock = vi.fn();
    vi.doMock("../../../lib/artifacts/artifact-creation", () => ({
      createSemanticArtifact: createSemanticArtifactMock,
    }));
    const { importArtifactFromUrlServiceForTest } = await import(
      "@/lib/artifacts/artifact-url-import"
    );

    const res = await importArtifactFromUrlServiceForTest({
      url: "http://192.168.1.50/admin",
      orgId: "org-acme",
      actor: {
        principalType: "HumanUser",
        principalId: "user-alice",
        organizationId: "org-acme",
        teamIds: [],
        projectIds: [],
        authSource: "ui",
        policyVersion: "v2",
      },
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
});
