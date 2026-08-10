import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  CAPTURE_SERVE_MAX_BYTES,
  decideCaptureCapabilityServe,
  isSameOriginImageFetch,
  type CaptureServePorts,
} from "@/lib/lifecycle/capture-capability-serving";
import {
  mintCaptureCapability,
  type CaptureCapabilityPayload,
} from "@/lib/lifecycle/capture-capability";
import type { LiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

// ---------------------------------------------------------------------------
// The whole admission ladder, proven without a database, a browser or a route.
// Every arm below is a way the picture must NOT be served; the one happy path
// is the only combination that yields bytes.
// ---------------------------------------------------------------------------

const NOW = 1_000;

const PAYLOAD: CaptureCapabilityPayload = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
  runId: "run-1",
  reviewTaskId: "gate-A",
  captureArtifactId: "cap-A",
  representationRevisionId: "png-A",
};

const LIVE: LiveWidgetCapturePrincipal = {
  userId: "user-1",
  orgId: "org-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
  siteOrigin: "https://blog.example.com",
};

/** The gate's own frozen pinned target, and the capture bound to it. */
const GATE_A_TARGET = { artifactId: "art-A", representationRevisionId: "rev-A" };

function imageHeaders(overrides: Record<string, string | null> = {}): Headers {
  const h = new Headers({
    "sec-fetch-dest": "image",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "no-cors",
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return h;
}

function makePorts(overrides: Partial<CaptureServePorts> = {}): CaptureServePorts {
  return {
    readLivePrincipal: vi.fn(() => LIVE),
    runReadAccess: vi.fn(async () => true),
    readGatePinnedTargets: vi.fn(async () => [GATE_A_TARGET]),
    readCapture: vi.fn(() => ({
      representationRevisionId: "png-A",
      boundArtifactId: GATE_A_TARGET.artifactId,
      boundSnapshotRevisionId: GATE_A_TARGET.representationRevisionId,
      status: "captured" as const,
    })),
    resolveServe: vi.fn(() => ({
      mime: "image/png",
      storageKey: "blobs/aa/bb",
      sizeBytes: 4096,
    })),
    ...overrides,
  };
}

describe("capture capability serving", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;
  let sealed: string;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-capture-serving";
    sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: NOW })!;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  const decide = (
    ports: CaptureServePorts,
    opts: { headers?: Headers; capability?: string | null; nowSeconds?: number } = {},
  ) =>
    decideCaptureCapabilityServe({
      encodedCapability: opts.capability === undefined ? sealed : opts.capability,
      headers: opts.headers ?? imageHeaders(),
      ports,
      nowSeconds: opts.nowSeconds ?? NOW,
    });

  it("serves the capture on the one admissible combination", async () => {
    const decision = await decide(makePorts());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.serve).toEqual({
        mime: "image/png",
        storageKey: "blobs/aa/bb",
        sizeBytes: 4096,
      });
      expect(decision.capability.captureArtifactId).toBe("cap-A");
    }
  });

  // -------------------------------------------------------------------------
  // Rung 1 — transport shape. It closes BROWSER-DRIVEN misuse and nothing more,
  // and the last test in this block says so out loud so no reader mistakes the
  // rung for a proof of origin.
  // -------------------------------------------------------------------------

  describe("transport shape", () => {
    it("accepts only a same-origin IMAGE subresource load", () => {
      expect(isSameOriginImageFetch(imageHeaders())).toBe(true);
    });

    it("REFUSES a pasted link — a top-level navigation is dest=document, site=none", async () => {
      const pasted = imageHeaders({
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      });
      const ports = makePorts();
      expect((await decide(ports, { headers: pasted })).ok).toBe(false);
      // And it refuses BEFORE touching a store — a refused shape costs nothing.
      expect(ports.readLivePrincipal).not.toHaveBeenCalled();
    });

    it("REFUSES the CMS site mounting the URL cross-origin", async () => {
      for (const site of ["cross-site", "same-site"]) {
        const ports = makePorts();
        expect((await decide(ports, { headers: imageHeaders({ "sec-fetch-site": site }) })).ok).toBe(
          false,
        );
        expect(ports.readLivePrincipal).not.toHaveBeenCalled();
      }
    });

    it("REFUSES a replay that sends no Sec-Fetch headers at all (the casual case)", async () => {
      const ports = makePorts();
      const bare = imageHeaders({
        "sec-fetch-dest": null,
        "sec-fetch-site": null,
        "sec-fetch-mode": null,
      });
      expect((await decide(ports, { headers: bare })).ok).toBe(false);
      expect(ports.readLivePrincipal).not.toHaveBeenCalled();
    });

    it("HONEST LIMIT: a deliberate replay that FORGES the headers passes this rung", async () => {
      // Fetch Metadata is set by the browser and unforgeable BY A PAGE — it is
      // not unforgeable by a party who holds the URL and writes the request by
      // hand. This test exists so the limit is recorded in the suite rather than
      // implied by a passing "non-browser replay is refused" test that only ever
      // tried the easy case.
      //
      // What actually bounds this replay is the rest of the ladder: the sealed
      // capability dies in five minutes, the live principal probe is the
      // revocation edge, run access is re-checked, and the gate must vouch for
      // the capture. A forged-header replay therefore gets only what the
      // still-authorized reader could have got in that window — and nothing at
      // all once any of those change.
      const forged = new Headers({
        "sec-fetch-dest": "image",
        "sec-fetch-site": "same-origin",
      });
      expect(isSameOriginImageFetch(forged)).toBe(true);
      expect((await decide(makePorts(), { headers: forged })).ok).toBe(true);

      // ...and every later rung still bites on exactly that request.
      expect(
        (await decide(makePorts({ readLivePrincipal: vi.fn(() => null) }), { headers: forged })).ok,
      ).toBe(false);
      expect(
        (await decide(makePorts({ runReadAccess: vi.fn(async () => false) }), { headers: forged }))
          .ok,
      ).toBe(false);
      expect(
        (await decide(makePorts(), { headers: forged, nowSeconds: NOW + 10_000 })).ok,
      ).toBe(false);
    });

    it("REFUSES a contradictory shape (image dest claimed on a navigation)", () => {
      expect(isSameOriginImageFetch(imageHeaders({ "sec-fetch-mode": "navigate" }))).toBe(false);
    });

    it("REFUSES a non-image destination even same-origin (iframe / fetch / script)", () => {
      for (const dest of ["iframe", "empty", "script", "object", "document"]) {
        expect(isSameOriginImageFetch(imageHeaders({ "sec-fetch-dest": dest }))).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Rung 2 — the capability itself.
  // -------------------------------------------------------------------------

  it("REFUSES a missing, empty, forged or EXPIRED capability", async () => {
    for (const capability of [null, "", "forged-value", "!!!"]) {
      expect((await decide(makePorts(), { capability })).ok).toBe(false);
    }
    expect((await decide(makePorts(), { nowSeconds: NOW + 10_000 })).ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Rung 3 — the live principal. This is the REVOKED arm.
  // -------------------------------------------------------------------------

  it("REFUSES when the cwu_ row behind the sealed jti is gone (logout / revoke / rotate)", async () => {
    const ports = makePorts({ readLivePrincipal: vi.fn(() => null) });
    expect((await decide(ports)).ok).toBe(false);
    expect(ports.runReadAccess).not.toHaveBeenCalled();
  });

  it("REFUSES when the live binding has MOVED under the capability", async () => {
    const drifts: Array<Partial<LiveWidgetCapturePrincipal>> = [
      { userId: "someone-else" },
      { orgId: "org-2" },
      { siteId: "site-2" },
      { client: "drupal" },
      { instanceId: "inst-2" },
      // The agent bind `consumeUserWidgetToken` enforces as `agent_mismatch`.
      { agentSlug: "another-widget-agent" },
    ];
    for (const drift of drifts) {
      const ports = makePorts({
        readLivePrincipal: vi.fn(() => ({ ...LIVE, ...drift })),
      });
      expect((await decide(ports)).ok).toBe(false);
      expect(ports.runReadAccess).not.toHaveBeenCalled();
    }
  });

  // -------------------------------------------------------------------------
  // Rung 4 — live run read access.
  // -------------------------------------------------------------------------

  it("REFUSES a reader who lost run access between the mint and the fetch", async () => {
    const ports = makePorts({ runReadAccess: vi.fn(async () => false) });
    expect((await decide(ports)).ok).toBe(false);
    // Gate existence is never probed for a reader with no run access.
    expect(ports.readGatePinnedTargets).not.toHaveBeenCalled();
  });

  it("runs the access check as the SEALED principal, on the SEALED run", async () => {
    const ports = makePorts();
    await decide(ports);
    expect(ports.runReadAccess).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "user-1",
      orgId: "org-1",
    });
  });

  // -------------------------------------------------------------------------
  // Rung 5 — THE GATE SCOPE. #2576's headline acceptance criterion.
  // -------------------------------------------------------------------------

  it("a capability minted for gate A CANNOT fetch gate B's capture", async () => {
    // Gate B is a real gate with a real capture; the capability is gate A's.
    // The sealed capture id resolves to a capture bound to gate B's target, and
    // gate A's frozen pinned set does not contain it.
    const ports = makePorts({
      readGatePinnedTargets: vi.fn(async () => [GATE_A_TARGET]),
      readCapture: vi.fn(() => ({
        representationRevisionId: "png-B",
        boundArtifactId: "art-B",
        boundSnapshotRevisionId: "rev-B",
        status: "captured" as const,
      })),
    });
    expect((await decide(ports)).ok).toBe(false);
    // Refused BEFORE any blob resolution — no bytes are even located.
    expect(ports.resolveServe).not.toHaveBeenCalled();
  });

  it("REFUSES when the gate is gone or pins nothing", async () => {
    for (const targets of [null, []]) {
      const ports = makePorts({ readGatePinnedTargets: vi.fn(async () => targets) });
      expect((await decide(ports)).ok).toBe(false);
      expect(ports.resolveServe).not.toHaveBeenCalled();
    }
  });

  it("REFUSES a sealed artifact id that is not a capture row at all", async () => {
    // The store read is org- AND type-scoped, so an ordinary artifact simply
    // does not come back. This is the arm that confines the route to captures.
    const ports = makePorts({ readCapture: vi.fn(() => null) });
    expect((await decide(ports)).ok).toBe(false);
    expect(ports.resolveServe).not.toHaveBeenCalled();
  });

  it("reads the capture SCOPED TO THE SEALED ORG, never a request-supplied one", async () => {
    const ports = makePorts();
    await decide(ports);
    expect(ports.readCapture).toHaveBeenCalledWith("org-1", "cap-A");
  });

  // -------------------------------------------------------------------------
  // Rung 6 — the bytes really are this capture's own stored PNG.
  // -------------------------------------------------------------------------

  it("REFUSES a DEGRADED capture (there are no bytes to serve)", async () => {
    const ports = makePorts({
      readCapture: vi.fn(() => ({
        representationRevisionId: null,
        boundArtifactId: GATE_A_TARGET.artifactId,
        boundSnapshotRevisionId: GATE_A_TARGET.representationRevisionId,
        status: "degraded" as const,
      })),
    });
    expect((await decide(ports)).ok).toBe(false);
    expect(ports.resolveServe).not.toHaveBeenCalled();
  });

  it("REFUSES a revision the capability did not seal (no swapping revisions in-gate)", async () => {
    const ports = makePorts({
      readCapture: vi.fn(() => ({
        representationRevisionId: "png-OTHER",
        boundArtifactId: GATE_A_TARGET.artifactId,
        boundSnapshotRevisionId: GATE_A_TARGET.representationRevisionId,
        status: "captured" as const,
      })),
    });
    expect((await decide(ports)).ok).toBe(false);
    expect(ports.resolveServe).not.toHaveBeenCalled();
  });

  it("REFUSES bytes whose resolved representation is not image/png", async () => {
    for (const mime of ["text/html", "image/svg+xml", "application/javascript", "application/pdf"]) {
      const ports = makePorts({
        resolveServe: vi.fn(() => ({ mime, storageKey: "k", sizeBytes: 10 })),
      });
      expect((await decide(ports)).ok).toBe(false);
    }
  });

  it("REFUSES bytes that could not be resolved, or that exceed the capture cap", async () => {
    expect((await decide(makePorts({ resolveServe: vi.fn(() => null) }))).ok).toBe(false);
    const oversized = makePorts({
      resolveServe: vi.fn(() => ({
        mime: "image/png",
        storageKey: "k",
        sizeBytes: CAPTURE_SERVE_MAX_BYTES + 1,
      })),
    });
    expect((await decide(oversized)).ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A failure is never an oracle.
  // -------------------------------------------------------------------------

  it("a THROWING port is a refusal, not an exception", async () => {
    const throwers: Array<Partial<CaptureServePorts>> = [
      {
        readLivePrincipal: vi.fn(() => {
          throw new Error("db down");
        }),
      },
      {
        runReadAccess: vi.fn(async () => {
          throw new Error("authz down");
        }),
      },
      {
        readGatePinnedTargets: vi.fn(async () => {
          throw new Error("gate store down");
        }),
      },
      {
        readCapture: vi.fn(() => {
          throw new Error("capture store down");
        }),
      },
      {
        resolveServe: vi.fn(() => {
          throw new Error("resolver down");
        }),
      },
    ];
    for (const thrower of throwers) {
      await expect(decide(makePorts(thrower))).resolves.toEqual({ ok: false });
    }
  });

  it("every refusal is byte-identical — the result carries no reason at all", async () => {
    const arms = [
      decide(makePorts(), { headers: imageHeaders({ "sec-fetch-site": "cross-site" }) }),
      decide(makePorts(), { capability: "forged" }),
      decide(makePorts({ readLivePrincipal: vi.fn(() => null) })),
      decide(makePorts({ runReadAccess: vi.fn(async () => false) })),
      decide(makePorts({ readGatePinnedTargets: vi.fn(async () => null) })),
      decide(makePorts({ readCapture: vi.fn(() => null) })),
      decide(makePorts({ resolveServe: vi.fn(() => null) })),
    ];
    for (const arm of await Promise.all(arms)) {
      expect(arm).toEqual({ ok: false });
      expect(Object.keys(arm)).toEqual(["ok"]);
    }
  });
});
