/**
 * The artifact-review PREPARATION core (cinatra#1795, epic #1620 S12, item 2;
 * AC-1). Proves the authz + never-blank matrix over injected ports: gate
 * provenance (run access + pending gate), NO client target substitution, per-
 * target floors for unknown/tombstoned + read-denied + non-member-revision +
 * requires-rebuild, and the host-resolved build-map / runtime mounts.
 */
import { describe, expect, it, vi } from "vitest";

import type { ArtifactRendererProps } from "../artifact-renderer-props";
import type { ArtifactSummary } from "../artifact-service";
import type { SerializedRuntimeRendererDescriptor } from "../runtime-renderer-descriptor";
import {
  prepareReviewTargetsCore,
  type PrepareReviewPorts,
  type ResolvedRendererMount,
} from "../artifact-review-preparation";
import type { ArtifactReviewTarget } from "../artifact-review-target";

const t = (a: string, r: string): ArtifactReviewTarget => ({ artifactId: a, representationRevisionId: r });

function fakeArtifact(id: string): ArtifactSummary {
  return {
    artifactId: id,
    objectType: "@cinatra-ai/artifact:object",
    effectiveIdentity: { kind: "extension", extension: "@x/ext" },
  } as unknown as ArtifactSummary;
}

function fakeProps(): ArtifactRendererProps {
  return {
    propsApiVersion: 1,
    edit: { kind: "read-only" as const, channelVersion: 1, reason: "read-only-surface" as const },
    artifact: {
      id: "art",
      title: "t",
      objectType: "@cinatra-ai/artifact:object",
      mime: "application/json",
      size: 1,
      createdAt: "",
      updatedAt: "",
      ownerLevel: "organization",
      visibility: "organization",
      sourceUrl: null,
    },
    representation: { revisionId: "rev", mime: "application/json" },
    urls: { preview: "/p", download: "/d" },
    identity: { kind: "extension", extension: "@x/ext" },
    actions: { download: "/d", openInSource: null },
    // The content channel (enabler 0.3, cinatra#3027). This fixture predates it
    // and draws from the byte hrefs above, so it carries the NAMED absence — the
    // same answer the props builder yields for a caller that has not built a
    // projection.
    content: { kind: "none", channelVersion: 1, representationRevisionId: "rev", reason: "absent" },
  };
}

function descriptor(): SerializedRuntimeRendererDescriptor {
  return {
    digestPinnedUrl: "/api/artifact-renderer-assets/x",
    tuple: {
      packageName: "@x/ext",
      slot: "detail",
      digest: "d".repeat(64),
      entry: "client/detail.js",
      propsApiVersion: 1,
      edit: { kind: "read-only" as const, channelVersion: 1, reason: "read-only-surface" as const },
      sdkAbiRange: "^2.4.0",
      reactPeerRange: "^19.0.0",
      reactDomPeerRange: "^19.0.0",
      tokenModuleAbi: "1.0.0",
    },
  } as SerializedRuntimeRendererDescriptor;
}

/** Ports that all PASS by default; each test overrides the seam under test. */
function ports(over: Partial<PrepareReviewPorts> = {}): PrepareReviewPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    readGatePinnedTargets: async () => ({ status: "pending", targets: [t("a", "1"), t("b", "2")] }),
    readArtifact: (id) => ({ kind: "ok", artifact: fakeArtifact(id) }),
    revisionMember: () => ({ mime: "application/json" }),
    resolveMount: (): ResolvedRendererMount => ({ kind: "build-map", packageName: "@x/ext", generatedKey: "@x/ext::detail" }),
    buildProps: () => fakeProps(),
    ...over,
  };
}

describe("prepareReviewTargetsCore — gate provenance (hard failures, before any target read)", () => {
  it("run-access denied → error, and no artifact read is attempted", async () => {
    const readArtifact = vi.fn(() => ({ kind: "ok" as const, artifact: fakeArtifact("a") }));
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ verifyRunAccess: async () => ({ ok: false, status: 403 }), readArtifact }),
    );
    expect(r).toEqual({ ok: false, error: { kind: "run-access-denied", status: 403 } });
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("non-pending gate → gate-not-pending", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ readGatePinnedTargets: async () => ({ status: "not-pending" }) }),
    );
    expect(r).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
  });

  it("absent gate is folded into gate-not-pending (existence not leaked)", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ readGatePinnedTargets: async () => ({ status: "not-found" }) }),
    );
    expect(r).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
  });

  // "A resolved gate opens read-only: what was decided, and the reviewed
  // target(s), kept for the run's audit trail." The history reading prepares a
  // decided gate's frozen set through THIS core — and only when it asks.
  it("a RESOLVED gate stays closed unless the caller asked for the read-only history", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({
        readGatePinnedTargets: async () => ({ status: "resolved", targets: [t("a", "1")] }),
      }),
    );
    expect(r).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
  });

  it("a RESOLVED gate's frozen set is prepared for the read-only history reading", async () => {
    const r = await prepareReviewTargetsCore(
      {
        runId: "run",
        reviewTaskId: "wayflow-t",
        targets: [t("a", "1")],
        acceptResolvedGate: true,
      },
      ports({
        readGatePinnedTargets: async () => ({ status: "resolved", targets: [t("a", "1")] }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.prepared.map((p) => p.target)).toEqual([t("a", "1")]);
  });

  it("the history reading still substitutes NOTHING — the decided set is the gate's", async () => {
    const r = await prepareReviewTargetsCore(
      {
        runId: "run",
        reviewTaskId: "wayflow-t",
        targets: [t("a", "1"), t("c", "9")],
        acceptResolvedGate: true,
      },
      ports({
        readGatePinnedTargets: async () => ({ status: "resolved", targets: [t("a", "1")] }),
      }),
    );
    expect(r).toEqual({
      ok: false,
      error: { kind: "target-substitution", substituted: [t("c", "9")] },
    });
  });

  it("an ABSENT gate is closed to the history reading too", async () => {
    const r = await prepareReviewTargetsCore(
      {
        runId: "run",
        reviewTaskId: "wayflow-t",
        targets: [t("a", "1")],
        acceptResolvedGate: true,
      },
      ports({ readGatePinnedTargets: async () => ({ status: "not-found" }) }),
    );
    expect(r).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
  });
});

describe("prepareReviewTargetsCore — NO client target substitution", () => {
  it("a target the gate never pinned is a HARD rejection (not a degrade)", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1"), t("c", "9")] },
      ports(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("target-substitution");
    if (r.error.kind !== "target-substitution") throw new Error("unreachable");
    expect(r.error.substituted).toEqual([t("c", "9")]);
  });

  it("a same-artifact different-revision target is substitution (revision is pinned)", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "999")] },
      ports(),
    );
    expect(r.ok).toBe(false);
  });

  it("invalid caller targets → invalid-targets", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [{ artifactId: "a" }] },
      ports(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("invalid-targets");
  });
});

describe("prepareReviewTargetsCore — per-target never-blank floors (props null, never bytes)", () => {
  it("unknown/tombstoned artifact → floor(unknown-or-tombstoned), props null", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ readArtifact: () => ({ kind: "not-found" }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].props).toBeNull();
    expect(r.prepared[0].mount).toEqual({ kind: "floor", slot: "detail", packageName: null, reason: "unknown-or-tombstoned" });
  });

  it("read-denied artifact → floor(read-denied), props null", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ readArtifact: () => ({ kind: "denied" }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].mount).toMatchObject({ kind: "floor", reason: "read-denied" });
    expect(r.prepared[0].props).toBeNull();
  });

  it("non-member revision → floor(revision-not-member), props null", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ revisionMember: () => null }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].mount).toMatchObject({ kind: "floor", reason: "revision-not-member" });
    expect(r.prepared[0].props).toBeNull();
  });

  it("runtime-installed-but-unbuilt claimant → floor(requires-rebuild), props PRESENT (generic renders from them)", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ resolveMount: () => ({ kind: "floor", packageName: "@x/ext", reason: "requires-rebuild" }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].mount).toMatchObject({ kind: "floor", reason: "requires-rebuild" });
    expect(r.prepared[0].props).not.toBeNull();
  });
});

describe("prepareReviewTargetsCore — host-resolved loadable mounts (renderer from TYPE)", () => {
  it("build-map claimant → build-map mount + pinned props", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].mount).toEqual({ kind: "build-map", slot: "detail", packageName: "@x/ext", generatedKey: "@x/ext::detail" });
    expect(r.prepared[0].props).not.toBeNull();
  });

  it("runtime claimant → runtime mount carrying the HOST-produced serialized descriptor", async () => {
    const desc = descriptor();
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ resolveMount: () => ({ kind: "runtime", packageName: "@x/ext", descriptor: desc }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared[0].mount).toEqual({ kind: "runtime", slot: "detail", packageName: "@x/ext", descriptor: desc });
  });

  it("prepares each pinned target the caller asked for (subset allowed)", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1"), t("b", "2")] },
      ports(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.prepared.map((p) => p.target)).toEqual([t("a", "1"), t("b", "2")]);
  });
});

/**
 * THE CONTENT CHANNEL REACHES THE REVIEW CARD (enabler 0.3 wired for this
 * consumer, enabler 0.20).
 *
 * The card used to hand every display an ABSENT content projection with a note
 * that this consumer was "not wired yet". A markdown display handed an absent
 * projection draws its named floor — "no markdown is available to show for the
 * revision being viewed" — with no document and no tabs, which is exactly what a
 * reviewer saw on a revision whose text was sitting in the store all along.
 *
 * Reading the pinned revision is a SERVER read, so the props builder is
 * asynchronous by contract (the same shape enabler 0.3 gives the artifact page).
 * The core awaits it; that is what this pins, over a port that answers late.
 */
describe("prepareReviewTargetsCore — the props builder may read the pinned revision", () => {
  it("AWAITS an asynchronous props builder and carries what it resolved", async () => {
    const built = {
      ...fakeProps(),
      content: {
        kind: "text" as const,
        channelVersion: 1,
        representationRevisionId: "1",
        text: "# The pinned draft\n",
        encoding: "utf-8" as const,
        byteLength: 19,
        projectedByteLength: 19,
        cap: 262144,
        truncated: false,
      },
    };
    const buildProps = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return built;
    });

    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ buildProps }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildProps).toHaveBeenCalledTimes(1);
    // The props must be the RESOLVED value, never the pending promise.
    expect(r.prepared[0].props).toBe(built);
    expect(r.prepared[0].props?.content).toMatchObject({
      kind: "text",
      text: "# The pinned draft\n",
      representationRevisionId: "1",
    });
  });

  it("still accepts a SYNCHRONOUS props builder — the port takes either", async () => {
    const built = fakeProps();
    const r = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")] },
      ports({ buildProps: () => built }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prepared[0].props).toBe(built);
  });
});

// #3978: real preparation forwards only the authenticated canonical witness.
describe("3978 authenticated pinned decision projection", () => {
  const decidedAt = "2026-10-07T09:35:30.000Z";
  const decision = { gateId: "gate-1", orgId: "org-1", runId: "run", reviewTaskId: "wayflow-t", fingerprint: "a".repeat(64), disposition: "approve" as const, decidedAt };
  const input = { runId: "run", reviewTaskId: "wayflow-t", targets: [t("a", "1")], acceptResolvedGate: true };
  function fixture(over: Record<string, unknown> = {}, version = 5, orgId: string | null = "org-1") {
    const buildProps = vi.fn((value: Parameters<PrepareReviewPorts["buildProps"]>[0]) => ({ ...fakeProps(), propsApiVersion: value.propsApiVersion }));
    const bound = ports({
      verifyRunAccess: async () => ({ ok: true, ...(orgId === null ? {} : { orgId }) }),
      readGatePinnedTargets: async () => ({ status: "resolved", targets: [t("a", "1")], decision: { ...decision, ...over } }),
      resolveMount: () => ({ kind: "build-map", packageName: "@x/ext", generatedKey: "@x/ext::detail", propsApiVersion: version }),
      buildProps,
    });
    return { bound, buildProps };
  }
  it("passes the exact authenticated decision to the pinned member's v5 builder", async () => {
    const { bound, buildProps } = fixture();
    expect((await prepareReviewTargetsCore(input, bound)).ok).toBe(true);
    expect(buildProps.mock.calls[0][0]).toMatchObject({ representationRevisionId: "1", review: { reading: "continued", openLive: null, decidedAt } });
  });
  it.each([1, 2, 3, 4])("keeps negotiated v%s preparation builder input byte/key equal to the legacy path", async (version) => {
    const { bound, buildProps } = fixture({}, version);
    await prepareReviewTargetsCore(input, bound);
    const legacy = fixture({}, version);
    legacy.bound.readGatePinnedTargets = async () => ({ status: "resolved", targets: [t("a", "1")] });
    await prepareReviewTargetsCore(input, legacy.bound);
    expect(buildProps.mock.calls[0][0]).toEqual(legacy.buildProps.mock.calls[0][0]);
    expect(buildProps.mock.calls[0][0]).not.toHaveProperty("review");
  });
  it.each([
    { orgId: "foreign-org" }, { runId: "foreign-run" }, { reviewTaskId: "foreign-task" },
    { gateId: "" }, { fingerprint: "" }, { fingerprint: "malformed" },
    { disposition: "reject" }, { disposition: "comment" }, { decidedAt: "" },
    { decidedAt: "2026-02-30T00:00:00.000Z" },
  ])("suppresses facts from a mismatched or invalid canonical witness %j", async (over) => {
    const { bound, buildProps } = fixture(over);
    expect((await prepareReviewTargetsCore(input, bound)).ok).toBe(true);
    expect(buildProps.mock.calls[0][0]).not.toHaveProperty("review");
  });
  it("does not substitute missing run authority or caller/model facts", async () => {
    const { bound, buildProps } = fixture({}, 5, null);
    await prepareReviewTargetsCore({ ...input, review: { decidedAt } } as typeof input, bound);
    expect(buildProps.mock.calls[0][0]).not.toHaveProperty("review");
  });
  it("denies before gate/artifact reads when the actual viewer cannot read the run", async () => {
    const { bound, buildProps } = fixture();
    const gateRead = vi.fn(bound.readGatePinnedTargets);
    bound.readGatePinnedTargets = gateRead;
    bound.verifyRunAccess = async () => ({ ok: false, status: 403 });
    expect(await prepareReviewTargetsCore(input, bound)).toEqual({ ok: false, error: { kind: "run-access-denied", status: 403 } });
    expect(gateRead).not.toHaveBeenCalled(); expect(buildProps).not.toHaveBeenCalled();
  });
  it("never upgrades a pending row, missing witness or substituted revision into settled facts", async () => {
    const { bound, buildProps } = fixture();
    bound.readGatePinnedTargets = async () => ({ status: "pending", targets: [t("a", "1")] });
    await prepareReviewTargetsCore(input, bound);
    expect(buildProps.mock.calls[0][0]).not.toHaveProperty("review");
    bound.readGatePinnedTargets = async () => ({ status: "resolved", targets: [t("a", "1")] });
    buildProps.mockClear(); await prepareReviewTargetsCore(input, bound);
    expect(buildProps.mock.calls[0][0]).not.toHaveProperty("review");
    buildProps.mockClear();
    expect(await prepareReviewTargetsCore({ ...input, targets: [t("a", "later-revision")] }, bound)).toMatchObject({ ok: false, error: { kind: "target-substitution" } });
    expect(buildProps).not.toHaveBeenCalled();
  });
});

// Exercise the actual artifact-side binder and snapshot builder, not a mock builder.
describe("3978 real artifact binder decision forwarding", () => {
  it("forwards the v5 decision through the real pinned builder and preserves legacy absence", async () => {
    const { bindArtifactReviewPorts } = await import("@/app/artifacts/[id]/review-target-prepare");
    const { absentArtifactContent } = await import("../artifact-renderer-props");
    const bind = bindArtifactReviewPorts({ orgId: "org-1", actor: {} as Parameters<typeof bindArtifactReviewPorts>[0]["actor"],
      buildContent: async (input) => absentArtifactContent(input.representationRevisionId) });
    const artifact = { ...fakeArtifact("a"), ...fakeProps().artifact, artifactId: "a" };
    const base = { artifact, representationRevisionId: "1", mime: "application/json", member: { mime: "application/json" } };
    const review = { reading: "continued" as const, openLive: null, decidedAt: "2026-10-07T09:35:30.000Z" };
    const actual = await bind.buildProps({ ...base, propsApiVersion: 5, review });
    expect(actual.review).toEqual(review);
    expect(actual.representation?.revisionId).toBe("1");
    for (const propsApiVersion of [1, 2, 3, 4]) {
      const before = await bind.buildProps({ ...base, propsApiVersion });
      expect(await bind.buildProps({ ...base, propsApiVersion, review })).toEqual(before);
      expect(before).not.toHaveProperty("review");
    }
  });
});

describe("3978 real reviewing-actor port binding", () => {
  it("passes the same viewing principal and trusted org into the canonical readers", async () => {
    const store = await import("@cinatra-ai/agents/artifact-review-gate-store");
    const { bindReviewRunGatePorts } = await import("@/app/artifacts/[id]/review-gate-ports");
    const ctx = { actor: { actorType: "human" as const, userId: "viewer-1", source: "route" as const }, orgId: "org-1" };
    const access = vi.spyOn(store, "enforceReviewRunAccess").mockResolvedValue({ ok: true, orgId: "org-1" });
    const read = vi.spyOn(store, "readGatePinnedTargets").mockResolvedValue({ status: "not-found" });
    try {
      const bound = bindReviewRunGatePorts(ctx);
      expect(await bound.verifyRunAccess("run")).toEqual({ ok: true, orgId: "org-1" });
      expect(access).toHaveBeenCalledWith("run", ctx.actor, "read", undefined, { includeOrgId: true });
      await bound.readGatePinnedTargets("run", "task");
      expect(read).toHaveBeenCalledWith("run", "task", { decisionFactsForOrgId: "org-1" });
      access.mockResolvedValue({ ok: true, orgId: "foreign-org" });
      expect(await bound.verifyRunAccess("run")).toEqual({ ok: false, status: 403 });
      access.mockResolvedValue({ ok: false, status: 404 });
      expect(await bound.verifyRunAccess("run")).toEqual({ ok: false, status: 404 });
    } finally { access.mockRestore(); read.mockRestore(); }
  });
});

describe("3978 real build-map version window", () => {
  it("reads the actual pinned email v4 declaration instead of the new host ceiling", async () => {
    const { classifyArtifactDisplayMount } = await import("@/app/artifacts/[id]/renderer-resolution");
    const { GENERATED_ARTIFACT_RENDERERS } = await import("@/lib/generated/artifact-renderers");
    expect(GENERATED_ARTIFACT_RENDERERS["@cinatra-ai/email-artifacts::detail"].propsApiVersion).toBe(4);
    const mount = await classifyArtifactDisplayMount({ dispatch: "semantic", packageName: "@cinatra-ai/email-artifacts",
      generatedKey: "@cinatra-ai/email-artifacts::detail", propsApiVersion: 5 });
    expect(mount).toMatchObject({ kind: "build-map", propsApiVersion: 4 });
  });
  it("preserves declarations across the whole supported window and floors malformed/too-new metadata", async () => {
    const { classifyArtifactDisplayMount } = await import("@/app/artifacts/[id]/renderer-resolution");
    const { GENERATED_ARTIFACT_RENDERERS } = await import("@/lib/generated/artifact-renderers");
    const key = "@cinatra-ai/email-artifacts::detail";
    const original = GENERATED_ARTIFACT_RENDERERS[key];
    try {
      for (const propsApiVersion of [1, 2, 3, 4, 5]) {
        GENERATED_ARTIFACT_RENDERERS[key] = { ...original, propsApiVersion };
        expect(await classifyArtifactDisplayMount({ dispatch: "semantic", packageName: original.packageName, generatedKey: key, propsApiVersion: 5 }))
          .toMatchObject({ kind: "build-map", propsApiVersion });
      }
      for (const propsApiVersion of [0, -1, 1.5, NaN, 6]) {
        GENERATED_ARTIFACT_RENDERERS[key] = { ...original, propsApiVersion };
        expect(await classifyArtifactDisplayMount({ dispatch: "semantic", packageName: original.packageName, generatedKey: key, propsApiVersion: 5 }))
          .toMatchObject({ kind: "floor", reason: "requires-rebuild" });
      }
    } finally { GENERATED_ARTIFACT_RENDERERS[key] = original; }
  });
});
