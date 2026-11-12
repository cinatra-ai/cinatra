/**
 * cinatra#3334 (convergence): the actual review loader answers at the end of
 * its preflight.
 *
 * These cases lived in `review-gate-ports-streaming-captures.test.ts`, which
 * left with the stored capture pair (cinatra#3862 leg 8). They test the loader,
 * not the pair, so they stay:
 *
 * - a pending and a resolved multi-target gate return their surface while every
 *   artifact read is still pending;
 * - a reader refused run access causes no target I/O;
 * - a substituted pinned set is blocked before any target I/O.
 *
 * No browser, database or timer timeout is the negative control: a loader that
 * awaits the whole set answers `returned === false` here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace only the artifact I/O adapter with controlled ports. The entry
// adapters forward to the REAL preparation cores, so the loader runs its actual
// preflight and fan-out.
const artifactIo = vi.hoisted(() => ({ readArtifact: vi.fn() }));
vi.mock("../review-target-prepare", async () => {
  const core = await import("@/lib/artifacts/artifact-review-preparation");
  const bind = () => ({
    readArtifact: artifactIo.readArtifact,
    revisionMember: vi.fn(),
    resolveMount: vi.fn(),
    buildProps: vi.fn(),
  });
  return {
    bindArtifactReviewPorts: bind,
    prepareArtifactReviewTargets: (args: { input: Parameters<typeof core.prepareReviewTargetsCore>[0]; runGatePorts: Pick<Parameters<typeof core.prepareReviewTargetsCore>[1], "verifyRunAccess" | "readGatePinnedTargets"> }) =>
      core.prepareReviewTargetsCore(args.input, { ...bind(), ...args.runGatePorts }),
    beginArtifactReviewTargets: (args: { input: Parameters<typeof core.prepareReviewTargetsCore>[0]; runGatePorts: Pick<Parameters<typeof core.prepareReviewTargetsCore>[1], "verifyRunAccess" | "readGatePinnedTargets"> }) =>
      core.beginReviewTargetsCore(args.input, { ...bind(), ...args.runGatePorts }),
  };
});

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readGatePinnedTargets: vi.fn(),
  readReviewGate: vi.fn(),
  readReviewGateState: vi.fn(),
  commitReviewDecision: vi.fn(),
  enforceReviewRunAccess: vi.fn(),
}));

import { readReviewGate, readReviewGateState, readGatePinnedTargets, enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import { loadReviewGateSurface, type ReviewActorContext } from "../review-gate-ports";

const ORG = "org-3334";
const RUN = "run-3334";
const ORDINARY_TASK = "setup-run-3334";

const actorCtx: ReviewActorContext = {
  actor: { actorType: "human", userId: "reviewer-3334", source: "route" },
  orgId: ORG,
};

function target(n: number): ArtifactReviewTarget {
  return { artifactId: `art-${n}`, representationRevisionId: `rev-${n}` };
}

/** Every microtask the surface's own caller would have run by the time it is
 *  back on the page; generously more than one turn. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactIo.readArtifact.mockReset();
});

describe("the actual loader releases its preflight while target I/O remains pending", () => {
  it.each(["pending", "resolved"] as const)("releases the %s multi-target surface before artifact reads finish", async (status) => {
    const pins = [target(1), target(2)];
    vi.mocked(enforceReviewRunAccess).mockResolvedValue({ ok: true, orgId: ORG });
    vi.mocked(readReviewGateState).mockResolvedValue(status === "pending" ? { status, targets: pins } : { status, fingerprint: "historical" });
    vi.mocked(readGatePinnedTargets).mockResolvedValue({ status, targets: pins });
    vi.mocked(readReviewGate).mockResolvedValue({ pinnedTargets: pins } as Awaited<ReturnType<typeof readReviewGate>>);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    artifactIo.readArtifact.mockImplementation(async () => {
      await held;
      return { kind: "not-found" };
    });
    let returned = false;
    const loading = loadReviewGateSurface({ runId: RUN, reviewTaskId: ORDINARY_TASK, actorCtx });
    void loading.then(() => { returned = true; });
    try {
      await flush();
      expect(returned).toBe(true);
      const surface = await loading;
      expect(surface.kind).toBe(status === "pending" ? "ready" : "settled");
      expect(surface.kind !== "blocked" && surface.kind !== "not-authorized" && surface.targets.map((entry) => entry.target)).toEqual(pins);
    } finally {
      release();
      await loading;
    }
  });

  it("run-access refusal performs no target I/O", async () => {
    vi.mocked(enforceReviewRunAccess).mockResolvedValue({ ok: false, status: 403 });
    expect(await loadReviewGateSurface({ runId: RUN, reviewTaskId: ORDINARY_TASK, actorCtx })).toEqual({ kind: "not-authorized" });
    expect(artifactIo.readArtifact).not.toHaveBeenCalled();
  });

  it("a substituted pinned set remains blocked before any target I/O", async () => {
    vi.mocked(enforceReviewRunAccess).mockResolvedValue({ ok: true, orgId: ORG });
    vi.mocked(readReviewGateState).mockResolvedValue({ status: "pending", targets: [target(1)] });
    vi.mocked(readGatePinnedTargets).mockResolvedValue({ status: "pending", targets: [target(2)] });
    expect(await loadReviewGateSurface({ runId: RUN, reviewTaskId: ORDINARY_TASK, actorCtx })).toEqual({ kind: "blocked", reason: "targets-mismatch" });
    expect(artifactIo.readArtifact).not.toHaveBeenCalled();
  });
});
