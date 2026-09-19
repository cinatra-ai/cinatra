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

// ---------------------------------------------------------------------------
// CONCURRENT PREPARATION (cinatra#3334). The targets of one gate are prepared
// with a bounded fan-out instead of one after another: a gate over several
// targets used to spend the whole of the card's load bound inside this loop
// before the first target body could stream.
//
// The three properties the surface above depends on are pinned here: the CAP
// (a gate never opens more than four target preparations at once), the ORDER
// (the result is the caller's order, never the completion order), and the
// per-target DEGRADE ISOLATION (one target's floor is still that target's
// floor, and it no longer holds the others behind it).
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every microtask AND every already-resolved continuation run. */
async function settleTicks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("prepareReviewTargetsCore — concurrent, order-preserving, degrade-safe preparation (cinatra#3334)", () => {
  it("prepares the targets concurrently with a fan-out cap of 4, and keeps the input order", async () => {
    const targets = Array.from({ length: 9 }, (_, i) => t(`a${i}`, `r${i}`));
    const gates = targets.map(() => deferred<void>());
    let inFlight = 0;
    let peak = 0;

    const running = prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets },
      ports({
        readGatePinnedTargets: async () => ({ status: "pending", targets }),
        readArtifact: async (id) => {
          const index = Number(id.slice(1));
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gates[index].promise;
          inFlight -= 1;
          return { kind: "ok", artifact: fakeArtifact(id) };
        },
      }),
    );

    // Nine targets, none of them finished: the cap — and only the cap — is in
    // flight. A serial loop reaches one.
    await settleTicks();
    expect(peak).toBe(4);
    expect(inFlight).toBe(4);

    // Released in REVERSE, so completion order is the opposite of input order:
    // the result must still be the caller's order.
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      gates[i].resolve();
      await settleTicks();
      expect(inFlight).toBeLessThanOrEqual(4);
    }

    const r = await running;
    expect(peak).toBe(4);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.prepared.map((p) => p.target.artifactId)).toEqual(
      targets.map((x) => x.artifactId),
    );
  });

  it("a typed degrade on one target still yields ITS fallback while the others resolve", async () => {
    const targets = [t("degraded", "r1"), t("b", "r2"), t("c", "r3")];
    const held = deferred<void>();
    const started: string[] = [];

    const running = prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets },
      ports({
        readGatePinnedTargets: async () => ({ status: "pending", targets }),
        readArtifact: async (id) => {
          started.push(id);
          if (id === "degraded") {
            await held.promise;
            return { kind: "not-found" };
          }
          return { kind: "ok", artifact: fakeArtifact(id) };
        },
      }),
    );

    // The degrading target is still in flight and the others are ALREADY
    // through their read — the whole point of the fan-out.
    await settleTicks();
    expect(started).toEqual(["degraded", "b", "c"]);

    held.resolve();
    const r = await running;
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.prepared.map((p) => p.target.artifactId)).toEqual(["degraded", "b", "c"]);
    // Its OWN typed degrade, unchanged by the fan-out …
    expect(r.prepared[0].props).toBeNull();
    expect(r.prepared[0].mount).toEqual({
      kind: "floor",
      slot: "detail",
      packageName: null,
      reason: "unknown-or-tombstoned",
    });
    // … and the siblings resolved normally rather than inheriting it.
    expect(r.prepared[1].mount.kind).toBe("build-map");
    expect(r.prepared[2].mount.kind).toBe("build-map");
  });

  it("an unexpected rejection keeps the documented port contract — never a fallback", async () => {
    const targets = [t("a", "r1"), t("b", "r2")];
    const r = prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets },
      ports({
        readGatePinnedTargets: async () => ({ status: "pending", targets }),
        buildProps: async () => {
          throw new Error("the binder threw");
        },
      }),
    );
    // The core deliberately does not catch: a throwing port is a defect in the
    // binder, not a silently floored card whose cause nobody sees.
    await expect(r).rejects.toThrow("the binder threw");
  });
});
