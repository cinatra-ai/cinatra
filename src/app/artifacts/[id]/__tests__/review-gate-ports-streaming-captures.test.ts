/**
 * cinatra#3334 (convergence) — the STREAMING surface's capture promises.
 *
 * Two things this proves that the streaming shape alone does not:
 *
 * 1. A TARGET'S PICTURE IS NEVER READ IN FRONT OF THE SHELL. The pinned capture
 *    read is synchronous against the store, and a callback chained onto an
 *    already-settled promise runs in a microtask BEFORE the caller awaiting the
 *    surface resumes — so composing the pairs eagerly would put every target's
 *    store read back on exactly the path the preflight was moved forward to
 *    free. Each pair is therefore read behind its own target's preparation,
 *    which is the same thing the panel that consumes it waits for anyway.
 *
 * 2. A REPAIR GATE WHOSE ROW CANNOT BE READ SHOWS NO PAIR, NEVER THE ORDINARY
 *    ONE. The ordinary pair is a different comparison (the live page against
 *    the proposal) than the one a repair gate is reviewed on (the reviewed
 *    revision against the repaired one), so falling back to it would draw the
 *    wrong two pictures under a reviewer's decision.
 *
 * The stores are mocked in the style of `review-gate-ports-repair-pair.test.ts`
 * (the gate store, the repair store and the capture store), so this proves the
 * port's own composition, not the stores.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readGatePinnedTargets: vi.fn(),
  readReviewGate: vi.fn(),
  readReviewGateState: vi.fn(),
  commitReviewDecision: vi.fn(),
  enforceReviewRunAccess: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

import { readReviewGate } from "@cinatra-ai/agents/artifact-review-gate-store";
import { readRepairBySuccessorGateId } from "@cinatra-ai/agents/lifecycle-repair-store";
import { readPinnedPreviewCaptures } from "@/lib/artifacts/cms-preview-capture-store";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { repairSuccessorReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { streamReviewTargets } from "../review-gate-ports";

const readGate = vi.mocked(readReviewGate);
const readRepair = vi.mocked(readRepairBySuccessorGateId);
const readCaptures = vi.mocked(readPinnedPreviewCaptures);

const ORG = "org-3334";
const RUN = "run-3334";
const ORDINARY_TASK = "setup-run-3334";
const REPAIR_TASK = repairSuccessorReviewTaskId("repair-1", 1);

function target(n: number): ArtifactReviewTarget {
  return { artifactId: `art-${n}`, representationRevisionId: `rev-${n}` };
}

function deferredTarget(): {
  prepared: Promise<PreparedReviewTarget>;
  resolve: () => void;
} {
  let settle!: (value: PreparedReviewTarget) => void;
  const prepared = new Promise<PreparedReviewTarget>((res) => {
    settle = res;
  });
  return { prepared, resolve: () => settle({} as PreparedReviewTarget) };
}

/** Every microtask the surface's own caller would have run by the time it is
 *  back on the page — generously more than one turn. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  readGate.mockReset();
  readRepair.mockReset();
  readCaptures.mockReset();
  readCaptures.mockReturnValue([]);
});

describe("cinatra#3334 — the streaming surface reads a picture behind its own target", () => {
  it("reads NO pinned capture before the caller awaiting the surface resumes", async () => {
    const a = deferredTarget();
    const b = deferredTarget();

    // Exactly the shape of the real call: the surface is composed inside an
    // async function and the caller resumes on its answer.
    const streams = await (async () =>
      streamReviewTargets(
        ORG,
        [
          { target: target(1), prepared: a.prepared },
          { target: target(2), prepared: b.prepared },
        ],
        // The ordinary gate's pairing — already settled, which is precisely the
        // case an eager composition would run in front of the caller.
        () => Promise.resolve({ kind: "ordinary" as const }),
      ))();

    await flush();
    expect(readCaptures).not.toHaveBeenCalled();
    expect(streams.map((s) => s.target.artifactId)).toEqual(["art-1", "art-2"]);

    // The first target arrives: ITS picture is read, and only its own.
    a.resolve();
    await streams[0].capturePair;
    expect(readCaptures).toHaveBeenCalledTimes(1);
    expect(readCaptures).toHaveBeenCalledWith({
      orgId: ORG,
      boundArtifactId: "art-1",
      boundSnapshotRevisionId: "rev-1",
    });

    b.resolve();
    await streams[1].capturePair;
    expect(readCaptures).toHaveBeenCalledTimes(2);
  });

  it("never reads a picture for a target whose preparation rejected", async () => {
    const prepared = Promise.reject(new Error("binder defect"));
    // The real caller's own handler; the rejection stays that caller's.
    void prepared.catch(() => {});

    const [stream] = streamReviewTargets(ORG, [{ target: target(3), prepared }], () =>
      Promise.resolve({ kind: "ordinary" as const }),
    );

    await expect(stream.capturePair).resolves.toBeNull();
    expect(readCaptures).not.toHaveBeenCalled();
  });
});

describe("cinatra#3334 — a repair gate that cannot be keyed shows NO pair", () => {
  function repairPairing(runId: string, reviewTaskId: string) {
    // The surface's own lazy, shared pairing, exercised through the port's real
    // gate read (mocked store) exactly as `loadReviewGateSurface` builds it.
    let pending: Promise<{ kind: "ordinary" } | { kind: "repair"; gateId: string } | { kind: "unresolved" }> | null =
      null;
    return () => {
      pending ??= reviewTaskId.startsWith("setup-")
        ? Promise.resolve({ kind: "ordinary" as const })
        : readGate(runId, reviewTaskId)
            .then((gate: { id?: string } | null) =>
              gate?.id ? ({ kind: "repair", gateId: gate.id } as const) : ({ kind: "unresolved" } as const),
            )
            .catch(() => ({ kind: "unresolved" }) as const);
      return pending;
    };
  }

  it("answers null — and never the live-versus-proposal read — when the gate row read throws", async () => {
    readGate.mockRejectedValue(new Error("gate store unavailable"));

    const [stream] = streamReviewTargets(
      ORG,
      [{ target: target(4), prepared: Promise.resolve({} as PreparedReviewTarget) }],
      repairPairing(RUN, REPAIR_TASK),
    );

    await expect(stream.capturePair).resolves.toBeNull();
    // THE POINT: the ordinary reader is not reached. A repair gate is reviewed
    // on reviewed-versus-repaired, so an unkeyable one shows nothing.
    expect(readCaptures).not.toHaveBeenCalled();
    expect(readRepair).not.toHaveBeenCalled();
  });

  it("answers null the same way when the gate row is simply absent", async () => {
    readGate.mockResolvedValue(null);

    const [stream] = streamReviewTargets(
      ORG,
      [{ target: target(5), prepared: Promise.resolve({} as PreparedReviewTarget) }],
      repairPairing(RUN, REPAIR_TASK),
    );

    await expect(stream.capturePair).resolves.toBeNull();
    expect(readCaptures).not.toHaveBeenCalled();
  });

  it("reads the ordinary pair once per target on an ordinary gate", async () => {
    const [one, two] = streamReviewTargets(
      ORG,
      [
        { target: target(6), prepared: Promise.resolve({} as PreparedReviewTarget) },
        { target: target(7), prepared: Promise.resolve({} as PreparedReviewTarget) },
      ],
      repairPairing(RUN, ORDINARY_TASK),
    );

    await Promise.all([one.capturePair, two.capturePair]);
    expect(readCaptures).toHaveBeenCalledTimes(2);
    expect(readGate).not.toHaveBeenCalled();
  });
});
