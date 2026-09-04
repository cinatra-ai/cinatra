/**
 * THE REVIEW TARGET'S SUBSTANCE READ CARRIES ITS OWN BOUND (cinatra#3080, PR #3100,
 * forward merge 2026-09-04).
 *
 * Two properties arrived on the default branch while this branch was in proof
 * rounds, and the forward must not drop either of them:
 *
 *   THE READING'S BOUND. A LIVE review must not resolve a tombstoned-but-pinned
 *   revision, while the gate-authorized SETTLED reading (enabler 0.9) may — it is
 *   bounded instead by the frozen set the gate itself pinned. Only the caller
 *   knows which reading it is on, so the member's `historical` flag is what
 *   decides, and a settled card that loses it draws a floor over work that is
 *   really there.
 *
 *   THE NON-FILE FALLBACK. The membership answer usually CARRIES the pinned
 *   configuration record and its digest, and the read takes that rather than
 *   resolving the same row twice. When it carries nothing, resolving the row is
 *   still the honest answer — a caller that holds no record gets a projection,
 *   not an absence.
 *
 * Run:
 *   npx vitest run "src/app/artifacts/[id]/__tests__/review-target-substance-bound.test.ts"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveVersion = vi.fn();
const resolveNonFile = vi.fn();

vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveArtifactVersionForServe: (input: unknown) => resolveVersion(input),
  resolveNonFileArtifactRevision: (input: unknown) => resolveNonFile(input),
}));

import { reviewTargetSubstancePorts } from "../review-target-prepare";

const ARGS = {
  orgId: "org_1",
  artifactId: "art_1",
  representationRevisionId: "rev_4c21aa",
};

beforeEach(() => {
  resolveVersion.mockReset();
  resolveNonFile.mockReset();
});

describe("the review target's substance read", () => {
  it("reads a LIVE target under the live bound", async () => {
    resolveVersion.mockReturnValue(null);
    await reviewTargetSubstancePorts({ mime: "text/markdown", form: "file" }).readPinnedSubstance({
      ...ARGS,
      contentClass: "text",
    });
    expect(resolveVersion).toHaveBeenCalledWith(expect.objectContaining({ liveOnly: true }));
  });

  it("reads a SETTLED target under the gate's frozen set, not the live bound", async () => {
    resolveVersion.mockReturnValue(null);
    await reviewTargetSubstancePorts({
      mime: "text/markdown",
      form: "file",
      historical: true,
    }).readPinnedSubstance({ ...ARGS, contentClass: "text" });
    expect(resolveVersion).toHaveBeenCalledWith(expect.objectContaining({ liveOnly: false }));
  });

  it("RESOLVES the pinned configuration when the member carries none", async () => {
    resolveNonFile.mockReturnValue({
      configuration: { portlets: [] },
      configurationDigest: "sha256:abc",
    });
    const substance = await reviewTargetSubstancePorts({
      mime: "application/vnd.cinatra.dashboard+json",
      form: "dashboard",
    }).readPinnedSubstance({ ...ARGS, contentClass: "configuration" });
    expect(substance).toMatchObject({ class: "configuration", digest: "sha256:abc" });
    expect(resolveNonFile).toHaveBeenCalledWith(expect.objectContaining({ liveOnly: true }));
  });

  it("prefers the record the membership answer already CARRIED", async () => {
    const substance = await reviewTargetSubstancePorts({
      mime: "application/vnd.cinatra.dashboard+json",
      form: "dashboard",
      configuration: { portlets: [1] },
      configurationDigest: "sha256:carried",
    }).readPinnedSubstance({ ...ARGS, contentClass: "configuration" });
    expect(substance).toMatchObject({ class: "configuration", digest: "sha256:carried" });
    expect(resolveNonFile).not.toHaveBeenCalled();
  });
});
