/**
 * THE REVIEW BINDER CARRIES A PAGE CAPTURE'S RECORDED FACTS (cinatra#4223).
 *
 * A picture's file form has no content class, so the channel answers
 * `unsupported-form` and its bytes travel by the byte road. A page capture also
 * has three facts the display draws beneath it (where, at what viewport, when).
 * They are recorded with the revision, and the props the binder builds for that
 * pinned revision carry them as the object snapshot of THAT revision. The row's
 * live object data never reaches the card. The real-database proof is in
 * page-capture-display-4223.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const TYPE = "@cinatra-ai/fixture-artifact:capture";
const FACTS = {
  capturedUrl: "http://localhost:4223/about/",
  viewport: { width: 1280, height: 900 },
  capturedAt: "2026-10-17T16:30:00.000Z",
};

const resolveArtifactVersionForServe = vi.fn();
const resolveNonFileArtifactRevision = vi.fn();
const openByStorageKey = vi.fn();
const bridge = vi.hoisted(() => ({ sync: vi.fn() }));

vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: (input: unknown) => resolveArtifactVersionForServe(input),
  resolveNonFileArtifactRevision: (input: unknown) => resolveNonFileArtifactRevision(input),
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ openByStorageKey: (i: unknown) => openByStorageKey(i) }),
}));
// The facts record's store: the one query it makes is answered here.
vi.mock("@/lib/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostgresConnectionString: () => "postgres://fixture-user:fixture-pass@localhost:5432/fixture",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => bridge.sync(...args),
}));

const { bindArtifactReviewPorts } = await import("../review-target-prepare");

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

const artifact = {
  artifactId: "art-1",
  title: "The about page",
  objectType: TYPE,
  mime: "image/png",
  size: 68,
  createdAt: "2026-10-17T16:30:00.000Z",
  updatedAt: "2026-10-17T16:30:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/fixture-artifact" },
  presentationIdentity: { kind: "extension", extension: "@cinatra-ai/fixture-artifact" },
} as unknown as ArtifactSummary;

async function cardProps() {
  const ports = bindArtifactReviewPorts({ orgId: "org-4223", actor });
  return ports.buildProps({
    artifact,
    representationRevisionId: "rev-1",
    mime: "image/png",
    propsApiVersion: 2,
    member: { mime: "image/png", form: "file" },
  });
}

beforeEach(() => {
  resolveArtifactVersionForServe.mockReset();
  resolveNonFileArtifactRevision.mockReset();
  openByStorageKey.mockReset();
  bridge.sync.mockReset();
});

describe("the review binder hands a pinned page capture's recorded facts to its display (cinatra#4223)", () => {
  it("carries the facts recorded with the pinned revision as that revision's object snapshot", async () => {
    bridge.sync.mockReturnValue([{ rows: [{ detail: { v: 1, objectType: TYPE, ...FACTS } }], rowCount: 1 }]);

    const props = await cardProps();

    expect(props.content).toMatchObject({
      kind: "object",
      source: "snapshot",
      objectType: TYPE,
      representationRevisionId: "rev-1",
      data: FACTS,
    });
    // The record read was this organisation's, this artifact's and the PINNED revision's.
    expect(bridge.sync).toHaveBeenCalledTimes(1);
    const [{ queries }] = bridge.sync.mock.calls[0] as [{ queries: Array<{ values: unknown[] }> }];
    expect(queries[0]!.values).toEqual(["org-4223", "art-1", "rev-1", "page_capture_facts"]);
    // The picture's bytes still travel by the byte road, never through the channel.
    expect(openByStorageKey).not.toHaveBeenCalled();
    expect(props.bytes).toMatchObject({ road: "session" });
  });

  it("keeps the channel's unsupported-form answer for a picture whose revision has no facts record", async () => {
    bridge.sync.mockReturnValue([{ rows: [], rowCount: 0 }]);

    const props = await cardProps();

    expect(props.content).toEqual({
      kind: "none",
      channelVersion: 1,
      representationRevisionId: "rev-1",
      reason: "unsupported-form",
    });
  });

  it("keeps the channel's answer when the record cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bridge.sync.mockImplementation(() => {
      throw new Error("read failed");
    });

    const props = await cardProps();

    expect(props.content).toMatchObject({ kind: "none", reason: "unsupported-form" });
  });
});
