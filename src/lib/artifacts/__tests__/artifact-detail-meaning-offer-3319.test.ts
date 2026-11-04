/**
 * cinatra#3319 — the detail read answers the type picker's derived meaning from
 * its ONE presentation reading (spec `specs/app-artifacts.html` §VI.1).
 *
 * The picker's candidate list authorizes the row through `readArtifactForDetail`,
 * which already resolves the row's presentation identity — a synchronous read of
 * the sync bridge. Asked with `withMeaningOffer`, the read runs its gates and
 * DEFERS that one reading to `readPresentation()` (revision 4, Codex spec review
 * 3, finding 3: the action warms the registries between the gates and the
 * reading). The deferred call must answer the meaning offer from that SAME
 * reading: never a second blocking read, and never an offer that disagrees with
 * the presentation it returns. Without the flag, every other caller keeps its
 * road exactly as before. The meaning WRITE read is not changed.
 *
 * Harness as in artifact-object-authz-1428.test.ts: the object store and both
 * identity resolvers are mocked (no database); the REAL service gates run.
 *
 *   pnpm exec vitest run src/lib/artifacts/__tests__/artifact-detail-meaning-offer-3319.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getObjectById = vi.fn();
vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: vi.fn(),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({ tombstoneArtifact: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
  listArtifactIdsForExtension: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
}));

const IDEA = "@cinatra-ai/blog-idea-artifact";
const POST = "@cinatra-ai/blog-post-artifact";
// The SINGLE reading's answer: the row presents IDEA (tier 2), POST stays a chip.
const READING = {
  presentation: {
    identity: { kind: "extension", extension: IDEA },
    tier: "matcher",
    suggestions: [POST],
  },
  offer: { preselect: IDEA, suggestions: [{ extension: POST, confidence: 0.55 }] },
};
const host = vi.hoisted(() => ({
  resolveArtifactPresentationIdentity: vi.fn(),
  resolveArtifactPresentationIdentities: vi.fn(),
  resolveArtifactPresentationReading: vi.fn(),
}));
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentities: (...a: unknown[]) =>
    host.resolveArtifactPresentationIdentities(...a),
  resolveArtifactPresentationIdentity: (...a: unknown[]) =>
    host.resolveArtifactPresentationIdentity(...a),
  resolveArtifactPresentationReading: (...a: unknown[]) =>
    host.resolveArtifactPresentationReading(...a),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));

import type { ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-A";
const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    type: ARTIFACT_TYPE,
    data: { artifactType: "file", title: "T", mime: "x/y", size: 1, originKind: "upload" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orgId: ORG,
    ownerLevel: "organization",
    ownerId: ORG,
    visibility: "org",
    projectId: null,
    ...over,
  };
}

function member(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: ORG,
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "test",
    ...over,
  } as ActorContext;
}

type Read = (input: {
  artifactId: string;
  orgId: string | null;
  actor?: ActorContext;
  withMeaningOffer?: boolean;
}) => {
  kind: string;
  artifact?: { presentationIdentity: unknown; presentationSuggestions: unknown };
  readPresentation?: () => {
    artifact: { presentationIdentity: unknown; presentationSuggestions: unknown };
    meaningOffer: unknown;
  };
};

async function detail(): Promise<Read> {
  const mod = (await import("../artifact-service")) as unknown as { readArtifactForDetail: Read };
  return mod.readArtifactForDetail;
}

async function meaningWrite(): Promise<Read> {
  const mod = (await import("../artifact-service")) as unknown as {
    readArtifactForMeaningWrite: Read;
  };
  return mod.readArtifactForMeaningWrite;
}
/** A row the member owns, so the write gate (`object.update`) passes. */
const OWN_ROW = { ownerLevel: "user", ownerId: "u1", visibility: "private" };

function hostReads(): number {
  return (
    host.resolveArtifactPresentationIdentity.mock.calls.length +
    host.resolveArtifactPresentationIdentities.mock.calls.length +
    host.resolveArtifactPresentationReading.mock.calls.length
  );
}

beforeEach(() => {
  getObjectById.mockReset();
  host.resolveArtifactPresentationIdentity.mockReset().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    tier: "claim-backed",
    suggestions: [],
  });
  host.resolveArtifactPresentationIdentities.mockReset().mockReturnValue(new Map());
  host.resolveArtifactPresentationReading.mockReset().mockReturnValue(READING);
});
afterEach(() => vi.resetModules());

describe("cinatra#3319 — readArtifactForDetail answers the meaning offer from ONE presentation reading", () => {
  it("S1: withMeaningOffer defers the reading past the gates; the deferred call makes exactly one presentation read, and the offer and the presentation come from it", async () => {
    const read = await detail();
    getObjectById.mockReturnValue(row());
    const res = read({ artifactId: "a1", orgId: ORG, actor: member(), withMeaningOffer: true });
    expect(res.kind).toBe("ok");
    // Nothing is read before the caller asks: its registry warm runs between
    // the gates and the reading (review 3, finding 3).
    expect(hostReads()).toBe(0);
    expect(typeof res.readPresentation).toBe("function");
    const answered = res.readPresentation!();
    // ONE read of the presentation host per request — a second (blocking) read
    // through any of its entries turns this red.
    expect(hostReads()).toBe(1);
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: "a1",
      baseType: ARTIFACT_TYPE,
    });
    // The detail's presentation and the offer are the same reading's.
    expect(answered.artifact.presentationIdentity).toEqual(READING.presentation.identity);
    expect(answered.artifact.presentationSuggestions).toEqual(READING.presentation.suggestions);
    expect(answered.meaningOffer).toEqual(READING.offer);
    // A repeated call is the same answer, never a second reading.
    expect(res.readPresentation!()).toBe(answered);
    expect(hostReads()).toBe(1);
  });

  // GUARDS — green at the base by design: the flag changes nothing for any
  // other caller, and never reads before the gates.
  it("S2: without the flag the road is unchanged — the singular resolver, once, and no offer", async () => {
    const read = await detail();
    getObjectById.mockReturnValue(row());
    const res = read({ artifactId: "a1", orgId: ORG, actor: member() });
    expect(res.kind).toBe("ok");
    expect(hostReads()).toBe(1);
    expect(host.resolveArtifactPresentationIdentity).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading).not.toHaveBeenCalled();
    expect("readPresentation" in res).toBe(false);
  });

  it("S3: an orgless read with the flag reads no presentation and answers no offer", async () => {
    const read = await detail();
    getObjectById.mockReturnValue(row());
    const res = read({ artifactId: "a1", orgId: null, actor: member(), withMeaningOffer: true });
    expect(res.kind).toBe("ok");
    expect(hostReads()).toBe(0);
    expect("readPresentation" in res).toBe(false);
  });

  it("S4: a refused row (not found, denied) reads no presentation even with the flag", async () => {
    const read = await detail();
    getObjectById.mockReturnValue(null);
    expect(read({ artifactId: "gone", orgId: ORG, actor: member(), withMeaningOffer: true })).toEqual({
      kind: "not-found",
    });
    getObjectById.mockReturnValue(row());
    const svc = member({
      principalType: "ServiceAccount",
      principalId: "svc-1",
      orgRole: undefined,
    } as Partial<ActorContext>);
    expect(read({ artifactId: "a1", orgId: ORG, actor: svc, withMeaningOffer: true })).toEqual({
      kind: "denied",
    });
    expect(hostReads()).toBe(0);
  });

  // Revision 4 (Codex spec review 3, findings 1 and 2): the confirmation gate is
  // the base's again, so the WRITE read answers no offer.
  it("S5: readArtifactForMeaningWrite is unchanged — the singular resolver, once, and no deferred reading (green at base)", async () => {
    const read = await meaningWrite();
    getObjectById.mockReturnValue(row(OWN_ROW));
    const res = read({ artifactId: "a1", orgId: ORG, actor: member(), withMeaningOffer: true });
    expect(res.kind).toBe("ok");
    expect(hostReads()).toBe(1);
    expect(host.resolveArtifactPresentationIdentity).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading).not.toHaveBeenCalled();
    expect("readPresentation" in res).toBe(false);
    expect("meaningOffer" in res).toBe(false);
  });
});
