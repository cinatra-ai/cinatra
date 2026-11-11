// The object projection of a page capture's recorded facts (cinatra#4223): what
// a display receives for a file revision the content channel has no class for.
// The facts come from the revision's own server record, never from the row's
// object data. The real-database proof through both production builders is in
// page-capture-display-4223.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

// The bridge doubles: by default no database is reachable.
const bridge = vi.hoisted(() => ({ connection: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => bridge.connection(),
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => bridge.sync(...args),
}));

import { projectRecordedPageCaptureFacts } from "@/lib/artifacts/page-capture-facts-record";

const TYPE = "@cinatra-ai/fixture-artifact:capture";
const FACTS = {
  capturedUrl: "https://shop.example/checkout?step=2",
  viewport: { width: 1280, height: 900 },
  capturedAt: "2026-11-03T07:00:00.000Z",
};
const IDS = { orgId: "org-1", artifactId: "art-1", representationRevisionId: "rev-1" };

const unsupported: ArtifactContentProjection = {
  kind: "none",
  channelVersion: 1,
  representationRevisionId: "rev-1",
  reason: "unsupported-form",
};

function recordRows(detail: unknown) {
  return [{ detail }];
}

beforeEach(() => {
  bridge.connection.mockReset();
  bridge.sync.mockReset();
  bridge.connection.mockImplementation(() => {
    throw new Error("no database in this suite");
  });
  bridge.sync.mockImplementation(() => {
    throw new Error("no database in this suite");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectRecordedPageCaptureFacts (cinatra#4223)", () => {
  it("hands the display the revision's recorded facts as the object snapshot of that revision", () => {
    const runQuery = vi.fn(() => recordRows({ v: 1, objectType: TYPE, ...FACTS }));
    const content = projectRecordedPageCaptureFacts(
      { ...IDS, objectType: TYPE, fileProjection: unsupported },
      { runQuery },
    );

    expect(content).toMatchObject({
      kind: "object",
      source: "snapshot",
      objectType: TYPE,
      representationRevisionId: "rev-1",
    });
    if (content.kind !== "object") return;
    expect(content.data).toEqual(FACTS);
    expect(Object.keys(content.data as object).sort()).toEqual(["capturedAt", "capturedUrl", "viewport"]);
    // One read, of this organisation, artifact and revision.
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect((runQuery.mock.calls[0] as unknown as [{ values: unknown[] }])[0].values).toEqual([
      "org-1",
      "art-1",
      "rev-1",
      "page_capture_facts",
    ]);
  });

  it("reads the configured store by default", () => {
    bridge.connection.mockReturnValue("postgres://fixture-user:fixture-pass@localhost:5432/fixture");
    bridge.sync.mockReturnValue([{ rows: recordRows({ v: 1, objectType: TYPE, ...FACTS }), rowCount: 1 }]);

    const content = projectRecordedPageCaptureFacts({ ...IDS, objectType: TYPE, fileProjection: unsupported });

    expect(content).toMatchObject({ kind: "object", source: "snapshot", objectType: TYPE, data: FACTS });
    expect(bridge.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps the channel's own answer when the revision has no record, a record of another type, or an unreadable one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Array<() => unknown[]> = [
      () => [],
      () => recordRows({ v: 1, objectType: "@cinatra-ai/fixture-other-artifact:capture", ...FACTS }),
      () => recordRows({ v: 1, objectType: TYPE, ...FACTS, viewport: { width: 0, height: 900 } }),
      () => [...recordRows({ v: 1, objectType: TYPE, ...FACTS }), ...recordRows({ v: 1, objectType: TYPE, ...FACTS })],
      () => {
        throw new Error("read failed");
      },
    ];
    for (const runQuery of answers) {
      expect(
        projectRecordedPageCaptureFacts({ ...IDS, objectType: TYPE, fileProjection: unsupported }, { runQuery }),
      ).toBe(unsupported);
    }
  });

  it("passes every other channel answer through unchanged and reads no record for it", () => {
    const runQuery = vi.fn(() => recordRows({ v: 1, objectType: TYPE, ...FACTS }));
    const others: ArtifactContentProjection[] = [
      { kind: "none", channelVersion: 1, representationRevisionId: "rev-1", reason: "absent" },
      { kind: "none", channelVersion: 1, representationRevisionId: "rev-1", reason: "over-cap" },
      {
        kind: "text",
        channelVersion: 1,
        representationRevisionId: "rev-1",
        text: "hello",
        encoding: "utf-8",
        byteLength: 5,
        projectedByteLength: 5,
        cap: 1024,
        truncated: false,
      },
    ];
    for (const fileProjection of others) {
      expect(projectRecordedPageCaptureFacts({ ...IDS, objectType: TYPE, fileProjection }, { runQuery })).toBe(
        fileProjection,
      );
    }
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("reads no record and keeps the channel's answer when no revision is named", () => {
    const runQuery = vi.fn(() => recordRows({ v: 1, objectType: TYPE, ...FACTS }));
    const none: ArtifactContentProjection = { ...unsupported, representationRevisionId: null };
    expect(
      projectRecordedPageCaptureFacts(
        { ...IDS, representationRevisionId: null, objectType: TYPE, fileProjection: none },
        { runQuery },
      ),
    ).toBe(none);
    expect(runQuery).not.toHaveBeenCalled();
  });
});
