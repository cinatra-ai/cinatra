/**
 * "Add URL" cross-cutting lifecycle test — POST-retirement contract.
 *
 * WRITER CUTOVER (epic #1785, wave A3): the generic `@cinatra-ai/artifact:object`
 * catch-all is retired. Every artifact row now carries its EXACT declared object
 * type in `objects.type`, validated at the writer BEFORE any blob IO, and the
 * async LLM matcher that used to type an artifact AFTER it was persisted under
 * the generic type is GONE (it cannot type a row that must be typed at write
 * time). URL import is therefore a SYNCHRONOUS mime-map-or-refuse: it produces
 * `text/markdown`, and no installed system-base artifact pack
 * (pdf/audio/video/image) accepts that MIME — so per the ratified A3 design the
 * whole add-URL lifecycle FAILS CLOSED at the type boundary
 * (`reason: "type-not-registered"`), BEFORE any network fetch and BEFORE any
 * writer call. A text/document base pack would re-enable it via the same map.
 *
 * This test pins the app-layer lifecycle consequences of that retirement:
 *   1. A well-formed public URL still refuses at the type boundary — the refusal
 *      is a static type property, and NO artifact is written (no orphan rows)
 *      and NO matcher job is enqueued (the classification-at-creation path the
 *      original test guarded no longer exists — its premise is retired, not
 *      "silently disabled").
 *   2. The synchronous type refusal PRECEDES the SSRF / fetch guard: a
 *      private-IP URL returns `type-not-registered` (not `private-ip-blocked`),
 *      because resolution short-circuits before any network work. (The SSRF /
 *      fetch-status paths themselves are covered by `url-import.ts`'s own tests
 *      and the lib service test `artifact-url-import.test.ts`.)
 *
 * `createSemanticArtifact` is mocked purely to PROVE it is never called; the
 * registry warm is no-op'd so the mime-map deterministically has no candidate
 * for `text/markdown` — exactly the production posture until a text/document
 * base pack ships.
 *
 *   npx vitest run src/app/artifacts/__tests__/add-url-lifecycle.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { createSemanticArtifactMock, registerAllObjectTypesMock } = vi.hoisted(
  () => ({
    createSemanticArtifactMock: vi.fn(),
    registerAllObjectTypesMock: vi.fn(),
  }),
);

vi.mock("../../../lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
// No-op the heavy registry warm; with nothing registered the mime-map has no
// candidate for text/markdown and refuses — the production posture until a
// text/document base pack ships.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));

const HAPPY_HTML = `
<html>
<head><title>ACME Corp — Ideal Customer Profile</title></head>
<body>
  <main>
    <h1>ACME Corp Ideal Customer Profile</h1>
    <p>ACME's ideal customer is a VP of Engineering at a 500-2000 person fintech or insurance company.</p>
  </main>
</body>
</html>
`;

const ACTOR = {
  principalType: "HumanUser" as const,
  principalId: "user-alice",
  organizationId: "org-acme",
  teamIds: [],
  projectIds: [],
  authSource: "ui" as const,
  policyVersion: "v2" as const,
};

const PUBLIC_DNS = async () => ({
  address: "93.184.216.34",
  family: 4 as const,
});

describe("Add URL lifecycle — mime-map-or-refuse fails closed (epic #1785 A3)", () => {
  beforeEach(() => {
    vi.resetModules();
    createSemanticArtifactMock.mockReset();
    registerAllObjectTypesMock.mockReset();
  });

  it("URL → type boundary REFUSES (text/markdown maps to no base pack): no fetch, no writer, no matcher enqueue, no orphan rows", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(HAPPY_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const { importArtifactFromUrlServiceForTest } = await import(
      "@/lib/artifacts/artifact-url-import"
    );

    const res = await importArtifactFromUrlServiceForTest({
      url: "https://acme.example.com/about",
      orgId: "org-acme",
      actor: ACTOR,
      deps: { fetch: fetchSpy, dnsLookup: PUBLIC_DNS },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("type-not-registered");
    // Fail closed at the type boundary — BEFORE the network fetch and BEFORE
    // the writer. No artifact row is created, so there is nothing for a
    // post-persistence matcher to (formerly) classify: the matcher-enqueue
    // lifecycle is retired, not silently disabled.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("the synchronous type refusal PRECEDES the SSRF/fetch guard (private-IP URL still returns type-not-registered)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope"));

    const { importArtifactFromUrlServiceForTest } = await import(
      "@/lib/artifacts/artifact-url-import"
    );

    const res = await importArtifactFromUrlServiceForTest({
      url: "http://192.168.1.50/admin",
      orgId: "org-acme",
      actor: ACTOR,
      deps: { fetch: fetchSpy, dnsLookup: PUBLIC_DNS },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // type-not-registered, NOT private-ip-blocked: type resolution short-circuits
    // before any network work is attempted.
    expect(res.reason).toBe("type-not-registered");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });
});
